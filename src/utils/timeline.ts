import type { CountryIndicatorData } from '@/types/country'
import type { AppliedRegimeChange } from '@/types/regime'
import { DEFAULT_REGIME_COLOR } from '@/types/scenario'
import type {
  TimelineEvent,
  TimelineEventKind,
  TimelineEventSource,
  TimelineIndicators,
  TimelineRegimeSeed,
  TimelineState,
} from '@/types/timeline'

import { isRecord, normalizeCountryIndicators } from './country-data'

/**
 * 时间线的纯逻辑：游戏内时钟、事件记录、泳道与分叉布局。
 *
 * 事件驱动页只负责在指标 / 政权变更后调用 `record*` 函数，
 * 时间线页只负责调用 `buildTimelineLayout` 把状态变成可绘制的行与连接线。
 * 这里不依赖 Vue 与 DOM，方便逐条做单元测试。
 */

export const DAYS_PER_MONTH = 30
export const DAYS_PER_YEAR = 365

/** 单条时间线的最大事件数，防止长时间推演把 localStorage 撑爆。 */
export const MAX_TIMELINE_EVENTS = 4000

const MS_PER_DAY = 86_400_000

export const INDICATOR_KEYS = ['政治稳定', '经济发展', '国际影响'] as const

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const clampDay = (value: number): number => Math.max(0, Math.round(value))

const pad2 = (value: number): string => String(value).padStart(2, '0')

/* ------------------------------------------------------------------ *
 * 时间解析与格式化
 * ------------------------------------------------------------------ */

const buildLocalTimestamp = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number | null => {
  if (![year, month, day, hour, minute, second].every((value) => Number.isFinite(value))) {
    return null
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null
  }

  const date = new Date(year, month - 1, day, hour, minute, second, 0)

  // `new Date(99, ...)` 会被当成 1999 年，这里显式改回公元 99 年。
  if (year >= 0 && year < 100) {
    date.setFullYear(year, month - 1, day)
  }

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null
  }

  return date.getTime()
}

/**
 * 解析开局时间。
 *
 * 支持 `1947-01-01T00:00`、`1947-01-01 00:00`、`1947/1/1`、`1947.1.1`，
 * 以及 `公元 192 年`、`192 年 3 月` 这类中文写法。
 * 解析不了时返回 null，时间线改用「开局 + N 天」的相对刻度。
 */
export function parseTimelineStartTime(value: string): number | null {
  const text = value.trim()

  if (!text) {
    return null
  }

  const isoMatch =
    /^(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(text)

  if (isoMatch) {
    return buildLocalTimestamp(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
      Number(isoMatch[4] ?? 0),
      Number(isoMatch[5] ?? 0),
      Number(isoMatch[6] ?? 0),
    )
  }

  const chineseMatch =
    /(?:公元\s*)?(\d{1,4})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?)?/.exec(text)

  if (chineseMatch) {
    const hourMatch = /(\d{1,2})\s*[时点]/.exec(text)

    return buildLocalTimestamp(
      Number(chineseMatch[1]),
      Number(chineseMatch[2] ?? 1),
      Number(chineseMatch[3] ?? 1),
      Number(hourMatch?.[1] ?? 0),
    )
  }

  const slashMatch = /^(\d{1,4})[/.](\d{1,2})[/.](\d{1,2})/.exec(text)

  if (slashMatch) {
    return buildLocalTimestamp(Number(slashMatch[1]), Number(slashMatch[2]), Number(slashMatch[3]))
  }

  return null
}

/** 距离开局 N 天的人类可读文本；开局时间解析不了时作为横轴刻度。 */
export function formatDayOffsetLabel(day: number): string {
  const value = clampDay(day)

  if (value === 0) {
    return '开局'
  }

  if (value % DAYS_PER_YEAR === 0) {
    return `开局 + ${value / DAYS_PER_YEAR} 年`
  }

  if (value % DAYS_PER_MONTH === 0) {
    return `开局 + ${value / DAYS_PER_MONTH} 个月`
  }

  return `开局 + ${value} 天`
}

