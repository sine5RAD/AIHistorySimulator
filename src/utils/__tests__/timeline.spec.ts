import { describe, expect, it } from 'vitest'

import type { AppliedRegimeChange } from '@/types/regime'

import {
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  advanceTimelineClock,
  buildTimelineLayout,
  buildTimelineTicks,
  createTimelineState,
  formatGameDate,
  normalizeTimelineState,
  parseTimeAdvanceInstruction,
  parseTimelineStartTime,
  readWorldColorMap,
  readWorldCountries,
  recordIndicatorChange,
  recordReformChange,
  recordRegimeTimelineEvents,
  resolveTimelineEventDay,
} from '../timeline'

const indicators = (政治稳定: number, 经济发展: number, 国际影响: number) => ({
  政治稳定,
  经济发展,
  国际影响,
})

const createState = () =>
  createTimelineState({
    scenarioName: '时间线测试',
    startTimeText: '1947-01-01T00:00',
    countries: [
      { 国家名称: '甲国', 代表色: '#d64545', 国家指标: indicators(10, 20, 30) },
      { 国家名称: '乙国', 代表色: '#3b82f6', 国家指标: indicators(40, 50, 60) },
      { 国家名称: '丙国', 代表色: '#7aa84a', 国家指标: indicators(0, 0, 0) },
    ],
    colorMap: { 甲国: '#d64545', 乙国: '#3b82f6', 丙国: '#7aa84a' },
  })

const findLane = (layout: ReturnType<typeof buildTimelineLayout>, name: string) =>
  layout.lanes.find((lane) => lane.name === name)

describe('解析开局时间', () => {
  it('支持 datetime-local、斜杠与中文年份写法', () => {
    const iso = parseTimelineStartTime('1947-01-01T00:00')

    expect(iso).not.toBeNull()
    expect(formatGameDate(iso, 0)).toBe('1947-01-01')

    const chinese = parseTimelineStartTime('公元 192 年')
    expect(chinese).not.toBeNull()

    const chineseDate = new Date(chinese as number)
    expect(chineseDate.getFullYear()).toBe(192)
    expect(chineseDate.getMonth()).toBe(0)
    expect(chineseDate.getDate()).toBe(1)

    const slash = parseTimelineStartTime('1947/3/5')
    expect(slash).not.toBeNull()
    expect(formatGameDate(slash, 0)).toBe('1947-03-05')
  })

  it('支持只有年或年-月的日期', () => {
    const year = parseTimelineStartTime('1948')
    expect(year).not.toBeNull()
    expect(formatGameDate(year, 0)).toBe('1948-01-01')

    const month = parseTimelineStartTime('1948-03')
    expect(month).not.toBeNull()
    expect(formatGameDate(month, 0)).toBe('1948-03-01')

    const chineseMonth = parseTimelineStartTime('1948年3月')
    expect(chineseMonth).not.toBeNull()
    expect(formatGameDate(chineseMonth, 0)).toBe('1948-03-01')
  })

  it('解析不了或日期不存在时返回 null', () => {
    expect(parseTimelineStartTime('')).toBeNull()
    expect(parseTimelineStartTime('很久以前')).toBeNull()
    expect(parseTimelineStartTime('1947-02-30')).toBeNull()
    expect(parseTimelineStartTime('1947-13-01')).toBeNull()
  })
})

describe('解析时间推进指令', () => {
  it('识别模板与手写指令并换算成天数', () => {
    expect(parseTimeAdvanceInstruction('时间推进12年')).toMatchObject({
      amount: 12,
      unit: '年',
      days: 12 * DAYS_PER_YEAR,
    })
    expect(parseTimeAdvanceInstruction('推进时间 3 个月')).toMatchObject({
      unit: '月',
      days: 3 * DAYS_PER_MONTH,
    })
    expect(parseTimeAdvanceInstruction('推进7天')).toMatchObject({ days: 7 })
    expect(parseTimeAdvanceInstruction('推进时间 2 周')).toMatchObject({ days: 14 })
  })

  it('普通对话与零数量不会被当成时间推进', () => {
    expect(parseTimeAdvanceInstruction('你好')).toBeNull()
    expect(parseTimeAdvanceInstruction('推进时间0年')).toBeNull()
    expect(parseTimeAdvanceInstruction('中国发生政变')).toBeNull()
    // 提问里出现「推进」不会推进本地时钟
    expect(parseTimeAdvanceInstruction('如果推进3年会怎样？')).toBeNull()
  })

  it('允许礼貌前缀与句末标点', () => {
    expect(parseTimeAdvanceInstruction('请推进时间 2 年。')).toMatchObject({
      days: 2 * DAYS_PER_YEAR,
    })
  })
})

