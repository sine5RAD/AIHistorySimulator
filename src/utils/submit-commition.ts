import type { AiSettings } from '@/composables/ai-settings'
import { aiSettingsStorageKey } from '@/composables/ai-settings'
import type { PreparedPrompt } from '@/utils/preloadPrompt'

export function readAiSettingsFromStorage(): AiSettings | null {
  try {
    const raw = window.localStorage.getItem(aiSettingsStorageKey)

    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<AiSettings>

    if (
      typeof parsed.provider === 'string' &&
      typeof parsed.api === 'string' &&
      typeof parsed.model === 'string'
    ) {
      return {
        provider: parsed.provider as AiSettings['provider'],
        api: parsed.api,
        model: parsed.model,
      }
    }

    return null
  } catch (e) {
    console.error('Failed to read AI settings from storage', e)
    return null
  }
}

/**
 * 将已准备好的提示词提交到模型提供商并返回模型回复文本（首选选择）。
 * 目前实现：OpenAI Chat Completions via REST fetch。
 */
export async function submitPreparedPrompt(prepared: PreparedPrompt): Promise<string | null> {
  // 先从本地存储读取用户的 AI 配置，便于在未显式传入 provider/model 时回退使用。
  const settings = readAiSettingsFromStorage()

  // provider 的优先级：调用方传入 > 本地存储 > 默认 OpenAI。
  const provider = prepared.provider ?? settings?.provider ?? 'OpenAI'
  // API Key 只从本地存储读取，因为 PreparedPrompt 通常只携带请求内容，不携带敏感凭据。
  const apiKey = settings?.api ?? ''
  // model 的优先级：调用方传入 > 本地存储 > 默认 gpt-3.5-turbo。
  const model = prepared.model ?? settings?.model ?? 'gpt-3.5-turbo'

  // 将模型返回结果统一提取成文本，避免不同 provider 的响应结构差异影响上层调用。
  const extractCompletionText = (data: unknown) => {
    // 非对象数据无法按统一结构解析，直接返回 null。
    if (!data || typeof data !== 'object') {
      return null
    }

    // 以宽松结构接收多种兼容接口返回值，便于处理 OpenAI / DeepSeek / 其他兼容实现。
    const response = data as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      output?: unknown
      result?: unknown
    }

    // 优先处理 OpenAI 风格的 choices 数组。
    if (Array.isArray(response.choices) && response.choices.length > 0) {
      // 收集所有 choice 中的文本片段，最后拼接为一个完整回复。
      const parts: string[] = []

      // 遍历每个 choice，兼容 message.content 与 text 两种常见字段。
      for (const choice of response.choices) {
        // 先读 message.content，若没有则回退到 text。
        const content = choice.message?.content ?? choice.text

        // 只收集字符串内容，避免把对象或其他非文本数据混入结果。
        if (typeof content === 'string') {
          parts.push(content)
        }
      }

      // 若至少提取到一个字符串片段，则按换行连接后返回。
      if (parts.length > 0) {
        return parts.join('\n')
      }
    }

    // 兼容某些接口直接返回 output 字段的情况。
    if (typeof response.output === 'string') return response.output
    // 兼容某些接口直接返回 result 字段的情况。
    if (typeof response.result === 'string') return response.result

    // 如果无法识别具体结构，则返回原始 JSON 字符串，至少保留调试信息。
    return JSON.stringify(data)
  }

  // 尝试通过 OpenAI 兼容 SDK 调用模型；baseURL 可用于切换到兼容服务商。
  const callOpenAiCompatibleSdk = async (baseURL?: string) => {
    // 动态导入 openai，避免在不需要时把它固化到首屏依赖中。
    const mod = await import('openai')

    // 兼容不同导出形式：有的环境是 default export，有的可能直接导出构造器。
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const modAny = mod as any
    const OpenAI = modAny?.default ?? modAny
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // 如果无法解析出 OpenAI 构造器，则说明当前运行环境不支持该 SDK 方式。
    if (!OpenAI) {
      return null
    }

    // 根据是否传入 baseURL 决定是否连接到兼容服务商。
    const client = baseURL ? new OpenAI({ baseURL, apiKey }) : new OpenAI({ apiKey })

    // 使用 Chat Completions 接口提交准备好的消息。
    const completion = await client.chat.completions.create({
      model,
      messages: prepared.messages,
      stream: false,
    })

    // 将 SDK 返回值统一转换为文本。
    return extractCompletionText(completion)
  }

  // OpenAI 分支：先尝试 SDK，再回退到 REST fetch。
  if (provider === 'OpenAI') {
    // 没有 API Key 时无法请求 OpenAI，直接返回 null 并输出错误。
    if (!apiKey) {
      console.error('No API key available for OpenAI')
      return null
    }

    // 先走 SDK，若环境或依赖不满足则回退到 fetch。
    try {
      return await callOpenAiCompatibleSdk()
    } catch (err) {
      // SDK 失败并不一定是致命错误，继续尝试 REST 方式。
      console.warn('OpenAI SDK call failed, falling back to REST fetch', err)
    }

    // REST 回退路径：直接调用 OpenAI Chat Completions HTTP 接口。
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: prepared.messages }),
      })

      // HTTP 状态不成功时，读取错误文本并记录日志后返回 null。
      if (!res.ok) {
        const text = await res.text()
        console.error('OpenAI API error', res.status, text)
        return null
      }

      // 成功时解析 JSON 并统一抽取文本内容。
      const data = await res.json()
      return extractCompletionText(data)
    } catch (err) {
      // 网络异常、跨域问题或响应解析错误都会走到这里。
      console.error('Failed to call OpenAI', err)
      return null
    }
  }

  // DeepSeek 分支：同样先尝试 OpenAI 兼容 SDK，再回退到官方 REST endpoint。
  if (provider === 'DeepSeek') {
    // DeepSeek REST Chat endpoint (assumed). Uses Bearer token in Authorization header.
    // 没有 API Key 时无法请求 DeepSeek，直接返回 null。
    if (!apiKey) {
      console.error('No API key available for DeepSeek')
      return null
    }

    // 优先尝试使用 OpenAI 官方 SDK（DeepSeek 兼容 OpenAI 格式）。
    try {
      // baseURL 指向 DeepSeek 的兼容入口。
      const sdkResult = await callOpenAiCompatibleSdk('https://api.deepseek.com')

      // 如果 SDK 成功返回了非空字符串，直接作为最终结果。
      if (typeof sdkResult === 'string' && sdkResult.length > 0) {
        return sdkResult
      }
    } catch (err) {
      // 如果无法导入 SDK（例如在浏览器中），则使用 fetch 回退。
      console.debug('OpenAI SDK not available, using fetch fallback', err)
    }

    // 官方文档推荐的 DeepSeek OpenAI 兼容 endpoint。
    const endpoint = 'https://api.deepseek.com/chat/completions'

    // REST 回退路径：直接请求 DeepSeek 兼容接口。
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: prepared.messages }),
      })

      // 非成功响应时读取服务端错误信息并返回 null。
      if (!res.ok) {
        const text = await res.text()
        console.error('DeepSeek API error', res.status, text)
        return null
      }

      // 正常返回时解析 JSON 并抽取统一文本结果。
      const data = await res.json()
      return extractCompletionText(data)
    } catch (e) {
      // 任何请求失败都在这里收敛，避免向上抛出未处理异常。
      console.error('Failed to call DeepSeek', e)
      return null
    }
  }

  // 对未实现的 provider 给出明确错误，避免静默失败。
  console.error('Provider not implemented:', provider)
  return null
}