/** 把距离开局的天数换算成日期文本；开局时间不可解析时退回相对刻度。 */
export function formatGameDate(startEpochMs: number | null, day: number): string {
  if (startEpochMs === null) {
    return formatDayOffsetLabel(day)
  }

  const date = new Date(startEpochMs + Math.max(0, day) * MS_PER_DAY)

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 事件发生时间，供时间线提示框展示。 */
export function formatTimelineEventTime(startEpochMs: number | null, event: TimelineEvent): string {
  return formatGameDate(startEpochMs, event.day)
}

/** 指标数值展示：整数不带小数点，小数保留两位。 */
export function formatIndicatorNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0'
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/* ------------------------------------------------------------------ *
 * 时间推进指令
 * ------------------------------------------------------------------ */

export interface TimelineTimeAdvance {
  /** 换算后的天数。 */
  days: number
  amount: number
  unit: '日' | '天' | '周' | '月' | '年'
}

/**
 * 从用户指令里识别「时间推进」。
 *
 * 事件驱动页的模板会发送 `时间推进12年`，玩家也可能手写
 * `推进时间 1 年` / `推进 3 个月`，这里统一换算成天数。
 * 只认整条消息就是推进指令（可带「请 / 帮我」和句末标点），
 * 避免「如果推进 3 年会怎样？」这类提问也把时钟往前推。
 */
export function parseTimeAdvanceInstruction(text: string): TimelineTimeAdvance | null {
  const match =
    /^(?:请帮我|帮我|麻烦|请)?\s*(?:时间推进|推进时间|推进)\s*(\d+)\s*(?:个)?\s*(日|天|周|月|年)\s*[。.!！]?$/.exec(
      text.trim(),
    )

  if (!match) {
    return null
  }

  const amount = Number(match[1])
  const unit = match[2] as TimelineTimeAdvance['unit']

  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  const rawDays =
    unit === '日' || unit === '天'
      ? amount
      : unit === '周'
        ? amount * 7
        : unit === '月'
          ? amount * DAYS_PER_MONTH
          : amount * DAYS_PER_YEAR

  // 防止手误输入超大数字把时间轴撑到无法渲染。
  return { days: Math.min(rawDays, 365_000), amount, unit }
}

/* ------------------------------------------------------------------ *
 * 世界包读取
 * ------------------------------------------------------------------ */

/** 世界包里的政权数组：兼容 `countries` 与 `world.countries` 两种位置。 */
export function readWorldCountries(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return []
  }

  if (Array.isArray(payload.countries)) {
    return payload.countries
  }

  const world = isRecord(payload.world) ? payload.world : null

  return world && Array.isArray(world.countries) ? world.countries : []
}

const readColorRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {}
  }

  const colors: Record<string, string> = {}

  for (const [rawName, rawColor] of Object.entries(value)) {
    const name = rawName.trim()
    const color = readText(rawColor)

    if (name && color) {
      colors[name] = color
    }
  }

  return colors
}

/** 世界包里的代表色表：优先顶层，其次 `world.countryColorMap`。 */
export function readWorldColorMap(payload: unknown): Record<string, string> {
  if (!isRecord(payload)) {
    return {}
  }

  const topLevel = readColorRecord(payload.countryColorMap)

  if (Object.keys(topLevel).length) {
    return topLevel
  }

  const world = isRecord(payload.world) ? payload.world : null

  return readColorRecord(world?.countryColorMap)
}

/* ------------------------------------------------------------------ *
 * 时间线状态
 * ------------------------------------------------------------------ */

const readCountrySeed = (
  country: unknown,
  colorMap: Record<string, string>,
  indicators?: Record<string, CountryIndicatorData>,
): TimelineRegimeSeed | null => {
  if (!isRecord(country)) {
    return null
  }

  const name = readText(country.国家名称) || readText(country.国家)

  if (!name) {
    return null
  }

  const color = readText(colorMap[name]) || readText(country.代表色) || DEFAULT_REGIME_COLOR
  const indicatorValue = indicators?.[name] ?? country.国家指标 ?? country.初始国家力量

  return {
    国家名称: name,
    代表色: color,
    国家指标: normalizeCountryIndicators(indicatorValue),
  }
}

export interface CreateTimelineStateInput {
  countries?: readonly unknown[]
  colorMap?: Record<string, string>
  indicators?: Record<string, CountryIndicatorData>
  scenarioName?: string
  /** 开局时间原文；没有开局时间时事件驱动页会传世界包的 `generatedAt`。 */
  startTimeText?: string
}

