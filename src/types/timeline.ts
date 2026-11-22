import type { CountryIndicatorData } from './country'

/**
 * 时间线事件类型。
 *
 * - `indicator`：国家指标（政治稳定 / 经济发展 / 国际影响）发生变化；
 * - `reform`：政治制度、经济状况等文本字段被手动修改；
 * - `create`：新政权建立；
 * - `destroy`：政权灭亡（可能带继承者，也可能时间线就此中断）；
 * - `rename`：政权更名，时间线在改名处接续；
 * - `transfer`：两个政权之间划转领土。
 */
export type TimelineEventKind =
  | 'indicator'
  | 'reform'
  | 'create'
  | 'destroy'
  | 'rename'
  | 'transfer'

/** 事件来源：AI 推演、玩家手动操作，或开局种子。 */
export type TimelineEventSource = 'ai' | 'manual' | 'init'

/** 与 `CountryData.国家指标` 同构，独立命名避免时间线模块依赖完整国家档案。 */
export type TimelineIndicators = CountryIndicatorData

/**
 * 一条时间线事件。
 *
 * `day` 是距离开局的世界内天数（不是真实时间戳），横轴一律按它定位，
 * 因此「开局时间」写成 `公元 192 年` 这类自由文本时也能画出连续时间线。
 */
export interface TimelineEvent {
  id: string
  kind: TimelineEventKind
  /** 事件主体；灭亡时是被灭亡的政权，更名时是旧名称。 */
  country: string
  /** 距离开局的天数，可以为 0（开局当天）或小数以外的整数。 */
  day: number
  /** 第几次「时间推进」之后，用于在提示框里补充说明。 */
  turn: number
  source: TimelineEventSource
  /** 悬停时展示的事件概述。 */
  summary: string
  /** 事件发生时该政权的代表色。 */
  color?: string
  /** 变更后的国家指标。 */
  indicators?: TimelineIndicators
  /** 变更前的国家指标。 */
  previousIndicators?: TimelineIndicators
  /** 仅「灭亡」：实际接管领土的继承国；为空表示无继承者。 */
  successors?: string[]
  /** 仅「更名」：变更后的名称。 */
  nextName?: string
  /** 政权变更的原因。 */
  reason?: string
  /** AI 自己给出的日期文本，只用于展示，不参与坐标计算。 */
  dateText?: string
  /** 触发本轮变更的指令或操作说明。 */
  trigger?: string
}

/** 开局时就存在的政权，用来给时间线建立起始泳道。 */
export interface TimelineRegimeSeed {
  国家名称: string
  代表色: string
  国家指标: TimelineIndicators
}

/**
 * 一条世界线的时间线状态。
 *
 * 与存档放在一起（事件驱动页的归档条目、快照条目），
 * 这样切换快照或重新打开页面时时间线不会丢。
 */
export interface TimelineState {
  version: 1
  scenarioName: string
  /** 开局时间原文，可能是 `1947-01-01T00:00`，也可能是 `公元 192 年`。 */
  startTimeText: string
  /** 开局时间能被解析成日期时的本地时间戳；解析不了就是 null。 */
  startEpochMs: number | null
  /** 当前世界内时间：距离开局的天数。 */
  currentDay: number
  /** 已经执行过多少次「时间推进」。 */
  turn: number
  initialCountries: TimelineRegimeSeed[]
  events: TimelineEvent[]
}
