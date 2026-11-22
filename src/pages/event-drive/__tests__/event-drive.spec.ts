import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { EVENT_DRIVE_FRESH_SESSION_KEY, SCENARIO_TRANSFER_KEY } from '@/utils/scenario-transfer'

import EventDrive from '../event-drive.vue'

const { pushMock, submitPreparedPromptMock } = vi.hoisted(() => ({
  pushMock: vi.fn<(path: unknown) => void>(),
  submitPreparedPromptMock: vi.fn<(prepared: unknown) => Promise<string>>(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/utils/submit-commition', () => ({
  submitPreparedPrompt: submitPreparedPromptMock,
}))

const AI_SETTINGS_KEY = 'ai-settings'
const WORLD_PACKAGE_KEY = 'event-drive-world-package-json'

const worldPayload = {
  currentCountryName: '中国',
  countries: [
    { 国家名称: '中国' },
    { 国家名称: '美国' },
    { 国家名称: '法国' },
    { 国家名称: '德国' },
  ],
}

const scenarioTransferPayload = {
  source: 'scenario-editor',
  sentAt: '2026-11-21T12:00:00.000Z',
  scenario: {
    剧本名称: '1947 开局',
    开局时间: '1947-01-01T00:00',
    存在国家: [
      {
        国家名称: '中国',
        AI控制: true,
        代表色: '#d64545',
        政体: '共和制',
        初始国家力量: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
        领导人: [{ 姓名: '甲某人', 职位: '主席', 简介: '开局领导人' }],
        领土: [{ 名称: '中国本土', 代码: 'CHN', 国家代码: 'CHN', 级别: 'country' }],
      },
      {
        国家名称: '美国',
        AI控制: false,
        代表色: '#3b82f6',
        政体: '总统制',
        初始国家力量: { 政治稳定: 40, 经济发展: 50, 国际影响: 60 },
      },
    ],
  },
}

const polishChangeResponse = JSON.stringify(
  [
    {
      国家名称: '波兰共和国',
      描述: '1947年议会选举中工人党主导的民主联盟以80.07%得票获胜，西方指其舞弊；工人党借此确立一党主导体制，镇压反对派与农民党。',
      国家指标: {
        政治稳定: 23,
        经济发展: -2,
        国际影响: 30,
      },
      政治制度改变:
        '人民民主共和国，工人党主导的民主联盟在议会选举中获胜，一党主导体制确立，制宪议会将起草新宪法',
      校验: '政稳+5、经济+3、国际影响-2，幅度均在10点内，与原值18/-5/32衔接合理',
    },
  ],
  null,
  2,
)

const createScenarioWithPoland = () => {
  const payload = JSON.parse(JSON.stringify(scenarioTransferPayload)) as {
    source: string
    sentAt: string
    scenario: {
      剧本名称: string
      开局时间: string
      存在国家: Array<Record<string, unknown>>
    }
  }

  payload.scenario.存在国家.push({
    国家名称: '波兰共和国',
    AI控制: true,
    代表色: '#8a8f98',
    政体: '人民民主共和国',
    初始国家力量: { 政治稳定: 18, 经济发展: -5, 国际影响: 32 },
  })

  return payload
}

const mountPage = async (): Promise<VueWrapper> => {
  const wrapper = mount(EventDrive, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const openAction = async (wrapper: VueWrapper, label: string) => {
  await wrapper.get('.action-trigger').trigger('click')

  const target = wrapper.findAll('.action-menu-item').find((item) => item.text().includes(label))

  if (!target) {
    throw new Error(`找不到「${label}」菜单项`)
  }

  await target.trigger('click')
}

const submitBuilder = async (wrapper: VueWrapper) => {
  await wrapper.get('form.action-builder').trigger('submit')
  await flushPromises()
}

const lastSentPrompt = (): string | undefined => {
  const calls = submitPreparedPromptMock.mock.calls
  const prepared = calls[calls.length - 1]?.[0] as
    | { messages: Array<{ content: string }> }
    | undefined
  const messages = prepared?.messages ?? []

  return messages[messages.length - 1]?.content
}

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

/**
 * Node 24 自带一个需要 `--localstorage-file` 的 localStorage 全局，
 * 会遮蔽 jsdom 的实现，导致测试环境里 `window.localStorage` 为 undefined。
 */
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

let wrapper: VueWrapper | null = null

beforeAll(() => {
  ensureWebStorage()
  // jsdom 没有实现 scrollTo
  Element.prototype.scrollTo = vi.fn<() => void>()
})

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  pushMock.mockReset()
  submitPreparedPromptMock.mockReset()
  submitPreparedPromptMock.mockResolvedValue('好的，已收到。')

  window.localStorage.setItem(
    AI_SETTINGS_KEY,
    JSON.stringify({ provider: 'OpenAI', api: 'sk-test', model: 'gpt-4.1-mini' }),
  )
  window.localStorage.setItem(WORLD_PACKAGE_KEY, JSON.stringify(worldPayload))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('事件推进页指令模板', () => {
  it('下拉菜单按固定顺序列出五种指令', async () => {
    wrapper = await mountPage()
    await wrapper.get('.action-trigger').trigger('click')

    expect(
      wrapper.findAll('.action-menu-item .action-menu-label').map((item) => item.text()),
    ).toEqual(['时间推进', '事件触发', '讲述故事', '提问', '矛盾修正'])
  })

  it('时间推进限制数字输入，发送「时间推进{time}{unit}」', async () => {
    wrapper = await mountPage()
    await openAction(wrapper, '时间推进')

    expect(wrapper.get('.action-template').text()).toContain('时间推进')

    const timeInput = wrapper.get('.action-input-time')
    await timeInput.setValue('12a年')

    expect((timeInput.element as HTMLInputElement).value).toBe('12')
    expect(wrapper.get('.action-preview-text').text()).toBe('时间推进12日')

    await wrapper.get('.action-template select').setValue('年')
    expect(wrapper.get('.action-preview-text').text()).toBe('时间推进12年')

    await submitBuilder(wrapper)

    expect(submitPreparedPromptMock).toHaveBeenCalledTimes(1)
    expect(lastSentPrompt()).toBe('时间推进12年')
    expect(wrapper.text()).toContain('时间推进12年')

    // 发送成功后清空数量，避免重复发送
    expect((wrapper.get('.action-input-time').element as HTMLInputElement).value).toBe('')
  })

  it('事件触发按拼音列出国家，发送「{country}发生{event}」', async () => {
    wrapper = await mountPage()
    await openAction(wrapper, '事件触发')

    const countrySelect = wrapper.get('.action-template select')
    expect(countrySelect.findAll('option').map((option) => option.text())).toEqual([
      '德国',
      '法国',
      '美国',
      '中国',
    ])
    expect((countrySelect.element as HTMLSelectElement).value).toBe('德国')

    await countrySelect.setValue('中国')
    await wrapper.get('.action-input-grow').setValue('政变')

    expect(wrapper.get('.action-template').text()).toContain('发生')
    expect(wrapper.get('.action-preview-text').text()).toBe('中国发生政变')

    await submitBuilder(wrapper)
    expect(lastSentPrompt()).toBe('中国发生政变')
  })

  it('讲述故事发送「请讲述一个在{country}发生的，主题为{topic}的故事」', async () => {
    wrapper = await mountPage()
    await openAction(wrapper, '讲述故事')

    const templateText = wrapper.get('.action-template').text()
    expect(templateText).toContain('请讲述一个在')
    expect(templateText).toContain('发生的，主题为')
    expect(templateText).toContain('的故事')

    await wrapper.get('.action-template select').setValue('法国')
    await wrapper.get('.action-input-grow').setValue('战争')

    expect(wrapper.get('.action-preview-text').text()).toBe(
      '请讲述一个在法国发生的，主题为战争的故事',
    )

    await submitBuilder(wrapper)
    expect(lastSentPrompt()).toBe('请讲述一个在法国发生的，主题为战争的故事')
  })

  it('提问发送「{question}?」，固定问号只出现一次', async () => {
    wrapper = await mountPage()
    await openAction(wrapper, '提问')

    expect(wrapper.get('.action-template').text()).toContain('?')

    await wrapper.get('.action-input-grow').setValue('美国的政治制度是什么？')

    expect(wrapper.get('.action-preview-text').text()).toBe('美国的政治制度是什么?')

    await submitBuilder(wrapper)
    expect(lastSentPrompt()).toBe('美国的政治制度是什么?')
  })

  it('矛盾修正发送「设定{setting1}与设定{setting2}冲突，请给出一个合理解释或修正后一个设定」', async () => {
    wrapper = await mountPage()
    await openAction(wrapper, '矛盾修正')

    const templateText = wrapper.get('.action-template').text()
    expect(templateText).toContain('设定')
    expect(templateText).toContain('与设定')
    expect(templateText).toContain('冲突，请给出一个合理解释或修正后一个设定')

    const inputs = wrapper.findAll('.action-input-grow')
    expect(inputs).toHaveLength(2)

    await inputs[0]!.setValue('中国为君主制')
    await inputs[1]!.setValue('中国为共和制')

    expect(wrapper.get('.action-preview-text').text()).toBe(
      '设定中国为君主制与设定中国为共和制冲突，请给出一个合理解释或修正后一个设定',
    )

    await submitBuilder(wrapper)
    expect(lastSentPrompt()).toBe(
      '设定中国为君主制与设定中国为共和制冲突，请给出一个合理解释或修正后一个设定',
    )
  })

  it('未填写完整时不能发送，可以填入输入框继续编辑', async () => {
    wrapper = await mountPage()
    await openAction(wrapper, '提问')

    expect(
      wrapper.get('.action-builder-footer .primary-button').attributes('disabled'),
    ).toBeDefined()

    await wrapper.get('.action-input-grow').setValue('楚国为何衰落')
    await wrapper.get('.action-builder-footer .ghost-button').trigger('click')

    expect(wrapper.find('.action-builder').exists()).toBe(false)
    expect((wrapper.get('textarea.composer-input').element as HTMLTextAreaElement).value).toBe(
      '楚国为何衰落?',
    )
    expect(submitPreparedPromptMock).not.toHaveBeenCalled()
  })
})

describe('剧本编辑页交接', () => {
  const seedScenarioTransfer = () => {
    window.sessionStorage.setItem(SCENARIO_TRANSFER_KEY, JSON.stringify(scenarioTransferPayload))
    window.sessionStorage.setItem(EVENT_DRIVE_FRESH_SESSION_KEY, 'true')
  }

  it('优先加载剧本，转成世界包并写入存档', async () => {
    seedScenarioTransfer()
    wrapper = await mountPage()

    expect(wrapper.text()).toContain('当前剧本')
    expect(wrapper.text()).toContain('1947 开局')
    expect(wrapper.text()).toContain('开局时间：1947-01-01T00:00')
    expect(wrapper.text()).toContain('2 个政权 · 玩家操控 1 个')
    expect(wrapper.text()).toContain('每轮发送国家简报')

    // 交接键只消费一次，避免刷新页面时覆盖后续聊天。
    expect(window.sessionStorage.getItem(SCENARIO_TRANSFER_KEY)).toBeNull()
    expect(window.localStorage.getItem(SCENARIO_TRANSFER_KEY)).toBeNull()

    const persistedPackage = JSON.parse(window.localStorage.getItem(WORLD_PACKAGE_KEY) ?? '{}') as {
      scenarioName?: string
      countries?: unknown[]
      countryColorMap?: Record<string, string>
    }

    expect(persistedPackage.scenarioName).toBe('1947 开局')
    expect(persistedPackage.countries).toHaveLength(2)
    expect(persistedPackage.countryColorMap).toEqual({
      中国: '#d64545',
      美国: '#3b82f6',
    })

    const archive = JSON.parse(
      window.localStorage.getItem('event-drive-world-chat-archive-json') ?? '{}',
    ) as Record<string, { world?: { scenarioName?: string } }>
    const archiveKey = '剧本 · 1947 开局 · 1947-01-01T00:00'

    expect(Object.keys(archive)).toEqual([archiveKey])
    expect(archive[archiveKey]?.world?.scenarioName).toBe('1947 开局')

    await openAction(wrapper, '事件触发')
    expect(
      wrapper
        .get('.action-template select')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['美国', '中国'])
  })

  it('新剧本不会带入上一局的聊天草稿', async () => {
    window.sessionStorage.setItem(SCENARIO_TRANSFER_KEY, JSON.stringify(scenarioTransferPayload))
    window.localStorage.setItem(
      'event-drive-chat-window-draft',
      JSON.stringify({
        chatInput: '旧输入',
        chatMessages: [{ role: 'user', content: '上一局的旧消息' }],
      }),
    )

    wrapper = await mountPage()

    expect(wrapper.text()).not.toContain('上一局的旧消息')
    expect((wrapper.get('textarea.composer-input').element as HTMLTextAreaElement).value).toBe('')

    const savedDraft = JSON.parse(
      window.localStorage.getItem('event-drive-chat-window-draft') ?? '{}',
    ) as { chatMessages?: unknown[] }

    expect(savedDraft.chatMessages ?? []).toHaveLength(0)
  })

  it('发送消息时注入国家简报与 AI 控制信息，不附加详情', async () => {
    seedScenarioTransfer()
    wrapper = await mountPage()

    await wrapper.get('textarea.composer-input').setValue('推进时间 1 年')
    await wrapper.get('.composer-footer .primary-button').trigger('click')
    await flushPromises()

    expect(submitPreparedPromptMock).toHaveBeenCalledTimes(1)

    const prepared = submitPreparedPromptMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>
    }
    const contextMessage = prepared.messages.find((message) =>
      message.content.includes('开局剧本「1947 开局」'),
    )

    expect(contextMessage?.role).toBe('user')
    expect(contextMessage?.content).toContain('国家简报，默认每轮发送')
    expect(contextMessage?.content).toContain('玩家操控（AI控制: false）：美国')
    expect(contextMessage?.content).toContain('"world"')
    expect(contextMessage?.content).toContain('"国家名称": "中国"')
    expect(contextMessage?.content).toContain('"领导人"')
    expect(contextMessage?.content).not.toContain('"简介"')
    expect(contextMessage?.content).not.toContain('"城市"')
    expect(
      prepared.messages.some((message) =>
        message.content.includes('以下是本轮消息涉及国家的详细档案'),
      ),
    ).toBe(false)
    expect(prepared.messages[prepared.messages.length - 1]?.content).toBe('推进时间 1 年')
  })

  it('消息提到国家时，只给提到的国家附加详细档案', async () => {
    seedScenarioTransfer()
    wrapper = await mountPage()

    await wrapper.get('textarea.composer-input').setValue('请比较中国和美国')
    await wrapper.get('.composer-footer .primary-button').trigger('click')
    await flushPromises()

    const prepared = submitPreparedPromptMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>
    }
    const detailMessage = prepared.messages.find((message) =>
      message.content.includes('以下是本轮消息涉及国家的详细档案'),
    )

    expect(detailMessage?.role).toBe('user')
    expect(detailMessage?.content).toContain('中国、美国')
    expect(detailMessage?.content).toContain('"姓名": "甲某人"')
    expect(detailMessage?.content).toContain('"简介": "开局领导人"')
    expect(detailMessage?.content).not.toContain('"adm1"')
  })

  it('AI 返回带嵌套 国家指标 的裸数组时能应用变更', async () => {
    window.sessionStorage.setItem(SCENARIO_TRANSFER_KEY, JSON.stringify(createScenarioWithPoland()))
    window.sessionStorage.setItem(EVENT_DRIVE_FRESH_SESSION_KEY, 'true')
    submitPreparedPromptMock.mockResolvedValue(polishChangeResponse)
    wrapper = await mountPage()

    await wrapper.get('textarea.composer-input').setValue('推进时间 1 年')
    await wrapper.get('.composer-footer .primary-button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已应用指标变更：波兰共和国')
    expect(wrapper.text()).toContain('已成功应用 1 条指标变更。')
    expect(wrapper.text()).not.toContain('解析 AI 返回的 JSON 失败')

    const archive = JSON.parse(
      window.localStorage.getItem('event-drive-world-chat-archive-json') ?? '{}',
    ) as Record<string, { world?: { countries?: Array<Record<string, unknown>> } }>
    const countries = archive['剧本 · 1947 开局 · 1947-01-01T00:00']?.world?.countries ?? []
    const poland = countries.find((country) => country.国家名称 === '波兰共和国')

    expect(poland?.国家指标).toEqual({ 政治稳定: 23, 经济发展: -2, 国际影响: 30 })
    expect(poland?.政治制度).toBe(
      '人民民主共和国，工人党主导的民主联盟在议会选举中获胜，一党主导体制确立，制宪议会将起草新宪法',
    )
  })

  it('普通叙述里的示例 JSON 不会触发变更应用', async () => {
    seedScenarioTransfer()
    submitPreparedPromptMock.mockResolvedValue('示例：{"foo":"bar"}，这不是变更数据。')
    wrapper = await mountPage()

    await wrapper.get('textarea.composer-input').setValue('讲一个故事')
    await wrapper.get('.composer-footer .primary-button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('未应用任何变更')
    expect(wrapper.text()).not.toContain('已应用指标变更')
  })

  it('交接内容无效时回退到已有世界包', async () => {
    window.sessionStorage.setItem(SCENARIO_TRANSFER_KEY, '{not-json')

    wrapper = await mountPage()

    expect(wrapper.text()).not.toContain('当前剧本')
    expect(window.sessionStorage.getItem(SCENARIO_TRANSFER_KEY)).toBeNull()

    await openAction(wrapper, '事件触发')
    expect(
      wrapper
        .get('.action-template select')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['德国', '法国', '美国', '中国'])
  })
})