/** 用当前世界开一条新时间线：所有政权都从第 0 天存在。 */
export function createTimelineState(input: CreateTimelineStateInput = {}): TimelineState {
  const startTimeText = readText(input.startTimeText)
  const colorMap = input.colorMap ?? {}
  const initialCountries: TimelineRegimeSeed[] = []
  const seen = new Set<string>()

  for (const country of input.countries ?? []) {
    const seed = readCountrySeed(country, colorMap, input.indicators)

    if (!seed || seen.has(seed.国家名称)) {
      continue
    }

    seen.add(seed.国家名称)
    initialCountries.push(seed)
  }

  return {
    version: 1,
    scenarioName: readText(input.scenarioName),
    startTimeText,
    startEpochMs: parseTimelineStartTime(startTimeText),
    currentDay: 0,
    turn: 0,
    initialCountries,
    events: [],
  }
}

const TIMELINE_EVENT_KINDS: readonly TimelineEventKind[] = [
  'indicator',
  'reform',
  'create',
  'destroy',
  'rename',
  'transfer',
]

const isTimelineEventKind = (value: unknown): value is TimelineEventKind =>
  typeof value === 'string' && (TIMELINE_EVENT_KINDS as readonly string[]).includes(value)

const isTimelineEventSource = (value: unknown): value is TimelineEventSource =>
  value === 'ai' || value === 'manual' || value === 'init'

const normalizeSeed = (value: unknown): TimelineRegimeSeed | null => {
  if (!isRecord(value)) {
    return null
  }

  const name = readText(value.国家名称)

  if (!name) {
    return null
  }

  return {
    国家名称: name,
    代表色: readText(value.代表色) || DEFAULT_REGIME_COLOR,
    国家指标: normalizeCountryIndicators(value.国家指标),
  }
}

const readIndicators = (value: unknown): TimelineIndicators | undefined =>
  isRecord(value) ? normalizeCountryIndicators(value) : undefined

const readNameList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => readText(item)).filter((item) => item.length > 0) : []

const normalizeTimelineEvent = (value: unknown, index: number): TimelineEvent | null => {
  if (!isRecord(value)) {
    return null
  }

  const kind = readText(value.kind)
  const country = readText(value.country)

  if (!isTimelineEventKind(kind) || !country) {
    return null
  }

  const day = clampDay(readFiniteNumber(value.day) ?? 0)
  const event: TimelineEvent = {
    id: readText(value.id) || `event-${index}-${kind}-${day}`,
    kind,
    country,
    day,
    turn: clampDay(readFiniteNumber(value.turn) ?? 0),
    source: isTimelineEventSource(value.source) ? value.source : 'ai',
    summary: readText(value.summary) || `${TIMELINE_EVENT_KIND_LABELS[kind]}：${country}`,
  }

  const color = readText(value.color)
  if (color) {
    event.color = color
  }

  const indicators = readIndicators(value.indicators)
  if (indicators) {
    event.indicators = indicators
  }

  const previousIndicators = readIndicators(value.previousIndicators)
  if (previousIndicators) {
    event.previousIndicators = previousIndicators
  }

  const successors = readNameList(value.successors)
  if (successors.length) {
    event.successors = successors
  }

  const nextName = readText(value.nextName)
  if (nextName) {
    event.nextName = nextName
  }

  for (const key of ['reason', 'dateText', 'trigger'] as const) {
    const text = readText(value[key])

    if (text) {
      event[key] = text
    }
  }

  return event
}

/**
 * 把存档里的任意值归一化成时间线状态。
 *
 * 旧存档没有时间线字段、或者字段被手工改坏时返回 null，
 * 由调用方用当前世界重新开一条时间线。
 */
