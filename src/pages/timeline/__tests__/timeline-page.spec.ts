import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import TimelinePage from '../timeline.vue'

const ARCHIVE_KEY = 'event-drive-world-chat-archive-json'
const LAST_WORLD_KEY = 'event-drive-last-world-key'
const WORLD_KEY = '剧本 · 时间线测试 · 1947-01-01T00:00'

/**
 * Node 24 自带一个需要 `--localstorage-file` 的 localStorage 全局，
 * 会遮蔽 jsdom 的实现，导致测试环境里 `window.localStorage` 为 undefined。
 */
const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()

  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(String(key), String(value))
    },
  }
}

const ensureWebStorage = () => {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (!globalThis[key]) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: createMemoryStorage(),
        writable: true,
      })
    }
  }
}

const createArchiveEntry = (timeline: Record<string, unknown> | null) => ({
  world: {
    scenarioName: '时间线测试',
    scenarioStartTime: '1947-01-01T00:00',
    countryColorMap: { 乙国: '#3b82f6' },
    countries: [
      {
        国家名称: '乙国',
        国家指标: { 政治稳定: 40, 经济发展: 52, 国际影响: 65 },
      },
    ],
  },
  countryIndicators: {},
  chatInput: '',
  chatMessages: [],
  timeline,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
})

const timelineState = {
  version: 1,
  scenarioName: '时间线测试',
  startTimeText: '1947-01-01T00:00',
  startEpochMs: new Date(1947, 0, 1).getTime(),
  currentDay: 365,
  turn: 1,
  initialCountries: [
    {
      国家名称: '甲国',
      代表色: '#d64545',
      国家指标: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
    },
    {
      国家名称: '乙国',
      代表色: '#3b82f6',
      国家指标: { 政治稳定: 40, 经济发展: 50, 国际影响: 60 },
    },
  ],
  events: [
    {
      id: 'event-indicator',
      kind: 'indicator',
      country: '乙国',
      day: 365,
      turn: 1,
      source: 'ai',
      summary: '边境冲突推高国际影响（国际影响 60→65）',
      color: '#3b82f6',
      indicators: { 政治稳定: 40, 经济发展: 52, 国际影响: 65 },
      previousIndicators: { 政治稳定: 40, 经济发展: 50, 国际影响: 60 },
      trigger: '时间推进1年',
    },
    {
      id: 'event-destroy',
      kind: 'destroy',
      country: '甲国',
      day: 365,
      turn: 1,
      source: 'ai',
      summary: '已灭亡政权：甲国；继承国：乙国',
      color: '#d64545',
      successors: ['乙国'],
    },
  ],
}

const mountPage = async (): Promise<VueWrapper> => {
  const wrapper = mount(TimelinePage, {
    attachTo: document.body,
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

let wrapper: VueWrapper | null = null

beforeAll(() => {
  ensureWebStorage()
})

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('时间线页', () => {
  it('按存档绘制泳道、分叉与事件点', async () => {
    window.localStorage.setItem(
      ARCHIVE_KEY,
      JSON.stringify({ [WORLD_KEY]: createArchiveEntry(timelineState) }),
    )
    window.localStorage.setItem(LAST_WORLD_KEY, WORLD_KEY)

    wrapper = await mountPage()

    expect(wrapper.find('.timeline-chart__svg').exists()).toBe(true)
    expect(wrapper.findAll('.timeline-chart__labels text').map((label) => label.text())).toEqual(
      expect.arrayContaining(['甲国', '乙国']),
    )
    expect(wrapper.findAll('.timeline-chart__fork')).toHaveLength(1)
    expect(wrapper.get('.timeline-chart__fork').attributes('stroke')).toBe('#3b82f6')
    expect(wrapper.findAll('.timeline-chart__point')).toHaveLength(2)
    expect(wrapper.text()).toContain('第 1 回合')
  })

  it('悬停事件点时显示事件概述与指标变化', async () => {
    window.localStorage.setItem(
      ARCHIVE_KEY,
      JSON.stringify({ [WORLD_KEY]: createArchiveEntry(timelineState) }),
    )
    window.localStorage.setItem(LAST_WORLD_KEY, WORLD_KEY)

    wrapper = await mountPage()

    await wrapper.get('.timeline-chart__point[data-kind="indicator"]').trigger('mouseenter')

    expect(wrapper.find('.timeline-chart__plot > .timeline-tooltip').exists()).toBe(true)
    expect(wrapper.get('.timeline-tooltip__summary').text()).toContain('边境冲突')
    expect(wrapper.get('.timeline-tooltip__time').text()).toContain('1948-01-01')
    expect(wrapper.get('.timeline-tooltip__indicators').text()).toContain('50 → 52')
    expect(wrapper.get('.timeline-tooltip__meta').text()).toContain('时间推进1年')

    await wrapper.get('.timeline-chart__point[data-kind="destroy"]').trigger('mouseenter')

    expect(wrapper.get('.timeline-tooltip__summary').text()).toContain('继承国：乙国')
  })

  it('没有存档时提示先去事件驱动开局', async () => {
    wrapper = await mountPage()

    expect(wrapper.text()).toContain('还没有可追踪的世界')
  })

  it('存档还没有事件时显示说明，但仍画出当前政权', async () => {
    const emptyTimeline = {
      ...timelineState,
      currentDay: 0,
      turn: 0,
      events: [],
    }

    window.localStorage.setItem(
      ARCHIVE_KEY,
      JSON.stringify({ [WORLD_KEY]: createArchiveEntry(emptyTimeline) }),
    )
    window.localStorage.setItem(LAST_WORLD_KEY, WORLD_KEY)

    wrapper = await mountPage()

    expect(wrapper.text()).toContain('还没有记录到变动')
    expect(wrapper.findAll('.timeline-chart__labels text').map((label) => label.text())).toEqual(
      expect.arrayContaining(['甲国', '乙国']),
    )
    expect(wrapper.findAll('.timeline-chart__point')).toHaveLength(0)
  })
})
