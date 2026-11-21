import { describe, expect, it } from 'vitest'

import { modelOptionsMap, openCodeGoBaseUrl, providerOptions } from '../ai-settings'

describe('ai-settings 提供商配置', () => {
  it('OpenCode Go 在提供商列表里，并带有可用模型', () => {
    expect(providerOptions).toContain('OpenCode Go')
    expect(modelOptionsMap['OpenCode Go']).toContain('deepseek-v4.1-flash')
    expect(modelOptionsMap['OpenCode Go'].length).toBeGreaterThan(0)
  })

  it('每个提供商都至少配置了一个模型', () => {
    for (const provider of providerOptions) {
      expect(modelOptionsMap[provider].length).toBeGreaterThan(0)
    }
  })

  it('OpenCode Go 使用 Go 网关的 OpenAI 兼容路径', () => {
    expect(openCodeGoBaseUrl).toBe('https://opencode.ai/inference/go/openai/v1')
  })
})