export function normalizeTimelineState(value: unknown): TimelineState | null {
  if (!isRecord(value)) {
    return null
  }

  const eventsValue = value.events
  const seedsValue = value.initialCountries

  if (!Array.isArray(eventsValue) && !Array.isArray(seedsValue)) {
    return null
  }

  const startTimeText = readText(value.startTimeText)
  const startEpochValue = readFiniteNumber(value.startEpochMs)
  const events = (Array.isArray(eventsValue) ? eventsValue : [])
    .map((event, index) => normalizeTimelineEvent(event, index))
    .filter((event): event is TimelineEvent => event !== null)
    .slice(-MAX_TIMELINE_EVENTS)
  const initialCountries = (Array.isArray(seedsValue) ? seedsValue : [])
    .map(normalizeSeed)
    .filter((seed): seed is TimelineRegimeSeed => seed !== null)

  return {
    version: 1,
    scenarioName: readText(value.scenarioName),
    startTimeText,
    startEpochMs: startEpochValue ?? parseTimelineStartTime(startTimeText),
    currentDay: clampDay(readFiniteNumber(value.currentDay) ?? 0),
    turn: clampDay(readFiniteNumber(value.turn) ?? 0),
    initialCountries,
    events,
  }
}

/** 推进游戏内时钟；只有时间推进指令会触发。 */
export function advanceTimelineClock(state: TimelineState, days: number): TimelineState {
  const advance = Math.max(0, Math.round(days))

  return {
    ...state,
    currentDay: state.currentDay + advance,
    turn: state.turn + 1,
  }
}

const appendEvents = (state: TimelineState, events: TimelineEvent[]): TimelineState => {
  if (!events.length) {
    return state
  }

  return {
    ...state,
    events: [...state.events, ...events].slice(-MAX_TIMELINE_EVENTS),
  }
}

const createEventId = (
  state: TimelineState,
  kind: TimelineEventKind,
  country: string,
  offset = 0,
): string => `${kind}-${country}-${state.currentDay}-${state.events.length + offset}`

/* ------------------------------------------------------------------ *
 * 事件记录
 * ------------------------------------------------------------------ */

const buildIndicatorDiff = (
  previous: TimelineIndicators | undefined,
  next: TimelineIndicators,
): string =>
  INDICATOR_KEYS.map((key) => {
    const nextValue = formatIndicatorNumber(next[key])
    const previousValue = previous ? formatIndicatorNumber(previous[key]) : ''

    return previousValue ? `${key} ${previousValue}→${nextValue}` : `${key} ${nextValue}`
  }).join('、')

export interface IndicatorTimelineInput {
  country: string
  indicators: CountryIndicatorData
  previous?: CountryIndicatorData
  /** AI 给出的变更说明；为空时用「国家指标变动」。 */
  description?: string
  source: 'ai' | 'manual'
  color?: string
  trigger?: string
  dateText?: string
  politicalSystemChange?: string
  economicStatusChange?: string
}

/** 记录一次国家指标变动，返回追加事件后的新状态。 */
export function recordIndicatorChange(
  state: TimelineState,
  input: IndicatorTimelineInput,
): TimelineState {
  const country = readText(input.country)

  if (!country) {
    return state
  }

  const indicators = normalizeCountryIndicators(input.indicators)
  const previous = input.previous ? normalizeCountryIndicators(input.previous) : undefined
  const description = readText(input.description) || '国家指标变动'
  const details = [buildIndicatorDiff(previous, indicators)]
  const politicalSystemChange = readText(input.politicalSystemChange)
  const economicStatusChange = readText(input.economicStatusChange)

  if (politicalSystemChange) {
    details.push(`政治制度改为「${politicalSystemChange}」`)
  }

  if (economicStatusChange) {
    details.push(`经济状况改为「${economicStatusChange}」`)
  }

  const event: TimelineEvent = {
    id: createEventId(state, 'indicator', country),
    kind: 'indicator',
    country,
    day: state.currentDay,
    turn: state.turn,
    source: input.source,
    summary: `${description}（${details.join('；')}）`,
    indicators,
  }

  const color = readText(input.color)
  if (color) {
    event.color = color
  }

  if (previous) {
    event.previousIndicators = previous
  }

  const trigger = readText(input.trigger)
  if (trigger) {
    event.trigger = trigger
  }

  const dateText = readText(input.dateText)
  if (dateText) {
    event.dateText = dateText
  }

  return appendEvents(state, [event])
}

export interface ReformTimelineInput {
  country: string
  label: string
  value: string
  previousValue?: string
  source: 'ai' | 'manual'
  color?: string
  trigger?: string
}

