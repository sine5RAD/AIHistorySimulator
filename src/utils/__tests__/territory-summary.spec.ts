import { describe, expect, it } from 'vitest'

import {
  countTerritoryBuckets,
  readTerritoryBuckets,
  summarizeTerritoryBrief,
  summarizeTerritoryDetail,
  writeTerritoryBuckets,
} from '../territory-summary'

const compactTerritory = {
  总数: 4,
  country: ['AAA'],
  adm1: ['AA-1', 'AA-2'],
  adm2: ['AAA:25037944B10938266492584'],
}

describe('简报与详情的区别', () => {
  it('简报只给国家级代码与各级数量', () => {
    expect(summarizeTerritoryBrief(compactTerritory)).toEqual({
      总数: 4,
      国家级代码: ['AAA'],
      adm1数量: 2,
      adm2数量: 1,
    })
  })

  it('详情额外给出 adm1 的实际编号与名称，adm2 仍只给数量', () => {
    expect(summarizeTerritoryDetail(compactTerritory, { 'AA-1': '甲州' })).toEqual({
      总数: 4,
      国家级代码: ['AAA'],
      adm1数量: 2,
      adm2数量: 1,
      adm1: [{ 编号: 'AA-1', 名称: '甲州' }, { 编号: 'AA-2' }],
    })
  })

  it('纯国家级领土的详情与简报一致', () => {
    const territory = { 总数: 1, country: ['POL'] }

    expect(summarizeTerritoryDetail(territory)).toEqual(summarizeTerritoryBrief(territory))
  })
})

describe('编号级别识别', () => {
  it('没写级别的三字母编号按国家级处理', () => {
    const buckets = readTerritoryBuckets({ 总数: 2, unknown: ['NRU', 'AF_KAN'] })

    expect(buckets.codes.country).toEqual(['NRU'])
    expect(buckets.codes.unknown).toEqual(['AF_KAN'])
    expect(writeTerritoryBuckets(buckets)).toEqual({
      总数: 2,
      country: ['NRU'],
      unknown: ['AF_KAN'],
    })
  })

  it('无法归类的编号只给数量，不丢总数', () => {
    expect(summarizeTerritoryBrief({ 总数: 2, unknown: ['AF_KAN', 'N/A'] })).toEqual({
      总数: 2,
      未分类数量: 2,
    })
  })

  it('详情给出未分类编号，简报只给数量', () => {
    const territory = { 总数: 1, unknown: ['AF_KAN'] }

    expect(summarizeTerritoryBrief(territory)).toEqual({ 总数: 1, 未分类数量: 1 })
    expect(summarizeTerritoryDetail(territory)).toEqual({
      总数: 1,
      未分类数量: 1,
      未分类: ['AF_KAN'],
    })
  })

  it('兼容完整领土数组写法', () => {
    const buckets = readTerritoryBuckets([
      { 名称: '甲国', 代码: 'AAA', 级别: 'country' },
      { 名称: '甲州', 代码: 'AA-1', 级别: 'adm1' },
      { 名称: '甲市', 代码: '110000', 级别: 'adm2' },
      { 名称: '手绘', 区域: [{ vertices: [[1, 2]] }] },
    ])

    expect(countTerritoryBuckets(buckets)).toBe(4)
    expect(
      summarizeTerritoryDetail([
        { 名称: '甲国', 代码: 'AAA', 级别: 'country' },
        { 名称: '甲州', 代码: 'AA-1', 级别: 'adm1' },
        { 名称: '甲市', 代码: '110000', 级别: 'adm2' },
        { 名称: '手绘', 区域: [{ vertices: [[1, 2]] }] },
      ]),
    ).toEqual({
      总数: 4,
      国家级代码: ['AAA'],
      adm1数量: 1,
      adm2数量: 1,
      自定义区域数量: 1,
      adm1: [{ 编号: 'AA-1' }],
    })
  })
})

describe('空值处理', () => {
  it('没有编号也没有自定义区域时返回 null', () => {
    expect(summarizeTerritoryBrief(undefined)).toBeNull()
    expect(summarizeTerritoryDetail(undefined)).toBeNull()
    expect(summarizeTerritoryBrief({})).toBeNull()
  })

  it('只有总数 0 时保留结构并返回 0', () => {
    expect(summarizeTerritoryBrief({ 总数: 0 })).toEqual({ 总数: 0 })
    expect(summarizeTerritoryDetail({ 总数: 0 })).toEqual({ 总数: 0 })
  })

  it('优先沿用存储的总数', () => {
    // 历史数据里 总数 与编号条数可能不一致，摘要不应擅自改写
    expect(summarizeTerritoryBrief({ 总数: 3, adm1: ['AA-1', 'AA-2'] })?.总数).toBe(3)
  })
})
