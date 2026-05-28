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
  const settings = readAiSettingsFromStorage()

  const provider = prepared.provider ?? settings?.provider ?? 'OpenAI'
  const apiKey = settings?.api ?? ''
  const model = prepared.model ?? settings?.model ?? 'gpt-3.5-turbo'

  const extractCompletionText = (data: unknown) => {
    if (!data || typeof data !== 'object') {
      return null
    }

    const response = data as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      output?: unknown
      result?: unknown
    }

    if (Array.isArray(response.choices) && response.choices.length > 0) {
      const parts: string[] = []

      for (const choice of response.choices) {
        const content = choice.message?.content ?? choice.text

        if (typeof content === 'string') {
          parts.push(content)
        }
      }

      if (parts.length > 0) {
        return parts.join('\n')
      }
    }

    if (typeof response.output === 'string') return response.output
    if (typeof response.result === 'string') return response.result

    return JSON.stringify(data)
  }

  const callOpenAiCompatibleSdk = async (baseURL?: string) => {
    const mod = await import('openai')

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const modAny = mod as any
    const OpenAI = modAny?.default ?? modAny
    /* eslint-enable @typescript-eslint/no-explicit-any */

    if (!OpenAI) {
      return null
    }

    const client = baseURL ? new OpenAI({ baseURL, apiKey }) : new OpenAI({ apiKey })

    const completion = await client.chat.completions.create({
      model,
      messages: prepared.messages,
      stream: false,
    })

    return extractCompletionText(completion)
  }

  if (provider === 'OpenAI') {
    if (!apiKey) {
      console.error('No API key available for OpenAI')
      return null
    }

    try {
      return await callOpenAiCompatibleSdk()
    } catch (err) {
      console.warn('OpenAI SDK call failed, falling back to REST fetch', err)
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: prepared.messages }),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error('OpenAI API error', res.status, text)
        return null
      }

      const data = await res.json()
      return extractCompletionText(data)
    } catch (err) {
      console.error('Failed to call OpenAI', err)
      return null
    }
  }

  if (provider === 'DeepSeek') {
    // DeepSeek REST Chat endpoint (assumed). Uses Bearer token in Authorization header.
    if (!apiKey) {
      console.error('No API key available for DeepSeek')
      return null
    }
    // 优先尝试使用 OpenAI 官方 SDK（DeepSeek 兼容 OpenAI 格式）
    try {
      const sdkResult = await callOpenAiCompatibleSdk('https://api.deepseek.com')

      if (typeof sdkResult === 'string' && sdkResult.length > 0) {
        return sdkResult
      }
    } catch (err) {
      // 如果无法导入 SDK（例如在浏览器中），则使用 fetch 回退
      console.debug('OpenAI SDK not available, using fetch fallback', err)
    }

    // 官方文档推荐的 DeepSeek OpenAI 兼容 endpoint
    const endpoint = 'https://api.deepseek.com/chat/completions'

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: prepared.messages }),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error('DeepSeek API error', res.status, text)
        return null
      }

      const data = await res.json()
      return extractCompletionText(data)
    } catch (e) {
      console.error('Failed to call DeepSeek', e)
      return null
    }
  }

  console.error('Provider not implemented:', provider)
  return null
}