/** 记录一次文本字段调整（政治制度、经济状况等）。 */
export function recordReformChange(
  state: TimelineState,
  input: ReformTimelineInput,
): TimelineState {
  const country = readText(input.country)

  if (!country) {
    return state
  }

  const label = readText(input.label) || '制度调整'
  const value = readText(input.value) || '未填写'
  const previousValue = readText(input.previousValue) || '未填写'
  const event: TimelineEvent = {
    id: createEventId(state, 'reform', country),
    kind: 'reform',
    country,
    day: state.currentDay,
    turn: state.turn,
    source: input.source,
    summary: `${label}：${previousValue} → ${value}`,
  }

  const color = readText(input.color)
  if (color) {
    event.color = color
  }

  const trigger = readText(input.trigger)
  if (trigger) {
    event.trigger = trigger
  }

  return appendEvents(state, [event])
}

export interface RegimeTimelineInput {
  changes: readonly AppliedRegimeChange[]
  /** 与 `changes` 一一对应的可读摘要（`applyRegimeChanges` 的 `applied`）。 */
  messages?: readonly string[]
  source: 'ai' | 'manual'
  trigger?: string
}

/** 把一批已生效的政权变更写进时间线。 */
export function recordRegimeTimelineEvents(
  state: TimelineState,
  input: RegimeTimelineInput,
): TimelineState {
  if (!input.changes.length) {
    return state
  }

  const events: TimelineEvent[] = []
  const trigger = readText(input.trigger)

  input.changes.forEach((change, index) => {
    const name = readText(change.政权名称)

    if (!name) {
      return
    }

    const message = readText(input.messages?.[index])
    const color = readText(change.代表色)
    const base: TimelineEvent = {
      id: '',
      kind: 'create',
      country: name,
      day: state.currentDay,
      turn: state.turn,
      source: input.source,
      summary: message || `${change.类型}：${name}`,
    }

    if (color) {
      base.color = color
    }

    if (change.国家指标) {
      base.indicators = normalizeCountryIndicators(change.国家指标)
    }

    const reason = readText(change.原因)
    if (reason) {
      base.reason = reason
    }

    const dateText = readText(change.日期)
    if (dateText) {
      base.dateText = dateText
    }

    if (trigger) {
      base.trigger = trigger
    }

    switch (change.类型) {
      case '建立': {
        base.kind = 'create'
        base.summary = message || `建立政权：${name}${reason ? `（${reason}）` : ''}`
        break
      }
      case '灭亡': {
        const successors = (change.继承国 ?? [])
          .map((successor) => successor.trim())
          .filter((successor) => successor.length > 0 && successor !== name)
        const successorText = successors.length
          ? `继承国：${successors.join('、')}`
          : '无继承者，时间线在此中断'

        base.kind = 'destroy'
        base.summary = message ? `${message}；${successorText}` : `灭亡：${name}；${successorText}`

        if (successors.length) {
          base.successors = successors
        }
        break
      }
      case '更名': {
        const nextName = readText(change.新名称)
        base.kind = 'rename'
        base.summary = message || `更名：${name} → ${nextName || '未命名'}`

        if (nextName) {
          base.nextName = nextName
        }
        break
      }
      case '领土': {
        base.kind = 'transfer'
        base.summary = message || `领土划转：${name}`
        break
      }
      default:
        break
    }

    base.id = createEventId(state, base.kind, name, events.length)
    events.push(base)
  })

  return appendEvents(state, events)
}

/* ------------------------------------------------------------------ *
 * 布局：泳道、分叉与刻度
 * ------------------------------------------------------------------ */

export interface TimelineLane {
  id: string
  name: string
  color: string
  startDay: number
  endDay: number
  endKind: 'alive' | 'destroyed' | 'renamed'
  indicators?: TimelineIndicators
  events: TimelineEvent[]
  successors: string[]
  nextLaneId?: string
}

export interface TimelineFork {
  id: string
  fromLaneId: string
  toLaneId: string
  day: number
  color: string
  kind: 'succession' | 'rename'
  label: string
}

export interface TimelineLayout {
  lanes: TimelineLane[]
  forks: TimelineFork[]
  /** 需要覆盖到的最晚一天。 */
  lastDay: number
  eventCount: number
  destroyedCount: number
}

/** 当前仍存在的政权快照，用于补全历史里没有记录到的泳道。 */
export interface TimelineRegimeSnapshot {
  name: string
  color?: string
  indicators?: CountryIndicatorData
}

export interface TimelineTick {
  day: number
  label: string
  major: boolean
}

