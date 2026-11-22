import { describe, expect, it } from 'vitest'

import { normalizeScenarioData } from '../scenario-data'
import { createScenarioTransferPayload, parseScenarioTransferPayload } from '../scenario-transfer'

const createScenario = () =>
  normalizeScenarioData({
    剧本名称: '测试剧本',
    开局时间: '1947-01-01T00:00',
    存在国家: [
      {
        国家名称: '甲国',
        AI控制: false,
        代表色: '#123abc',
        政体: '共和制',
        初始国家力量: { 政治稳定: 12, 经济发展: -3, 国际影响: 45 },
        领导人: [{ 姓名: '甲某人', 职位: '总统', 简介: '开局总统' }],
        领土: [{ 名称: '甲国本土', 代码: 'AAA', 国家代码: 'AAA', 级别: 'country' }],
      },
      {
        国家名称: '乙国',
        AI控制: true,
        代表色: '#456def',
        政体: '君主制',
      },
    ],
  })

describe('createScenarioTransferPayload', () => {
  it('把剧本序列化成可交接的导出结构', () => {
    const payload = createScenarioTransferPayload(createScenario(), '2026-11-21T12:00:00.000Z')

    expect(payload.source).toBe('scenario-editor')
    expect(payload.sentAt).toBe('2026-11-21T12:00:00.000Z')
    expect(payload.scenario.剧本名称).toBe('测试剧本')
    expect(payload.scenario.开局时间).toBe('1947-01-01T00:00')
    expect(payload.scenario.存在国家).toHaveLength(2)

    const [first, second] = payload.scenario.存在国家

    expect(first?.国家名称).toBe('甲国')
    expect(first?.AI控制).toBe(false)
    expect(first?.政体).toBe('共和制')
    expect(first?.领导人[0]?.姓名).toBe('甲某人')
    expect(first?.领土[0]?.代码).toBe('AAA')
    expect(first?.初始国家力量).toEqual({ 政治稳定: 12, 经济发展: -3, 国际影响: 45 })
    expect(first?.国家指标).toEqual(first?.初始国家力量)
    expect(second?.AI控制).toBe(true)
  })
})

describe('parseScenarioTransferPayload', () => {
  it('解析交接包并保留剧本字段', () => {
    const payload = createScenarioTransferPayload(createScenario(), '2026-11-21T12:00:00.000Z')
    const parsed = parseScenarioTransferPayload(JSON.parse(JSON.stringify(payload)))

    expect(parsed?.source).toBe('scenario-editor')
    expect(parsed?.sentAt).toBe('2026-11-21T12:00:00.000Z')
    expect(parsed?.scenario.剧本名称).toBe('测试剧本')
    expect(parsed?.scenario.存在国家.map((regime) => regime.国家名称)).toEqual(['甲国', '乙国'])
    expect(parsed?.scenario.存在国家[0]?.AI控制).toBe(false)
  })

  it('也接受直接粘贴的剧本 JSON', () => {
    const parsed = parseScenarioTransferPayload(createScenario())

    expect(parsed?.scenario.剧本名称).toBe('测试剧本')
    expect(parsed?.scenario.存在国家).toHaveLength(2)
    expect(parsed?.sentAt).toBeTruthy()
  })

  it('拒绝空剧本和非法值', () => {
    expect(parseScenarioTransferPayload(null)).toBeNull()
    expect(parseScenarioTransferPayload('剧本')).toBeNull()
    expect(parseScenarioTransferPayload({})).toBeNull()
    expect(
      parseScenarioTransferPayload({
        source: 'scenario-editor',
        sentAt: '2026-11-21T12:00:00.000Z',
        scenario: { 剧本名称: '空剧本', 开局时间: '1947-01-01', 存在国家: [] },
      }),
    ).toBeNull()
  })
})
