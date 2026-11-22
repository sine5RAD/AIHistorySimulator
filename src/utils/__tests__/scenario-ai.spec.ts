import { describe, expect, it } from 'vitest'

import { createEmptyRegimeData, createEmptyScenarioData } from '@/types/scenario'
import {
  buildScenarioAiPayload,
  compactRegimeForEventDrive,
  estimateTextTokens,
} from '../scenario-ai'

const makeRegime = (name: string) => {
  const regime = createEmptyRegimeData('#123456')
  regime.国家名称 = name
  return regime
}

describe('estimateTextTokens', () => {
  it('中文按字、其余按字符估算', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('你好')).toBe(2)
    expect(estimateTextTokens('abcdefghij')).toBe(3)
    expect(estimateTextTokens('你好abcdefghij')).toBe(5)
  })
})

describe('buildScenarioAiPayload', () => {
  it('精简空字段、重复指标，并把领土按级别汇总成编号', () => {
    const scenario = createEmptyScenarioData()
    scenario.剧本名称 = '精简测试'
    scenario.开局时间 = '公元 192 年'

    const regime = makeRegime('甲国')
    regime.AI控制 = true
    regime.政体 = '共和制'
    regime.领导人 = [
      { 姓名: '甲', 职位: '总统', 简介: '简介' },
      { 姓名: '', 职位: '', 简介: '' },
    ]
    regime.初始国家力量 = { 政治稳定: 10, 经济发展: 20, 国际影响: 30 }
    regime.国家指标 = { 政治稳定: -10, 经济发展: -20, 国际影响: -30 }
    regime.领土 = [
      { 名称: 'A', 代码: 'AA-1', 国家代码: 'AAA', 级别: 'adm1' },
      { 名称: 'B', 代码: 'AA-2', 国家代码: 'AAA', 级别: 'adm1' },
      { 名称: 'C', 代码: '110000', 国家代码: 'CHN', 级别: 'adm2' },
      {
        名称: '自定义',
        区域: [
          {
            vertices: [
              [1, 2],
              [2, 2],
              [2, 3],
            ],
          },
        ],
      },
    ]
    scenario.存在国家 = [regime]

    const payload = buildScenarioAiPayload(scenario)
    const parsed = JSON.parse(payload.text)

    expect(payload.chars).toBeGreaterThan(0)
    expect(payload.tokens).toBeGreaterThan(0)
    expect(payload.regimeCount).toBe(1)
    expect(payload.territoryCount).toBe(4)

    const compact = parsed.存在国家[0]
    expect(compact.国家名称).toBe('甲国')
    expect(compact.国家指标).toBeUndefined()
    expect(compact.初始国家力量).toEqual({ 政治稳定: 10, 经济发展: 20, 国际影响: 30 })
    expect(compact.领导人).toHaveLength(1)
    expect(compact.领导人[0]).toEqual({ 姓名: '甲', 职位: '总统', 简介: '简介' })
    expect(compact.领土).toEqual({
      总数: 4,
      adm1: ['AA-1', 'AA-2'],
      adm2: ['110000'],
      自定义区域数量: 1,
    })
    expect(compact.人口).toBeUndefined()
    expect(compact.政治制度).toBeUndefined()
    expect(compact.城市).toBeUndefined()
  })

  it('空剧本也能生成可用 payload', () => {
    const scenario = createEmptyScenarioData()
    scenario.存在国家 = []
    const payload = buildScenarioAiPayload(scenario)

    expect(payload.regimeCount).toBe(0)
    expect(payload.territoryCount).toBe(0)
    expect(payload.tokens).toBeGreaterThan(0)
    expect(JSON.parse(payload.text).存在国家).toEqual([])
  })
})

describe('compactRegimeForEventDrive', () => {
  it('保留 AI控制 与国家指标，并继续按级别汇总领土', () => {
    const regime = makeRegime('甲国')
    regime.AI控制 = false
    regime.初始国家力量 = { 政治稳定: 1, 经济发展: 2, 国际影响: 3 }
    regime.领土 = [{ 名称: 'A', 代码: 'AA-1', 国家代码: 'AAA', 级别: 'adm1' }]

    const compact = compactRegimeForEventDrive(regime)

    expect(compact.国家名称).toBe('甲国')
    expect(compact.AI控制).toBe(false)
    expect(compact.初始国家力量).toEqual({ 政治稳定: 1, 经济发展: 2, 国际影响: 3 })
    expect(compact.国家指标).toEqual({ 政治稳定: 1, 经济发展: 2, 国际影响: 3 })
    expect(compact.领土).toEqual({ 总数: 1, adm1: ['AA-1'] })
  })
})