export const safeTimelineColor = (value: string | undefined): string => {
  const color = readText(value)

  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : DEFAULT_REGIME_COLOR
}

const orderLanes = (lanes: TimelineLane[], forks: readonly TimelineFork[]): TimelineLane[] => {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]))
  const children = new Map<string, string[]>()

  for (const fork of forks) {
    if (fork.fromLaneId === fork.toLaneId) {
      continue
    }

    if (!laneById.has(fork.fromLaneId) || !laneById.has(fork.toLaneId)) {
      continue
    }

    const existing = children.get(fork.fromLaneId) ?? []

    if (!existing.includes(fork.toLaneId)) {
      existing.push(fork.toLaneId)
      children.set(fork.fromLaneId, existing)
    }
  }

  // 深度优先：父政权后面紧跟它的继承者子树，分叉线不会跨过整张图。
  const ordered: TimelineLane[] = []
  const visited = new Set<string>()
  const childIds = new Set<string>()

  for (const fork of forks) {
    childIds.add(fork.toLaneId)
  }

  const visit = (lane: TimelineLane) => {
    if (visited.has(lane.id)) {
      return
    }

    visited.add(lane.id)
    ordered.push(lane)

    for (const childLaneId of children.get(lane.id) ?? []) {
      const child = laneById.get(childLaneId)

      if (child) {
        visit(child)
      }
    }
  }

  // 先从未继承任何人的政权开始，保证「继承者一定排在父政权下面」。
  for (const lane of lanes) {
    if (!childIds.has(lane.id)) {
      visit(lane)
    }
  }

  // 互相继承之类的异常数据也要有输出；visited 会挡住环。
  for (const lane of lanes) {
    visit(lane)
  }

  return ordered
}

/**
 * 把时间线状态整理成可绘制的泳道。
 *
 * - 开局政权与「建立」事件生成泳道起点；
 * - 「灭亡」结束泳道，有继承者时生成向下分叉，没有继承者就停在灭亡点；
 * - 「更名」把旧泳道接到新名称的泳道，颜色保持不变；
 * - 父政权永远排在继承者上面，保证分叉方向向下。
 */
