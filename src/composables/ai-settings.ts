import { computed, onMounted, ref, watch } from 'vue'

export const aiSettingsStorageKey = 'ai-settings'

export const providerOptions = ['OpenAI', 'DeepSeek', 'Qwen', 'Anthropic', 'OpenCode Go'] as const

export type Provider = (typeof providerOptions)[number]

/**
 * OpenCode Go 订阅的 OpenAI 兼容网关。
 *
 * 官方文档：Go 订阅统一走 `https://opencode.ai/inference/go`，
 * Chat Completions 路径为 `/openai/v1/chat/completions`；
 * 模型 ID 以 `GET https://opencode.ai/inference/go/v1/models` 返回值为准。
 */
export const openCodeGoBaseUrl = 'https://opencode.ai/inference/go/openai/v1'

/**
 * 浏览器不能直接请求 opencode.ai（会被 CORS 拦截），
 * 因此默认走同源路径 `/api/opencode-go`，由 Vite 开发/预览服务器或生产反向代理转发。
 */
export const openCodeGoProxyPath = '/api/opencode-go'

export const openCodeGoRequestBaseUrl = (() => {
  const configured = import.meta.env.VITE_OPENCODE_GO_BASE_URL

  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim()
  }

  if (typeof window !== 'undefined') {
    return `${window.location.origin}${openCodeGoProxyPath}`
  }

  return openCodeGoBaseUrl
})()

export const modelOptionsMap: Record<Provider, string[]> = {
  OpenAI: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
  DeepSeek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  Qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  Anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  'OpenCode Go': [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'glm-5.3',
    'glm-5.3-flash',
    'kimi-k3',
    'kimi-k2.7-code',
    'qwen3.8-max',
    'qwen3.8-flash',
    'minimax-m3.1-flash',
    'hy4',
  ],
}

export function useAiSettings() {
  const selectedProvider = ref<Provider>(providerOptions[0])
  const apiValue = ref('')
  const selectedModel = ref<string>(modelOptionsMap[selectedProvider.value][0] ?? '')

  const modelOptions = computed(() => modelOptionsMap[selectedProvider.value] ?? [])

  const saveAiSettings = () => {
    window.localStorage.setItem(
      aiSettingsStorageKey,
      JSON.stringify({
        provider: selectedProvider.value,
        api: apiValue.value,
        model: selectedModel.value,
      }),
    )
  }

  const loadAiSettings = () => {
    const cachedAiSettings = window.localStorage.getItem(aiSettingsStorageKey)

    if (!cachedAiSettings) {
      return
    }

    try {
      const parsedSettings = JSON.parse(cachedAiSettings) as {
        provider?: string
        api?: string
        model?: string
      }
      const cachedProvider = parsedSettings.provider as Provider | undefined

      if (cachedProvider && providerOptions.includes(cachedProvider)) {
        selectedProvider.value = cachedProvider
      }

      if (typeof parsedSettings.api === 'string') {
        apiValue.value = parsedSettings.api
      }

      const availableModels = modelOptionsMap[selectedProvider.value] ?? []

      if (parsedSettings.model && availableModels.includes(parsedSettings.model)) {
        selectedModel.value = parsedSettings.model
      }
    } catch {
      window.localStorage.removeItem(aiSettingsStorageKey)
    }
  }

  onMounted(loadAiSettings)

  watch(selectedProvider, (provider) => {
    const availableModels = modelOptionsMap[provider] ?? []

    if (!availableModels.includes(selectedModel.value)) {
      selectedModel.value = availableModels[0] ?? ''
    }
  })

  return {
    apiValue,
    modelOptions,
    providerOptions,
    saveAiSettings,
    selectedModel,
    selectedProvider,
  }
}

export interface AiSettings {
  provider: Provider
  api: string
  model: string
}