describe('AI 事件时间', () => {
  it('把具体日期换算成距离开局的天数', () => {
    const start = parseTimelineStartTime('1947-01-01T00:00')

    expect(resolveTimelineEventDay(start, '1948-03-15')).toBe(439)
    expect(resolveTimelineEventDay(start, '1947-01-10')).toBe(9)
    expect(resolveTimelineEventDay(start, '1947-01')).toBe(0)
    expect(resolveTimelineEventDay(start, '1946-12-01')).toBe(0)
    expect(resolveTimelineEventDay(start, '不是日期')).toBeNull()
    expect(resolveTimelineEventDay(null, '1948-03-15')).toBeNull()
  })

  it('指标变动优先使用 AI 时间，而不是回合时钟', () => {
    let state = advanceTimelineClock(createState(), 365)

    state = recordIndicatorChange(state, {
      country: '甲国',
      indicators: indicators(15, 18, 35),
      previous: indicators(10, 20, 30),
      source: 'ai',
      timeText: '1948-03-15',
    })

    expect(state.currentDay).toBe(365)
    expect(state.events[0]).toMatchObject({
      kind: 'indicator',
      day: 439,
      dateText: '1948-03-15',
    })
  })

  it('政权变更按 时间 / 日期 定位灭亡与继承分叉', () => {
    let state = advanceTimelineClock(createState(), 500)

    state = recordRegimeTimelineEvents(state, {
      changes: [
        {
          类型: '建立',
          政权名称: '丁国',
          时间: '1948-03-15',
          代表色: '#c2417d',
          国家指标: indicators(5, 5, 5),
        },
        {
          类型: '灭亡',
          政权名称: '甲国',
          时间: '1948-03-15',
          继承国: ['丁国'],
          代表色: '#d64545',
        },
      ],
      messages: ['已建立政权：丁国', '已灭亡政权：甲国（丁国 继承全部领土）'],
      source: 'ai',
    })

    const layout = buildTimelineLayout(state)

    expect(findLane(layout, '丁国')?.startDay).toBe(439)
    expect(findLane(layout, '甲国')?.endDay).toBe(439)
    expect(layout.forks).toEqual([expect.objectContaining({ kind: 'succession', day: 439 })])
  })

  it('没有 AI 时间时回退到当前回合', () => {
    let state = advanceTimelineClock(createState(), 20)

    state = recordRegimeTimelineEvents(state, {
      changes: [{ 类型: '灭亡', 政权名称: '丙国' }],
      messages: ['已灭亡政权：丙国（领土变为无主）'],
      source: 'ai',
    })

    expect(state.events[0]?.day).toBe(20)
    expect(state.events[0]?.dateText).toBeUndefined()
  })
})

describe('世界包读取', () => {
  it('兼容顶层与 world 嵌套两种写法', () => {
    expect(readWorldCountries({ countries: [{ 国家名称: '甲国' }] })).toHaveLength(1)
    expect(readWorldCountries({ world: { countries: [{ 国家名称: '乙国' }] } })).toHaveLength(1)
    expect(readWorldColorMap({ countryColorMap: { 甲国: '#111111' } })).toEqual({
      甲国: '#111111',
    })
    expect(readWorldColorMap({ world: { countryColorMap: { 乙国: '#222222' } } })).toEqual({
      乙国: '#222222',
    })
  })
})