export function buildTimelineLayout(
  state: TimelineState,
  currentRegimes: readonly TimelineRegimeSnapshot[] = [],
): TimelineLayout {
  const lanes: TimelineLane[] = []
  const activeLanes = new Map<string, TimelineLane>()
  let laneCounter = 0

  const createLane = (
    name: string,
    color: string | undefined,
    startDay: number,
    indicators?: TimelineIndicators,
  ): TimelineLane => {
    const lane: TimelineLane = {
      id: `${name}@${laneCounter}`,
      name,
      color: safeTimelineColor(color),
      startDay: clampDay(startDay),
      endDay: clampDay(startDay),
      endKind: 'alive',
      events: [],
      successors: [],
    }

    if (indicators) {
      lane.indicators = normalizeCountryIndicators(indicators)
    }

    laneCounter += 1
    lanes.push(lane)
    activeLanes.set(name, lane)
    return lane
  }

  for (const seed of state.initialCountries) {
    const name = readText(seed.国家名称)

    if (!name || activeLanes.has(name)) {
      continue
    }

    createLane(name, seed.代表色, 0, seed.国家指标)
  }

  // 同一天里让「建立」先于其它事件、「灭亡 / 更名」晚于其它事件：
  // AI 回复是先记指标再落政权变更，这样新政权当天的指标点也能挂到正确泳道。
  const EVENT_ORDER: Record<TimelineEventKind, number> = {
    create: 0,
    indicator: 1,
    reform: 1,
    transfer: 1,
    rename: 2,
    destroy: 2,
  }
  const sortedEvents = state.events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.day - b.event.day ||
        EVENT_ORDER[a.event.kind] - EVENT_ORDER[b.event.kind] ||
        a.index - b.index,
    )

  for (const { event } of sortedEvents) {
    const name = event.country

    if (!name) {
      continue
    }

    switch (event.kind) {
      case 'create': {
        const lane = createLane(name, event.color, event.day, event.indicators)
        lane.events.push(event)
        break
      }
      case 'destroy': {
        const lane =
          activeLanes.get(name) ?? createLane(name, event.color, event.day, event.indicators)

        lane.endKind = 'destroyed'
        lane.endDay = Math.max(lane.startDay, clampDay(event.day))
        lane.successors = [...(event.successors ?? [])]
        lane.events.push(event)

        if (!lane.indicators && event.indicators) {
          lane.indicators = event.indicators
        }

        activeLanes.delete(name)
        break
      }
      case 'rename': {
        const lane =
          activeLanes.get(name) ?? createLane(name, event.color, event.day, event.indicators)

        lane.endKind = 'renamed'
        lane.endDay = Math.max(lane.startDay, clampDay(event.day))
        lane.events.push(event)

        const nextName = readText(event.nextName)

        if (nextName) {
          const nextLane = createLane(
            nextName,
            event.color ?? lane.color,
            event.day,
            event.indicators ?? lane.indicators,
          )

          lane.nextLaneId = nextLane.id
        }

        activeLanes.delete(name)
        break
      }
      default: {
        const lane =
          activeLanes.get(name) ??
          createLane(name, event.color, 0, event.previousIndicators ?? event.indicators)

        lane.events.push(event)

        if (event.indicators) {
          lane.indicators = event.indicators
        }
        break
      }
    }
  }

  // 旧存档没有时间线时，至少让当前存在的政权各有一行。
  for (const regime of currentRegimes) {
    const name = readText(regime.name)

    if (!name) {
      continue
    }

    const active = activeLanes.get(name)

    if (active) {
      active.color = safeTimelineColor(regime.color ?? active.color)

      if (!active.indicators && regime.indicators) {
        active.indicators = normalizeCountryIndicators(regime.indicators)
      }

      continue
    }

    if (lanes.some((lane) => lane.name === name)) {
      continue
    }

    createLane(name, regime.color, 0, regime.indicators)
  }

  for (const lane of lanes) {
    if (lane.endKind === 'alive') {
      lane.endDay = Math.max(lane.startDay, state.currentDay)
    }
  }

  const laneById = new Map(lanes.map((lane) => [lane.id, lane]))
  const findLaneAt = (name: string, day: number): TimelineLane | undefined => {
    const candidates = lanes.filter(
      (lane) =>
        lane.name === name &&
        lane.startDay <= day &&
        (lane.endKind === 'alive' || lane.endDay >= day),
    )

    if (!candidates.length) {
      return lanes.find((lane) => lane.name === name)
    }

    return candidates.reduce((best, lane) => (lane.startDay > best.startDay ? lane : best))
  }

  const forks: TimelineFork[] = []
  const forkKeys = new Set<string>()

  const pushFork = (fork: TimelineFork) => {
    const key = `${fork.fromLaneId}->${fork.toLaneId}`

    if (forkKeys.has(key)) {
      return
    }

    forkKeys.add(key)
    forks.push(fork)
  }

  for (const lane of lanes) {
    for (const event of lane.events) {
      if (event.kind !== 'destroy') {
        continue
      }

      for (const rawSuccessor of event.successors ?? []) {
        const child = findLaneAt(readText(rawSuccessor), event.day)

        if (!child || child.id === lane.id) {
          continue
        }

        pushFork({
          id: `${lane.id}->${child.id}:${event.id}`,
          fromLaneId: lane.id,
          toLaneId: child.id,
          day: clampDay(event.day),
          color: child.color,
          kind: 'succession',
          label: `继承：${child.name}`,
        })
      }
    }

    if (lane.endKind === 'renamed' && lane.nextLaneId) {
      const child = laneById.get(lane.nextLaneId)

      if (child) {
        pushFork({
          id: `${lane.id}->${child.id}:rename`,
          fromLaneId: lane.id,
          toLaneId: child.id,
          day: lane.endDay,
          color: child.color,
          kind: 'rename',
          label: `更名：${child.name}`,
        })
      }
    }
  }

  const orderedLanes = orderLanes(lanes, forks)
  const lastDay = lanes.reduce(
    (latest, lane) => Math.max(latest, lane.startDay, lane.endDay),
    state.currentDay,
  )

  return {
    lanes: orderedLanes,
    forks,
    lastDay,
    eventCount: state.events.length,
    destroyedCount: state.events.filter((event) => event.kind === 'destroy').length,
  }
}

