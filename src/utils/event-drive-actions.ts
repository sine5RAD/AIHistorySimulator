/**
 * 事件推进页「指令模板」下拉菜单的纯逻辑。
 *
 * 这里集中维护每种指令的固定格式文字与国家名的拼音排序，
 * 组件只负责收集输入，方便单元测试精确校验最终发送的字符串。
 */

export type EventDriveActionKind = 'time' | 'event' | 'story' | 'question' | 'conflict'

export interface EventDriveActionOption {
  kind: EventDriveActionKind
  label: string
  description: string
}

/** 下拉菜单里的固定顺序，与提示词中约定的指令类型一一对应。 */
export const EVENT_DRIVE_ACTIONS: readonly EventDriveActionOption[] = [
  {
    kind: 'time',
    label: '时间推进',
    description: '推进若干日、月或年，让 AI 推演这段时间内的事件。',
  },
  {
    kind: 'event',
    label: '事件触发',
    description: '指定一个国家发生某个事件，并推演其后续影响。',
  },
  {
    kind: 'story',
    label: '讲述故事',
    description: '围绕指定国家与主题，让 AI 讲述一个故事。',
  },
  {
    kind: 'question',
    label: '提问',
    description: '就当前世界向 AI 提出一个问题。',
  },
  {
    kind: 'conflict',
    label: '矛盾修正',
    description: '指出两个相互冲突的设定，请 AI 给出解释或修正。',
  },
]

/** 时间推进单位，顺序固定为 日、月、年。 */
export const EVENT_DRIVE_TIME_UNITS = ['日', '月', '年'] as const

export type EventDriveTimeUnit = (typeof EVENT_DRIVE_TIME_UNITS)[number]

/** 模板里每个可填写位置的值。 */
export interface EventDriveActionInput {
  time: string
  timeUnit: EventDriveTimeUnit
  country: string
  event: string
  topic: string
  question: string
  setting1: string
  setting2: string
}

export const createEmptyEventDriveActionInput = (): EventDriveActionInput => ({
  time: '',
  timeUnit: EVENT_DRIVE_TIME_UNITS[0],
  country: '',
  event: '',
  topic: '',
  question: '',
  setting1: '',
  setting2: '',
})

/** zh-Hans-CN 的默认排序即拼音序；numeric 让「国家 2」排在「国家 10」前。 */
const countryNameCollator = new Intl.Collator('zh-Hans-CN', {
  sensitivity: 'base',
  numeric: true,
})

/** 去掉空白与重复项后，按拼音顺序排列国家名。 */
export function sortCountryNamesByPinyin(names: readonly string[]): string[] {
  const uniqueNames = Array.from(
    new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
  )

  return uniqueNames.sort((a, b) => countryNameCollator.compare(a, b))
}

/** 时间数量只允许数字：输入或粘贴其它字符时直接丢弃。 */
export function sanitizeTimeDigits(value: string): string {
  return value.replace(/\D+/g, '')
}

/** 时间推进：`时间推进{time}{unit}`。 */
export function buildTimeAdvancePrompt(time: string, unit: EventDriveTimeUnit): string {
  return `时间推进${sanitizeTimeDigits(time)}${unit}`
}

/** 事件触发：`{country}发生{event}`。 */
export function buildEventTriggerPrompt(country: string, event: string): string {
  return `${country.trim()}发生${event.trim()}`
}

/** 讲述故事：`请讲述一个在{country}发生的，主题为{topic}的故事`。 */
export function buildStoryPrompt(country: string, topic: string): string {
  return `请讲述一个在${country.trim()}发生的，主题为${topic.trim()}的故事`
}

/** 去掉用户自己输入在结尾的问号，避免模板再补问号后出现 `??`。 */
const normalizeQuestion = (question: string): string =>
  question
    .trim()
    .replace(/[?？]+$/u, '')
    .trim()

/** 提问：`{question}?`。 */
export function buildQuestionPrompt(question: string): string {
  return `${normalizeQuestion(question)}?`
}

/** 矛盾修正：`设定{setting1}与设定{setting2}冲突，请给出一个合理解释或修正后一个设定`。 */
export function buildConflictPrompt(setting1: string, setting2: string): string {
  return `设定${setting1.trim()}与设定${setting2.trim()}冲突，请给出一个合理解释或修正后一个设定`
}

/** 根据下拉菜单选中的指令类型拼装最终发送的字符串。 */
export function buildEventDrivePrompt(
  kind: EventDriveActionKind,
  input: EventDriveActionInput,
): string {
  switch (kind) {
    case 'time':
      return buildTimeAdvancePrompt(input.time, input.timeUnit)
    case 'event':
      return buildEventTriggerPrompt(input.country, input.event)
    case 'story':
      return buildStoryPrompt(input.country, input.topic)
    case 'question':
      return buildQuestionPrompt(input.question)
    case 'conflict':
      return buildConflictPrompt(input.setting1, input.setting2)
  }
}

/** 判断模板里的必填位置是否都已填写，用于控制「发送」按钮。 */
export function isEventDrivePromptComplete(
  kind: EventDriveActionKind,
  input: EventDriveActionInput,
): boolean {
  switch (kind) {
    case 'time':
      return sanitizeTimeDigits(input.time).length > 0
    case 'event':
      return input.country.trim().length > 0 && input.event.trim().length > 0
    case 'story':
      return input.country.trim().length > 0 && input.topic.trim().length > 0
    case 'question':
      return normalizeQuestion(input.question).length > 0
    case 'conflict':
      return input.setting1.trim().length > 0 && input.setting2.trim().length > 0
  }
}