describe('时间线状态', () => {
  it('用世界包开一条从第 0 天开始的时间线', () => {
    const state = createState()

    expect(state.startEpochMs).not.toBeNull()
    expect(state.currentDay).toBe(0)
    expect(state.turn).toBe(0)
    expect(state.initialCountries.map((seed) => seed.国家名称)).toEqual(['甲国', '乙国', '丙国'])
    expect(state.initialCountries[0]?.国家指标).toEqual(indicators(10, 20, 30))
  })

  it('推进时钟只改变当前天数与回合数', () => {
    const state = advanceTimelineClock(createState(), 365)

    expect(state.currentDay).toBe(365)
    expect(state.turn).toBe(1)
    expect(state.events).toHaveLength(0)
  })

  it('存档归一化后保留事件与时钟，坏数据返回 null', () => {
    let state = advanceTimelineClock(createState(), 30)
    state = recordIndicatorChange(state, {
      country: '甲国',
      indicators: indicators(15, 18, 35),
      previous: indicators(10, 20, 30),
      source: 'ai',
    })

    const normalized = normalizeTimelineState(JSON.parse(JSON.stringify(state)))

    expect(normalized).not.toBeNull()
    expect(normalized?.currentDay).toBe(30)
    expect(normalized?.turn).toBe(1)
    expect(normalized?.events).toHaveLength(1)
    expect(normalized?.events[0]?.indicators).toEqual(indicators(15, 18, 35))

    expect(normalizeTimelineState('nope')).toBeNull()
    expect(normalizeTimelineState({ events: 'nope' })).toBeNull()
  })
})

describe('记录事件', () => {
  it('指标变动带上旧值、新值与事件概述', () => {
    let state = advanceTimelineClock(createState(), 30)
    state = recordIndicatorChange(state, {
      country: '甲国',
      indicators: indicators(15, 18, 35),
      previous: indicators(10, 20, 30),
      description: '战后重建与出口回暖',
      source: 'ai',
      color: '#d64545',
      trigger: '时间推进1个月',
    })

    const event = state.events[0]

    expect(event).toMatchObject({
      kind: 'indicator',
      country: '甲国',
      day: 30,
      turn: 1,
      source: 'ai',
      color: '#d64545',
      trigger: '时间推进1个月',
    })
    expect(event?.summary).toContain('战后重建与出口回暖')
    expect(event?.summary).toContain('政治稳定 10→15')
    expect(event?.summary).toContain('经济发展 20→18')
    expect(event?.previousIndicators).toEqual(indicators(10, 20, 30))
    expect(event?.indicators).toEqual(indicators(15, 18, 35))
  })

  it('制度类文本调整单独记成 reform 事件', () => {
    let state = createState()
    state = recordReformChange(state, {
      country: '甲国',
      label: '政治制度',
      value: '议会共和制',
      previousValue: '君主制',
      source: 'manual',
    })

    expect(state.events[0]).toMatchObject({
      kind: 'reform',
      country: '甲国',
      source: 'manual',
      summary: '政治制度：君主制 → 议会共和制',
    })
  })

  it('政权灭亡会记录实际继承国，无主时没有继承者', () => {
    let state = advanceTimelineClock(createState(), 100)
    state = recordRegimeTimelineEvents(state, {
      changes: [
        { 类型: '灭亡', 政权名称: '甲国', 继承国: ['乙国'], 代表色: '#d64545' },
        { 类型: '灭亡', 政权名称: '丙国', 代表色: '#7aa84a' },
      ],
      messages: ['已灭亡政权：甲国（乙国 继承全部领土）', '已灭亡政权：丙国（领土变为无主）'],
      source: 'ai',
      trigger: '事件触发：甲国内战',
    })

    expect(state.events).toHaveLength(2)
    expect(state.events[0]).toMatchObject({ kind: 'destroy', successors: ['乙国'] })
    expect(state.events[0]?.summary).toContain('继承国：乙国')
    expect(state.events[1]).toMatchObject({ kind: 'destroy' })
    expect(state.events[1]?.successors).toBeUndefined()
    expect(state.events[1]?.summary).toContain('无继承者')
  })
})

