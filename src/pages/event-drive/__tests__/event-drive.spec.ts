import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
