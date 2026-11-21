import { describe, expect, it } from 'vitest'

import { createEmptyRegimeData } from '@/types/scenario'
import {
  applyCountryArchive,
  createNextRegime,
  createRegimeColor,
  createScenarioFromWorldData,
  getTerritoryKey,
  normalizeHexColor,
  normalizeRegimeData,
  normalizeScenarioData,
  normalizeTerritoryList,
  serializeScenarioForExport,
  toColorInputValue,
  toCountryData,
} from '../scenario-data'

const indicator = (政治稳定: number, 经济发展: number, 国际影响: number) => ({
  政治稳定,
  经济发展,
  国际影响,
})

describe('normalizeHexColor / toColorInputValue', () => {
  it('展开三位十六进制并小写', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc')
    expect(normalizeHexColor('  #123456  ')).toBe('#123456')
    expect(normalizeHexColor('red')).toBeNull()
  })

  it('把 rgb / hsl 转成颜色选择器可用的十六进制', () => {
    expect(toColorInputValue('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(toColorInputValue('hsl(0 100% 50%)')).toBe('#ff0000')
    expect(toColorInputValue('not-a-color')).toBe('#3b82f6')
  })

  it('生成的默认代表色是合法十六进制', () => {
    expect(createRegimeColor(0)).toMatch(/^#[0-9a-f]{6}$/)
    expect(createRegimeColor(1)).not.toBe(createRegimeColor(0))
  })
})

describe('normalizeScenarioData', () => {
  it('读取完整剧本结构，并同步初始国家力量与国家指标', () => {
    const scenario = normalizeScenarioData({
      剧本名称: '测试剧本',
      开局时间: '1945-09-02T09:00',
      存在国家: [
        {
          国家名称: '法兰西共和国',
          代表色: '#123ABC',
          政体: '共和制',
          领导人: ['夏尔·戴高乐', { 姓名: '勒内·科蒂', 职位: '总统', 简介: '末任第四共和国总统' }],
          领土: [
            { 名称: '法国本土', 代码: 'fra' },
            {
              名称: '科西嘉',
              区域: [
                {
                  vertices: [
                    [8.7, 42.1],
                    [9.4, 42.1],
                    [9.4, 41.3],
                  ],
                },
              ],
            },
          ],
          初始国家力量: indicator(20, 30, 40),
          国家指标: indicator(-100, 0, 0),
          人口: { 总数: 40000000, 种族比例: { 法兰西人: '90%' } },
        },
      ],
    })

    expect(scenario.剧本名称).toBe('测试剧本')
    expect(scenario.开局时间).toBe('1945-09-02T09:00')
    expect(scenario.存在国家).toHaveLength(1)

    const regime = scenario.存在国家[0]
    expect(regime?.代表色).toBe('#123abc')
    expect(regime?.政体).toBe('共和制')
    expect(regime?.国家指标).toEqual(indicator(20, 30, 40))
    expect(regime?.初始国家力量).toEqual(indicator(20, 30, 40))
    expect(regime?.人口.总数).toBe(40000000)
    expect(regime?.领导人).toHaveLength(2)
    expect(regime?.领导人[0]).toEqual({ 姓名: '夏尔·戴高乐', 职位: '', 简介: '' })
    expect(regime?.领导人[1]?.职位).toBe('总统')
    expect(regime?.领土[0]?.代码).toBe('FRA')
    expect(regime?.领土[1]?.区域).toHaveLength(1)
  })

  it('接受文章转 JSON 的单份 CountryData', () => {
    const regime = normalizeRegimeData({
      国家名称: '测试国',
      国家指标: indicator(-10, 5, 50),
      政治制度: '联邦制',
      人口: { 总数: 123, 种族比例: { 测试族: '100%' } },
      城市: [
        {
          名称: '测试城',
          简介: '简介',
          人口比例: { 测试族: '100%' },
          经济状况: '良好',
          政治状况: '稳定',
        },
      ],
    })

    expect(regime.国家名称).toBe('测试国')
    expect(regime.政体).toBe('联邦制')
    expect(regime.初始国家力量).toEqual(indicator(-10, 5, 50))
    expect(regime.国家指标).toEqual(indicator(-10, 5, 50))
    expect(regime.城市[0]?.名称).toBe('测试城')
    expect(regime.代表色).toMatch(/^#[0-9a-f]{6}$/)
    expect(regime.领土).toEqual([])
  })

  it('接受 { countries }、单国对象与空值', () => {
    const fromWorldShape = normalizeScenarioData({
      countries: [{ 国家名称: 'A国' }, { 国家名称: 'B国' }],
    })
    expect(fromWorldShape.存在国家.map((regime) => regime.国家名称)).toEqual(['A国', 'B国'])

    const single = normalizeScenarioData({ 国家名称: 'C国', 政治制度: '君主制' })
    expect(single.存在国家).toHaveLength(1)
    expect(single.存在国家[0]?.政体).toBe('君主制')

    const empty = normalizeScenarioData(null)
    expect(empty.存在国家).toEqual([])
    expect(empty.开局时间).not.toBe('')
  })

  it('接受「名称 -> 政权」的对象映射', () => {
    const scenario = normalizeScenarioData({
      开局时间: '公元 192 年',
      存在国家: {
        罗马: { 代表色: '#d64545', 政体: '共和制' },
        帕提亚: { 代表色: '#3b82f6', 政体: '君主制' },
      },
    })

    expect(scenario.存在国家).toHaveLength(2)
    expect(scenario.存在国家[0]?.国家名称).toBe('罗马')
    expect(scenario.开局时间).toBe('公元 192 年')
  })

  it('兼容领导人为单个对象或「姓名 -> 职位」映射', () => {
    const single = normalizeRegimeData({
      国家名称: '单人国',
      领导人: { 姓名: '甲', 职位: '总统' },
    })
    expect(single.领导人).toEqual([{ 姓名: '甲', 职位: '总统', 简介: '' }])

    const mapped = normalizeRegimeData({
      国家名称: '多人国',
      领导人: {
        甲: '总统',
        乙: { 职位: '首相', 简介: '简介' },
      },
    })
    expect(mapped.领导人).toEqual([
      { 姓名: '甲', 职位: '总统', 简介: '' },
      { 姓名: '乙', 职位: '首相', 简介: '简介' },
    ])
  })
})

describe('normalizeTerritoryList', () => {
  it('支持数组、国土对象与名称映射', () => {
    const list = normalizeTerritoryList([
      '仅名称',
      { 名称: '带代码', 代码: 'usa' },
      {
        名称: '带区域',
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
    ])

    expect(list[0]).toEqual({ 名称: '仅名称' })
    expect(list[1]?.代码).toBe('USA')
    expect(list[1]?.级别).toBe('country')
    expect(list[2]?.区域?.[0]?.vertices).toHaveLength(3)

    const fromObject = normalizeTerritoryList({
      法国: {
        areas: [
          {
            vertices: [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
          },
        ],
      },
    })
    expect(fromObject[0]?.名称).toBe('法国')
    expect(fromObject[0]?.区域).toHaveLength(1)
  })

  it('保留下级行政区的地区编号、所属国家与级别', () => {
    const regime = normalizeRegimeData({
      国家名称: '德国',
      领土: [
        { 名称: '巴伐利亚', 代码: 'DE-BY', 国家代码: 'DEU', 级别: 'adm1' },
        'DE-BW',
        { 名称: '柏林', 代码: 'DE-BE' },
        { 名称: '中国某市', 代码: '110000', 国家代码: 'CHN', 级别: 'adm2' },
      ],
    })

    expect(regime.领土[0]).toEqual({
      名称: '巴伐利亚',
      代码: 'DE-BY',
      国家代码: 'DEU',
      级别: 'adm1',
    })
    expect(regime.领土[1]).toEqual({ 名称: 'DE-BW', 代码: 'DE-BW' })
    expect(regime.领土[2]?.代码).toBe('DE-BE')
    expect(regime.领土[2]?.级别).toBeUndefined()
    expect(regime.领土[3]).toEqual({
      名称: '中国某市',
      代码: '110000',
      国家代码: 'CHN',
      级别: 'adm2',
    })
  })

  it('N/A 用国家代码区分，不同国家的同名编号不会互相去重', () => {
    const regime = normalizeRegimeData({
      国家名称: '托管地',
      领土: [
        { 名称: 'Abyei PCA', 代码: 'N/A', 国家代码: 'SDN', 级别: 'adm1' },
        { 名称: 'Keserwan-Jbeil', 代码: 'N/A', 国家代码: 'LBN', 级别: 'adm1' },
        { 名称: 'Abyei 重复条目', 代码: 'N/A', 国家代码: 'SDN', 级别: 'adm1' },
      ],
    })

    expect(regime.领土).toHaveLength(2)
    expect(regime.领土.map((territory) => territory.国家代码)).toEqual(['SDN', 'LBN'])
    expect(getTerritoryKey({ 名称: 'Abyei PCA', 代码: 'N/A', 国家代码: 'SDN' })).toBe('N/A|SDN')
    expect(getTerritoryKey({ 名称: '科索沃', 代码: 'KOS' })).toBe('KOS|KOS')
  })
})

describe('createScenarioFromWorldData', () => {
  it('读取世界生成的国家、颜色与国土并转换墨卡托坐标', () => {
    const scenario = createScenarioFromWorldData(
      {
        countries: [
          {
            国家名称: 'A国',
            国家指标: indicator(1, 2, 3),
            代表色: '#000000',
          },
        ],
        landMap: {
          A国: {
            areas: [
              {
                vertices: [
                  [0.5, 0.5],
                  [0.6, 0.5],
                  [0.6, 0.4],
                ],
              },
            ],
          },
        },
        countryColorMap: { A国: 'hsl(120 60% 50%)' },
      },
      '世界A',
    )

    expect(scenario.存在国家).toHaveLength(1)
    const regime = scenario.存在国家[0]
    expect(regime?.国家名称).toBe('A国')
    expect(regime?.代表色).toBe('hsl(120 60% 50%)')
    expect(regime?.领土).toHaveLength(1)

    const firstVertex = regime?.领土[0]?.区域?.[0]?.vertices[0]
    expect(firstVertex?.[0]).toBeCloseTo(0, 4)
    expect(firstVertex?.[1]).toBeCloseTo(0, 4)
  })

  it('国家列表为空时从 landMap 生成政权', () => {
    const scenario = createScenarioFromWorldData(
      {
        landMap: {
          无档案国: {
            areas: [
              {
                vertices: [
                  [0.2, 0.3],
                  [0.3, 0.3],
                  [0.3, 0.2],
                ],
              },
            ],
          },
        },
      },
      '仅有国土',
    )

    expect(scenario.存在国家).toHaveLength(1)
    expect(scenario.存在国家[0]?.国家名称).toBe('无档案国')
  })
})

describe('serialize / applyCountryArchive / toCountryData', () => {
  it('导出后仍可重新解析，且不丢失领土与领导人', () => {
    const original = normalizeScenarioData({
      剧本名称: '往返测试',
      开局时间: '2000-01-01T00:00',
      存在国家: [
        {
          国家名称: '往返国',
          代表色: '#abcdef',
          政体: '共和制',
          领导人: [{ 姓名: '甲', 职位: '总统', 简介: '简介' }],
          领土: [{ 名称: '本土', 代码: 'FRA' }],
          初始国家力量: indicator(1, 2, 3),
        },
      ],
    })

    const exported = serializeScenarioForExport(original)
    const restored = normalizeScenarioData(JSON.parse(JSON.stringify(exported)))

    expect(restored.剧本名称).toBe('往返测试')
    expect(restored.存在国家[0]?.代表色).toBe('#abcdef')
    expect(restored.存在国家[0]?.领导人).toEqual([{ 姓名: '甲', 职位: '总统', 简介: '简介' }])
    expect(restored.存在国家[0]?.领土).toEqual([{ 名称: '本土', 代码: 'FRA', 级别: 'country' }])
  })

  it('导入纯 CountryData 时保留代表色、政体、领土与领导人', () => {
    const regime = createEmptyRegimeData('#abcdef')
    regime.国家名称 = '旧国'
    regime.政体 = '君主制'
    regime.领土 = [{ 名称: '旧土', 代码: 'FRA' }]
    regime.领导人 = [{ 姓名: '老王', 职位: '国王', 简介: '' }]

    const next = applyCountryArchive(regime, {
      国家名称: '新国',
      国家指标: indicator(10, -20, 30),
      政治制度: '共和制',
    })

    expect(next.国家名称).toBe('新国')
    expect(next.代表色).toBe('#abcdef')
    expect(next.政体).toBe('君主制')
    expect(next.领土).toEqual([{ 名称: '旧土', 代码: 'FRA' }])
    expect(next.领导人).toEqual([{ 姓名: '老王', 职位: '国王', 简介: '' }])
    expect(next.初始国家力量).toEqual(indicator(10, -20, 30))
    expect(next.国家指标).toEqual(indicator(10, -20, 30))
  })

  it('toCountryData 会去掉剧本层字段', () => {
    const regime = createEmptyRegimeData('#abcdef')
    regime.国家名称 = '档案国'
    regime.代表色 = '#abcdef'
    regime.政体 = '共和制'
    regime.初始国家力量 = indicator(1.1, 2.2, 3.3)

    const country = toCountryData(regime)

    expect(country.国家名称).toBe('档案国')
    expect(country.国家指标).toEqual(indicator(1.1, 2.2, 3.3))
    expect('代表色' in country).toBe(false)
    expect('政体' in country).toBe(false)
    expect('领导人' in country).toBe(false)
    expect('领土' in country).toBe(false)
    expect('初始国家力量' in country).toBe(false)
  })
})

describe('AI控制（玩家操控标记）', () => {
  it('导出剧本时保留 AI控制，重新导入后不变', () => {
    const scenario = normalizeScenarioData({
      剧本名称: '控制方式',
      开局时间: '2000-01-01T00:00',
      存在国家: [
        { 国家名称: '玩家国', AI控制: false },
        { 国家名称: 'AI国', AI控制: true },
      ],
    })

    const exported = serializeScenarioForExport(scenario)

    expect(exported.存在国家[0]?.AI控制).toBe(false)
    expect(exported.存在国家[1]?.AI控制).toBe(true)

    const restored = normalizeScenarioData(JSON.parse(JSON.stringify(exported)))
    expect(restored.存在国家[0]?.AI控制).toBe(false)
    expect(restored.存在国家[1]?.AI控制).toBe(true)
  })

  it('新建政权默认由 AI 操控', () => {
    expect(createNextRegime(0).AI控制).toBe(true)
    expect(createNextRegime(3).AI控制).toBe(true)
  })
})