describe('泳道与分叉', () => {
  const destroyWithTwoSuccessors = (): AppliedRegimeChange[] => [
    {
      类型: '灭亡',
      政权名称: '甲国',
      继承国: ['乙国', '丙国'],
      原因: '甲国内战分裂',
      代表色: '#d64545',
      国家指标: indicators(10, 20, 30),
    },
  ]

  it('继承者排在父政权下面，分叉线用继承者颜色', () => {
    let state = advanceTimelineClock(createState(), 365)
    state = recordRegimeTimelineEvents(state, {
      changes: destroyWithTwoSuccessors(),
      messages: ['已灭亡政权：甲国（乙国 分得 2 条、丙国 分得 1 条）'],
      source: 'ai',
    })

    const layout = buildTimelineLayout(state)
    const parent = findLane(layout, '甲国')

    expect(parent?.endKind).toBe('destroyed')
    expect(parent?.endDay).toBe(365)
    expect(layout.forks).toHaveLength(2)
    expect(layout.forks.map((fork) => fork.kind)).toEqual(['succession', 'succession'])
    expect(new Set(layout.forks.map((fork) => fork.color))).toEqual(new Set(['#3b82f6', '#7aa84a']))

    const order = layout.lanes.map((lane) => lane.name)
    expect(order.indexOf('甲国')).toBeLessThan(order.indexOf('乙国'))
    expect(order.indexOf('甲国')).toBeLessThan(order.indexOf('丙国'))
    expect(layout.lastDay).toBeGreaterThanOrEqual(365)
    expect(layout.destroyedCount).toBe(1)
  })

  it('继承者即使开局排在前面，也会移到父政权下面', () => {
    let state = advanceTimelineClock(createState(), 100)
    state = recordRegimeTimelineEvents(state, {
      changes: [{ 类型: '灭亡', 政权名称: '丙国', 继承国: ['甲国'], 代表色: '#7aa84a' }],
      messages: ['已灭亡政权：丙国（甲国 继承全部领土）'],
      source: 'ai',
    })

    const layout = buildTimelineLayout(state)
    const order = layout.lanes.map((lane) => lane.name)

    expect(order.indexOf('甲国')).toBeGreaterThan(order.indexOf('丙国'))
    expect(layout.forks).toEqual([
      expect.objectContaining({ kind: 'succession', toLaneId: findLane(layout, '甲国')?.id }),
    ])
  })

  it('同一天先记录指标再建立政权，不会出现重复泳道', () => {
    let state = advanceTimelineClock(createState(), 10)

    // 与事件驱动页一致：先应用指标变更，再应用政权变更。
    state = recordIndicatorChange(state, {
      country: '丁国',
      indicators: indicators(12, 8, 4),
      source: 'ai',
    })
    state = recordRegimeTimelineEvents(state, {
      changes: [
        {
          类型: '建立',
          政权名称: '丁国',
          代表色: '#c2417d',
          国家指标: indicators(12, 8, 4),
        },
      ],
      messages: ['已建立政权：丁国'],
      source: 'ai',
    })

    const layout = buildTimelineLayout(state)
    const lanes = layout.lanes.filter((lane) => lane.name === '丁国')

    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.startDay).toBe(10)
    expect(lanes[0]?.events.map((event) => event.kind)).toEqual(['create', 'indicator'])
  })

  it('没有继承者时时间线在灭亡处中断', () => {
    let state = advanceTimelineClock(createState(), 200)
    state = recordRegimeTimelineEvents(state, {
      changes: [{ 类型: '灭亡', 政权名称: '乙国', 代表色: '#3b82f6' }],
      messages: ['已灭亡政权：乙国（领土变为无主）'],
      source: 'ai',
    })

    const layout = buildTimelineLayout(state)
    const lane = findLane(layout, '乙国')

    expect(lane?.endKind).toBe('destroyed')
    expect(lane?.endDay).toBe(200)
    expect(lane?.successors).toEqual([])
    expect(layout.forks).toHaveLength(0)
  })

  it('更名把旧泳道接到新名称，颜色保持不变', () => {
    let state = advanceTimelineClock(createState(), 40)
    state = recordRegimeTimelineEvents(state, {
      changes: [
        {
          类型: '更名',
          政权名称: '甲国',
          新名称: '甲共和国',
          代表色: '#d64545',
          国家指标: indicators(10, 20, 30),
        },
      ],
      messages: ['已更名：甲国 → 甲共和国'],
      source: 'manual',
    })

    const layout = buildTimelineLayout(state)
    const oldLane = findLane(layout, '甲国')
    const newLane = findLane(layout, '甲共和国')

    expect(oldLane?.endKind).toBe('renamed')
    expect(oldLane?.endDay).toBe(40)
    expect(newLane?.startDay).toBe(40)
    expect(newLane?.endKind).toBe('alive')
    expect(newLane?.color).toBe('#d64545')
    expect(layout.forks).toEqual([
      expect.objectContaining({
        kind: 'rename',
        day: 40,
        fromLaneId: oldLane?.id,
        toLaneId: newLane?.id,
        color: '#d64545',
      }),
    ])
  })

  it('新建立的政权从建立当天开始，并持续到当前时间', () => {
    let state = advanceTimelineClock(createState(), 50)
    state = advanceTimelineClock(state, 10)
    state = recordRegimeTimelineEvents(state, {
      changes: [
        {
          类型: '建立',
          政权名称: '丁国',
          代表色: '#c2417d',
          国家指标: indicators(5, 5, 5),
          原因: '乙国殖民地独立',
        },
      ],
      messages: ['已建立政权：丁国（领土 1 条；原因：乙国殖民地独立）'],
      source: 'ai',
    })

    const layout = buildTimelineLayout(state, [{ name: '丁国', color: '#c2417d' }])
    const lane = findLane(layout, '丁国')

    expect(lane?.startDay).toBe(60)
    expect(lane?.endDay).toBe(60)
    expect(lane?.endKind).toBe('alive')
    expect(lane?.events[0]?.kind).toBe('create')
  })

  it('旧存档没有时间线事件时，仍按当前政权补出泳道', () => {
    const layout = buildTimelineLayout(createState(), [
      { name: '甲国', color: '#d64545', indicators: indicators(10, 20, 30) },
      { name: '戊国', color: '#e07a35', indicators: indicators(1, 2, 3) },
    ])

    expect(layout.lanes.map((lane) => lane.name)).toEqual(['甲国', '乙国', '丙国', '戊国'])
    expect(findLane(layout, '戊国')?.color).toBe('#e07a35')
  })
})

