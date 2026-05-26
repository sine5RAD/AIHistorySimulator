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

  if (provider === 'DeepSeek') {
    // DeepSeek REST Chat endpoint (assumed). Uses Bearer token in Authorization header.
    if (!apiKey) {
      console.error('No API key available for DeepSeek')
      return null
    }
    // 优先尝试使用 OpenAI 官方 SDK（DeepSeek 兼容 OpenAI 格式）
    try {
      // 动态导入，兼容后端 Node 环境（如果 SDK 可用）
      const mod = await import('openai')

      /* eslint-disable @typescript-eslint/no-explicit-any */
      const modAny = mod as any
      const OpenAI = modAny?.default ?? modAny
      /* eslint-enable @typescript-eslint/no-explicit-any */

      if (OpenAI) {
        try {
          const client = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey })

          // 使用 SDK 的 chat.create
          const completion = await client.chat.completions.create({
            model,
            messages: prepared.messages,
            thinking: { type: 'enabled' },
            reasoning_effort: 'high',
            stream: false,
          })

          const choice = completion?.choices?.[0]
          const content = choice?.message?.content ?? choice?.text
          if (typeof content === 'string') return content
        } catch (err) {
          // SDK 调用失败，回退到 fetch
          console.warn('OpenAI SDK call to DeepSeek failed, falling back to fetch', err)
        }
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

      // Flexible parsing: try choices[].message.content, fallback to data.output or data.result
      if (Array.isArray(data.choices) && data.choices.length > 0) {
        const parts: string[] = []
        for (const ch of data.choices) {
          const content = ch.message?.content ?? ch.text
          if (typeof content === 'string') parts.push(content)
        }
        return parts.join('\n')
      }

      if (typeof data.output === 'string') return data.output
      if (typeof data.result === 'string') return data.result

      // Last resort: stringify the response
      return JSON.stringify(data)
    } catch (e) {
      console.error('Failed to call DeepSeek', e)
      return null
    }
  }

  console.error('Provider not implemented:', provider)
  return null
}
