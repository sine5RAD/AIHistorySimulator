import { describe, expect, it } from 'vitest'

import {
  buildBriefCountries,
  buildDetailCountries,
  summarizeTerritory,
  toBriefCountry,
  toDetailCountry,
} from '../event-drive-context'

const compactCountry = {
  国家名称: '甲国',
  AI控制: true,
  政体: '共和制',
  政治制度: '议会制',
  经济状况: '战后繁荣',
  国家指标: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
  初始国家力量: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
  人口: { 总数: 1_000_000, 种族比例: { 甲族: '100%' } },
  领导人: [
    { 姓名: '甲某人', 职位: '总统', 简介: '开局总统' },
    { 姓名: '', 职位: '', 简介: '' },
  ],
  领土: {
    总数: 3,
    country: ['AAA'],
    adm1: ['AA-1', 'AA-2'],
    adm2: ['110000'],
  },
  城市: [{ 名称: '甲城', 简介: '首都', 人口比例: {}, 经济状况: '', 政治状况: '' }],
  科技: { 重工业: '中等', 轻工业: '', 第三产业: '', 航天工业: '', 信息产业: '', 农业: '' },
  种族: [{ 名称: '甲族', 简介: '', 文化: '', 宗教: '' }],
}

describe('toBriefCountry', () => {
  it('只保留简报字段，领导人去掉简介，领土只留摘要', () => {
    const brief = toBriefCountry(compactCountry)

    expect(brief).toEqual({
      国家名称: '甲国',
      AI控制: true,
      国家指标: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
      政体: '共和制',
      政治制度: '议会制',
      经济状况: '战后繁荣',
      领导人: [{ 姓名: '甲某人', 职位: '总统' }],
      人口总数: 1_000_000,
      领土: {
        总数: 3,
        国家级代码: ['AAA'],
        adm1数量: 2,
        adm2数量: 1,
      },
    })
    expect(brief.城市).toBeUndefined()
    expect(brief.科技).toBeUndefined()
    expect(JSON.stringify(brief)).not.toContain('开局总统')
  })
})

describe('toDetailCountry', () => {
  it('保留完整精简档案，但把领土换成摘要', () => {
    const detail = toDetailCountry(compactCountry)

    expect(detail.城市).toEqual(compactCountry.城市)
    expect(detail.科技).toEqual(compactCountry.科技)
    expect(detail.领导人).toEqual(compactCountry.领导人)
    expect(detail.领土).toEqual({
      总数: 3,
      国家级代码: ['AAA'],
      adm1数量: 2,
      adm2数量: 1,
    })
    expect(JSON.stringify(detail)).toContain('开局总统')
  })
})

describe('summarizeTerritory', () => {
  it('兼容完整领土数组', () => {
    expect(
      summarizeTerritory([
        { 名称: '甲国', 代码: 'AAA', 级别: 'country' },
        { 名称: '甲州', 代码: 'AA-1', 级别: 'adm1' },
        { 名称: '甲市', 代码: '110000', 级别: 'adm2' },
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
      ]),
    ).toEqual({
      总数: 4,
      国家级代码: ['AAA'],
      adm1数量: 1,
      adm2数量: 1,
      自定义区域数量: 1,
    })
  })

  it('无法识别时返回 null', () => {
    expect(summarizeTerritory(undefined)).toBeNull()
    expect(summarizeTerritory({})).toBeNull()
  })
})

describe('buildBriefCountries / buildDetailCountries', () => {
  const countries = [compactCountry, { 国家名称: '乙国', AI控制: false }, null, '无效']

  it('过滤非法项并按名称生成详情', () => {
    expect(buildBriefCountries(countries)).toHaveLength(2)
    expect(buildDetailCountries(countries, ['乙国'])).toEqual([{ 国家名称: '乙国', AI控制: false }])
  })
})