describe('时间刻度', () => {
  it('可解析开局时间时按日期显示刻度', () => {
    const state = createState()
    const ticks = buildTimelineTicks(state.startEpochMs, 0, 30)

    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks[0]).toMatchObject({ day: 0, label: '1947-01-01', major: true })
  })

  it('跨度较大时按真实日历年对齐，闰年不会出现重复年份', () => {
    const state = createState()
    const ticks = buildTimelineTicks(state.startEpochMs, 0, 2190)

    expect(ticks.map((tick) => tick.label)).toEqual([
      '1947',
      '1948',
      '1949',
      '1950',
      '1951',
      '1952',
    ])
  })

  it('一个多月到两年的跨度按月份对齐', () => {
    const state = createState()
    const ticks = buildTimelineTicks(state.startEpochMs, 0, 120)

    expect(ticks.map((tick) => tick.label)).toEqual([
      '1947-01',
      '1947-02',
      '1947-03',
      '1947-04',
      '1947-05',
    ])
  })

  it('公元 100 年以前的年份也不会被当成 19xx 年', () => {
    const epoch = parseTimelineStartTime('公元 92 年')
    const ticks = buildTimelineTicks(epoch, 0, 1095)

    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks.map((tick) => tick.label)).toContain('92')
    expect(ticks.map((tick) => tick.label)).not.toContain('1992')
  })

  it('开局时间不可解析时退回相对天数', () => {
    const ticks = buildTimelineTicks(null, 0, 30)

    expect(ticks[0]).toMatchObject({ day: 0, label: '开局' })
    expect(ticks.every((tick) => tick.label.startsWith('开局'))).toBe(true)
  })
})
