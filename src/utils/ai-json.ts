const canParseJson = (candidate: string): boolean => {
  try {
    JSON.parse(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * 从 `start` 处的 `{` / `[` 开始，找到配对的闭合括号。
 * 会跳过字符串里的括号、转义引号与嵌套结构；无法配对时返回 null。
 */
const findBalancedJsonEnd = (text: string, start: number): number | null => {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      stack.push('}')
      continue
    }

    if (char === '[') {
      stack.push(']')
      continue
    }

    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return null
      }

      if (!stack.length) {
        return index + 1
      }
    }
  }

  return null
}

/**
 * 从模型回复里提取第一段可解析的 JSON（对象或数组）。
 *
 * 依次尝试：
 * 1. ```json ... ``` 代码块；
 * 2. 整段回复；
 * 3. 正文中任意 `{` / `[` 开始的平衡 JSON 片段。
 *
 * 这样不依赖 `}` 的贪婪/非贪婪匹配，也不会在嵌套对象（如 `国家指标`）处截断。
 */
export function extractJsonFromText(text: string): string | null {
  if (!text.trim()) {
    return null
  }

  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const candidate = match[1]?.trim()

    if (candidate && canParseJson(candidate)) {
      return candidate
    }
  }

  const trimmed = text.trim()

  if (canParseJson(trimmed)) {
    return trimmed
  }

  for (let start = 0; start < text.length; start += 1) {
    const char = text[start]

    if (char !== '{' && char !== '[') {
      continue
    }

    const end = findBalancedJsonEnd(text, start)

    if (end === null) {
      continue
    }

    const candidate = text.slice(start, end).trim()

    if (candidate && canParseJson(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * 从模型回复里去掉提取到的变更 JSON，只留下叙述文字。
 *
 * 事件触发的 JSON 是给程序读的，不该原样贴进对话框；
 * 如果模型在 JSON 前后还写了说明，这里保留说明、去掉 JSON 与空代码块。
 */
export function stripJsonFromText(text: string, jsonText: string | null): string {
  if (!jsonText) {
    return text.trim()
  }

  let cleaned = text
  const index = cleaned.indexOf(jsonText)

  if (index >= 0) {
    cleaned = `${cleaned.slice(0, index)}${cleaned.slice(index + jsonText.length)}`
  }

  return cleaned
    .replace(/```(?:json)?\s*```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
