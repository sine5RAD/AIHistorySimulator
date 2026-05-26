/**
 * 准备提示词工具
 * 提供一个可直接传给模型的 messages 结构（兼容 OpenAI chat 格式）
 */
export type Role = 'system' | 'user' | 'assistant'

export interface PromptMessage {
  role: Role
  content: string
}

export interface PreparedPrompt {
  provider?: string
  model?: string
  messages: PromptMessage[]
}

/**
 * 预先加载提示词
 * @param prompt 用户输入的提示词文本
 * @param opts 可选项：provider、model、以及 systemPrompt（系统指令）
 * @returns PreparedPrompt - 可直接用于发送到 chat completion 的对象
 */
export function 预先加载提示词(
  prompt: string,
  opts?: { provider?: string; model?: string; systemPrompt?: string },
): PreparedPrompt {
  const system = opts?.systemPrompt ?? '你是一个友好且精准的助理，回答时尽量简洁明了。'
  const provider = opts?.provider
  const model = opts?.model

  const messages: PromptMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ]

  return {
    provider,
    model,
    messages,
  }
}

// 英文别名，便于代码中引用
export const preloadPrompt = 预先加载提示词
