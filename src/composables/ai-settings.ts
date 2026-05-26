import { computed, onMounted, ref, watch } from 'vue'

export const aiSettingsStorageKey = 'ai-settings'

export const providerOptions = ['OpenAI', 'DeepSeek', 'Qwen', 'Anthropic'] as const

export type Provider = (typeof providerOptions)[number]

export const modelOptionsMap: Record<Provider, string[]> = {
  OpenAI: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
  DeepSeek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  Qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  Anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
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
