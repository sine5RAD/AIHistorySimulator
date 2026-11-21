import { describe, expect, it } from 'vitest'

import {
  EVENT_DRIVE_ACTIONS,
  EVENT_DRIVE_TIME_UNITS,
  buildConflictPrompt,
  buildEventDrivePrompt,
  buildEventTriggerPrompt,
  buildQuestionPrompt,
  buildStoryPrompt,
  buildTimeAdvancePrompt,
  createEmptyEventDriveActionInput,
  isEventDrivePromptComplete,
  sanitizeTimeDigits,
  sortCountryNamesByPinyin,
} from '../event-drive-actions'
import type { EventDriveActionInput } from '../event-drive-actions'

const makeInput = (patch: Partial<EventDriveActionInput> = {}): EventDriveActionInput => ({
  ...createEmptyEventDriveActionInput(),
  country: '楚国',
  ...patch,
})

describe('EVENT_DRIVE_ACTIONS', () => {
  it('下拉菜单包含五种指令', () => {
    expect(EVENT_DRIVE_ACTIONS.map((option) => option.label)).toEqual([
      '时间推进',
      '事件触发',
      '讲述故事',
      '提问',
      '矛盾修正',
    ])
  })
})

describe('EVENT_DRIVE_TIME_UNITS', () => {
  it('单位固定为 日 / 月 / 年', () => {
    expect(EVENT_DRIVE_TIME_UNITS).toEqual(['日', '月', '年'])
  })
})

describe('sanitizeTimeDigits', () => {
  it('只保留数字', () => {
    expect(sanitizeTimeDigits('12a年3')).toBe('123')
    expect(sanitizeTimeDigits('-3.5')).toBe('35')
    expect(sanitizeTimeDigits('   ')).toBe('')
  })
})

describe('buildTimeAdvancePrompt', () => {
  it('按「时间推进{time}{unit}」拼装', () => {
    expect(buildTimeAdvancePrompt('3', '年')).toBe('时间推进3年')
    expect(buildTimeAdvancePrompt(' 12 ', '月')).toBe('时间推进12月')
    expect(buildTimeAdvancePrompt('1', '日')).toBe('时间推进1日')
  })
})

describe('buildEventTriggerPrompt', () => {
  it('按「{country}发生{event}」拼装', () => {
    expect(buildEventTriggerPrompt('楚国', '政变')).toBe('楚国发生政变')
    expect(buildEventTriggerPrompt(' 楚国 ', ' 政变 ')).toBe('楚国发生政变')
  })
})

describe('buildStoryPrompt', () => {
  it('按「请讲述一个在{country}发生的，主题为{topic}的故事」拼装', () => {
    expect(buildStoryPrompt('楚国', '战争')).toBe('请讲述一个在楚国发生的，主题为战争的故事')
  })
})

describe('buildQuestionPrompt', () => {
  it('按「{question}?」拼装', () => {
    expect(buildQuestionPrompt('楚国的政治制度是什么')).toBe('楚国的政治制度是什么?')
  })

  it('不会重复追加问号', () => {
    expect(buildQuestionPrompt('楚国的政治制度是什么?')).toBe('楚国的政治制度是什么?')
    expect(buildQuestionPrompt('楚国的政治制度是什么？')).toBe('楚国的政治制度是什么?')
  })
})

describe('buildConflictPrompt', () => {
  it('按「设定{setting1}与设定{setting2}冲突，请给出一个合理解释或修正后一个设定」拼装', () => {
    expect(buildConflictPrompt('楚国为君主制', '楚国为共和制')).toBe(
      '设定楚国为君主制与设定楚国为共和制冲突，请给出一个合理解释或修正后一个设定',
    )
  })
})

describe('sortCountryNamesByPinyin', () => {
  it('按拼音顺序排列、去重并忽略空名称', () => {
    expect(
      sortCountryNamesByPinyin([
        '中国',
        '美国',
        '法国',
        '德国',
        '日本',
        '英国',
        '阿根廷',
        '中国',
        ' 美国 ',
        '',
        '   ',
      ]),
    ).toEqual(['阿根廷', '德国', '法国', '美国', '日本', '英国', '中国'])
  })

  it('数字后缀按数值排序', () => {
    expect(sortCountryNamesByPinyin(['新国家 10', '新国家 2'])).toEqual(['新国家 2', '新国家 10'])
  })
})

describe('buildEventDrivePrompt', () => {
  it('按指令类型分派到对应模板', () => {
    expect(buildEventDrivePrompt('time', makeInput({ time: '2', timeUnit: '年' }))).toBe(
      '时间推进2年',
    )
    expect(buildEventDrivePrompt('event', makeInput({ event: '大旱' }))).toBe('楚国发生大旱')
    expect(buildEventDrivePrompt('story', makeInput({ topic: '旱灾' }))).toBe(
      '请讲述一个在楚国发生的，主题为旱灾的故事',
    )
    expect(buildEventDrivePrompt('question', makeInput({ question: '楚国与秦国接壤吗' }))).toBe(
      '楚国与秦国接壤吗?',
    )
    expect(
      buildEventDrivePrompt(
        'conflict',
        makeInput({ setting1: '楚国为君主制', setting2: '楚国为共和制' }),
      ),
    ).toBe('设定楚国为君主制与设定楚国为共和制冲突，请给出一个合理解释或修正后一个设定')
  })
})

describe('isEventDrivePromptComplete', () => {
  it('时间推进需要填写数字', () => {
    expect(isEventDrivePromptComplete('time', makeInput({ time: '' }))).toBe(false)
    expect(isEventDrivePromptComplete('time', makeInput({ time: 'abc' }))).toBe(false)
    expect(isEventDrivePromptComplete('time', makeInput({ time: '3' }))).toBe(true)
  })

  it('国家相关指令需要国家与文本都填写', () => {
    expect(isEventDrivePromptComplete('event', makeInput({ country: '', event: '政变' }))).toBe(
      false,
    )
    expect(isEventDrivePromptComplete('event', makeInput({ event: '  ' }))).toBe(false)
    expect(isEventDrivePromptComplete('event', makeInput({ event: '政变' }))).toBe(true)

    expect(isEventDrivePromptComplete('story', makeInput({ topic: '' }))).toBe(false)
    expect(isEventDrivePromptComplete('story', makeInput({ topic: '战争' }))).toBe(true)
  })

  it('提问不能只有问号', () => {
    expect(isEventDrivePromptComplete('question', makeInput({ question: '  ' }))).toBe(false)
    expect(isEventDrivePromptComplete('question', makeInput({ question: '？?' }))).toBe(false)
    expect(isEventDrivePromptComplete('question', makeInput({ question: '楚国为何衰落' }))).toBe(
      true,
    )
  })

  it('矛盾修正需要两个设定都填写', () => {
    expect(isEventDrivePromptComplete('conflict', makeInput({ setting1: '甲' }))).toBe(false)
    expect(
      isEventDrivePromptComplete('conflict', makeInput({ setting1: '甲', setting2: '乙' })),
    ).toBe(true)
  })
})