const TICK_STEPS = [1, 2, 3, 5, 7, 14, 21, 30, 60, 90, 180, 365, 730, 1095, 1825, 3650, 7300, 18250]

const formatTickLabel = (startEpochMs: number | null, day: number, step: number): string => {
  if (startEpochMs === null) {
    return formatDayOffsetLabel(day)
  }

  const date = new Date(startEpochMs + day * MS_PER_DAY)
  const year = String(date.getFullYear())

  if (step >= DAYS_PER_YEAR) {
    return year
  }

  if (step >= 28) {
    return `${year}-${pad2(date.getMonth() + 1)}`
  }

  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

const buildCalendarDate = (year: number, month: number): Date => {
  // `new Date(92, 0, 1)` 会变成 1992 年；先构造一个正常年份再改回公元年份。
  const date = new Date(2000, month, 1, 0, 0, 0, 0)

  date.setFullYear(year, month, 1)
  return date
}

/**
 * 有可解析的开局时间时，刻度落在真实的月 / 年边界上。
 *
 * 直接按 365 天切分会因为闰年逐年漂移（1948-01-01 与 1948-12-31
 * 都会显示成 1948），所以跨度超过一个多月时改用日历边界，
 * 年份较多时再按 2 / 5 / 10 年抽稀。
 */
const buildCalendarTicks = (
  startEpochMs: number,
  startDay: number,
  endDay: number,
  maxTicks: number,
): TimelineTick[] => {
  const span = endDay - startDay
  const dayOf = (date: Date) => Math.round((date.getTime() - startEpochMs) / MS_PER_DAY)
  const startYear = new Date(startEpochMs + startDay * MS_PER_DAY).getFullYear()
  const lastYear = new Date(startEpochMs + endDay * MS_PER_DAY).getFullYear()
  const candidates: TimelineTick[] = []

  if (span >= 730) {
    for (let year = startYear; year <= lastYear; year += 1) {
      const day = dayOf(buildCalendarDate(year, 0))

      if (day >= startDay && day <= endDay) {
        candidates.push({ day, label: String(year), major: true })
      }
    }
  } else if (span >= 45) {
    for (let year = startYear; year <= lastYear; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const day = dayOf(buildCalendarDate(year, month))

        if (day >= startDay && day <= endDay) {
          candidates.push({
            day,
            label: `${year}-${pad2(month + 1)}`,
            major: month === 0,
          })
        }
      }
    }
  }

  if (!candidates.length) {
    return []
  }

  const step = Math.max(1, Math.ceil(candidates.length / maxTicks))

  return candidates.filter((_, index) => index % step === 0)
}

/** 根据当前视口范围挑一组整齐的时间刻度。 */
export function buildTimelineTicks(
  startEpochMs: number | null,
  startDay: number,
  endDay: number,
  maxTicks = 8,
): TimelineTick[] {
  const from = Math.max(0, Math.floor(startDay))
  const to = Math.max(from + 1, Math.ceil(endDay))
  const span = to - from

  if (startEpochMs !== null) {
    const calendarTicks = buildCalendarTicks(startEpochMs, from, to, maxTicks)

    if (calendarTicks.length) {
      return calendarTicks
    }
  }

  const step = TICK_STEPS.find((candidate) => span / candidate <= maxTicks) ?? 36500
  const first = Math.ceil(from / step) * step
  const ticks: TimelineTick[] = []

  for (let day = first; day <= to + 0.0001; day += step) {
    if (day < from) {
      continue
    }

    ticks.push({
      day,
      label: formatTickLabel(startEpochMs, day, step),
      major: day === 0 || (step >= DAYS_PER_YEAR && day % DAYS_PER_YEAR === 0),
    })

    if (ticks.length >= 40) {
      break
    }
  }

  return ticks
}

/* ------------------------------------------------------------------ *
 * 展示用文案
 * ------------------------------------------------------------------ */

export const TIMELINE_EVENT_KIND_LABELS: Record<TimelineEventKind, string> = {
  indicator: '指标变动',
  reform: '制度调整',
  create: '政权建立',
  destroy: '政权灭亡',
  rename: '政权更名',
  transfer: '领土划转',
}

export const TIMELINE_EVENT_SOURCE_LABELS: Record<TimelineEventSource, string> = {
  ai: 'AI 推演',
  manual: '手动操作',
  init: '开局',
}
