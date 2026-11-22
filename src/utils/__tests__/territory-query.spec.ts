import { describe, expect, it } from 'vitest'

import {
  buildTerritoryQueryReply,
  isTerritoryQueryPayload,
  parseTerritoryQuery,
} from '../territory-query'

const countries = [
  {
    国家名称: '甲国',
    领土: { 总数: 3, adm1: ['AA-1', 'AA-2'], adm2: ['AAA:1'] },
  },
  {
    国家名称: '乙国',
    领土: { 总数: 1, country: ['BBB'] },
  },
]

const names = {
  'AA-1': '甲州一区',
  'AA-2': '甲州二区',
  BBB: '乙国本土',
}

describe('parseTerritoryQuery', () => {
  it('解析推荐写法，带上关键词', () => {
    expect(parseTerritoryQuery({ 查询领土: { 政权: ['甲国'], 关键词: ' 北部 ' } })).toEqual({
      政权: ['甲国'],
      关键词: '北部',
    })
  })

  it('兼容数组与字符串写法，并去重', () => {
    expect(parseTerritoryQuery({ 查询领土: ['甲国', '乙国', '甲国'] })).toEqual({
      政权: ['甲国', '乙国'],
    })
    expect(parseTerritoryQuery({ 查询领土: '甲国' })).toEqual({ 政权: ['甲国'] })
  })

  it('最多只接受 4 个政权', () => {
    const parsed = parseTerritoryQuery({
      查询领土: { 政权: ['a', 'b', 'c', 'd', 'e', 'f'] },
    })

    expect(parsed?.政权).toHaveLength(4)
  })

  it('不是查询就返回 null', () => {
    expect(parseTerritoryQuery({ 政权变更: [] })).toBeNull()
    expect(parseTerritoryQuery({ 查询领土: { 政权: [] } })).toBeNull()
    expect(parseTerritoryQuery({ 查询领土: [] })).toBeNull()
    expect(parseTerritoryQuery(null)).toBeNull()
    expect(isTerritoryQueryPayload({ 查询领土: ['甲国'] })).toBe(true)
    expect(isTerritoryQueryPayload({ 国家指标: [] })).toBe(false)
  })
})

describe('buildTerritoryQueryReply', () => {
  it('给出编号与名称，并带上总数与匹配数', () => {
    const reply = buildTerritoryQueryReply({ 政权: ['甲国'] }, countries, { names })

    expect(reply).toContain('这是你查询的领土对照表')
    expect(reply).toContain('"国家名称": "甲国"')
    expect(reply).toContain('"总数": 3')
    expect(reply).toContain('"匹配数": 3')
    expect(reply).toContain('"编号": "AA-1"')
    expect(reply).toContain('"名称": "甲州一区"')
    expect(reply).toContain('不要再次查询同一批政权')
  })

  it('关键词按名称或编号过滤', () => {
    const reply = buildTerritoryQueryReply({ 政权: ['甲国'], 关键词: '二区' }, countries, {
      names,
    })

    expect(reply).toContain('"匹配数": 1')
    expect(reply).toContain('"编号": "AA-2"')
    expect(reply).not.toContain('"编号": "AA-1"')
  })

  it('没有名称时只给编号', () => {
    const reply = buildTerritoryQueryReply({ 政权: ['甲国'] }, countries)

    expect(reply).toContain('"编号": "AA-1"')
    expect(reply).not.toContain('"名称"')
  })

  it('查不到的政权明确标注', () => {
    const reply = buildTerritoryQueryReply({ 政权: ['火星共和国'] }, countries, { names })

    expect(reply).toContain('"国家名称": "火星共和国"')
    expect(reply).toContain('"未找到": true')
  })

  it('超过上限时截断并提示用关键词', () => {
    const reply = buildTerritoryQueryReply({ 政权: ['甲国'] }, countries, {
      names,
      maxCodes: 1,
    })

    expect(reply).toContain('结果已截断')
    expect(reply).toContain('"匹配数": 1')
  })

  it('一次可以查多个政权', () => {
    const reply = buildTerritoryQueryReply({ 政权: ['甲国', '乙国'] }, countries, { names })

    expect(reply).toContain('"国家名称": "甲国"')
    expect(reply).toContain('"国家名称": "乙国"')
    expect(reply).toContain('"编号": "BBB"')
  })
})
