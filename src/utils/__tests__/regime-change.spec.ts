import { describe, expect, it } from 'vitest'

import type { CountryIndicatorData } from '@/types/country'

import {
  applyRegimeChanges,
  normalizeRegimeChange,
  pickRegimeColor,
  readTerritoryBuckets,
  splitAssistantChangePayload,
  validateRegimeChange,
  writeTerritoryBuckets,
} from '../regime-change'

const createCountries = (): unknown[] => [
  {
    国家名称: '中国',
    AI控制: true,
    代表色: '#d64545',
    政体: '共和制',
    国家指标: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
    初始国家力量: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
    领土: { 总数: 3, country: ['CHN'], adm1: ['CN-11', 'CN-12'] },
  },
  {
    国家名称: '美国',
    AI控制: false,
    代表色: '#3b82f6',
    政体: '总统制',
    国家指标: { 政治稳定: 40, 经济发展: 50, 国际影响: 60 },
    初始国家力量: { 政治稳定: 40, 经济发展: 50, 国际影响: 60 },
    领土: { 总数: 1, country: ['USA'] },
  },
  {
    国家名称: '波兰共和国',
    AI控制: true,
    代表色: '#8a8f98',
    政体: '人民民主共和国',
    国家指标: { 政治稳定: 18, 经济发展: -5, 国际影响: 32 },
    初始国家力量: { 政治稳定: 18, 经济发展: -5, 国际影响: 32 },
    领土: { 总数: 3, country: ['POL'], adm1: ['PL-14', 'PL-12'] },
  },
]

const createIndicators = (): Record<string, CountryIndicatorData> => ({
  中国: { 政治稳定: 10, 经济发展: 20, 国际影响: 30 },
  美国: { 政治稳定: 40, 经济发展: 50, 国际影响: 60 },
  波兰共和国: { 政治稳定: 18, 经济发展: -5, 国际影响: 32 },
})

const createColorMap = (): Record<string, string> => ({
  中国: '#d64545',
  美国: '#3b82f6',
  波兰共和国: '#8a8f98',
})

const run = (changes: unknown[], options = {}) => {
  const countries = createCountries()
  const result = applyRegimeChanges(
    countries,
    createIndicators(),
    createColorMap(),
    changes,
    options,
  )

  return { countries, result }
}

const names = (countries: unknown[]): string[] =>
  countries.map((country) => (country as Record<string, unknown>).国家名称 as string)

describe('领土摘要读写', () => {
  it('读取紧凑对象写法并保留级别', () => {
    const buckets = readTerritoryBuckets({
      总数: 5,
      country: ['CHN'],
      adm1: ['CN-11', 'CN-12'],
      adm2: ['CN-1101'],
      自定义区域数量: 1,
    })

    expect(buckets.codes.country).toEqual(['CHN'])
    expect(buckets.codes.adm1).toEqual(['CN-11', 'CN-12'])
    expect(buckets.codes.adm2).toEqual(['CN-1101'])
    expect(buckets.customAreas).toBe(1)
  })

  it('兼容数组写法，并按 级别 分组', () => {
    const buckets = readTerritoryBuckets([
      { 名称: '中国本土', 代码: 'CHN', 级别: 'country' },
      { 名称: '北京', 代码: 'CN-11', 级别: 'adm1' },
      { 名称: '手绘国土', 区域: [{ vertices: [[0, 0]] }] },
      { 名称: '重复', 代码: 'CN-11', 级别: 'adm1' },
    ])

    expect(buckets.codes.country).toEqual(['CHN'])
    expect(buckets.codes.adm1).toEqual(['CN-11'])
    expect(buckets.customAreas).toBe(1)
  })

  it('写回时重算总数，空级别不落字段', () => {
    const summary = writeTerritoryBuckets({
      codes: { country: ['POL'], adm1: [], adm2: [], adm3: [], unknown: [] },
      customAreas: 0,
    })

    expect(summary).toEqual({ 总数: 1, country: ['POL'] })
  })

  it('未知级别归到 unknown，不丢编号', () => {
    const buckets = readTerritoryBuckets({ 总数: 1, ADM4: ['X-1'] })

    expect(buckets.codes.unknown).toEqual(['X-1'])
    expect(writeTerritoryBuckets(buckets)).toEqual({ 总数: 1, unknown: ['X-1'] })
  })
})

describe('解析 AI 返回的变更', () => {
  it('裸数组按指标变更处理（保持旧格式兼容）', () => {
    const payload = splitAssistantChangePayload([
      { 国家名称: '波兰共和国', 描述: '选举', 国家指标: {} },
    ])

    expect(payload.indicatorEntries).toHaveLength(1)
    expect(payload.regimeChanges).toHaveLength(0)
  })

  it('容器对象拆出指标变更与政权变更', () => {
    const payload = splitAssistantChangePayload({
      指标变更: [{ 国家名称: '中国', 国家指标: {} }],
      政权变更: [{ 类型: '建立', 政权名称: '东德' }],
    })

    expect(payload.indicatorEntries).toHaveLength(1)
    expect(payload.regimeChanges).toHaveLength(1)
  })

  it('只有政权变更时不会掉进指标流程', () => {
    const payload = splitAssistantChangePayload({ 类型: '灭亡', 政权名称: '中国' })

    expect(payload.indicatorEntries).toHaveLength(0)
    expect(payload.regimeChanges).toHaveLength(1)
  })

  it('政权变更写成单个对象也能接住', () => {
    const payload = splitAssistantChangePayload({
      指标变更: [],
      政权变更: { 类型: '更名', 政权名称: '中国', 新名称: '中华共和国' },
    })

    expect(payload.regimeChanges).toHaveLength(1)
  })

  it('普通 JSON 不会被当成政权变更', () => {
    const payload = splitAssistantChangePayload({ foo: 'bar' })

    expect(payload.regimeChanges).toHaveLength(0)
    expect(payload.indicatorEntries).toEqual([{ foo: 'bar' }])
  })

  it('类型不认识的对象不会进入政权变更', () => {
    expect(normalizeRegimeChange({ 类型: '吞并', 政权名称: '中国' })).toBeNull()
    expect(normalizeRegimeChange(null)).toBeNull()
    expect(normalizeRegimeChange('建立')).toBeNull()
  })
})

describe('建立政权', () => {
  it('新建政权写入国家数组、指标表与颜色表', () => {
    const { countries, result } = run(
      [
        {
          类型: '建立',
          政权名称: '东德',
          政体: '社会主义共和制',
          原因: '苏占区宣布建国',
          国家指标: { 政治稳定: 20, 经济发展: 10, 国际影响: 5 },
          领土: { country: ['DEU'], adm1: ['DE-BE'] },
        },
      ],
      { nextColor: () => '#123456' },
    )

    expect(result.failed).toEqual([])
    expect(result.applied).toEqual([
      '已建立政权：东德（政体=社会主义共和制；领土 2 条；原因：苏占区宣布建国）',
    ])
    expect(names(countries)).toEqual(['中国', '美国', '波兰共和国', '东德'])

    const created = countries[3] as Record<string, unknown>
    expect(created.AI控制).toBe(true)
    expect(created.代表色).toBe('#123456')
    expect(created.国家指标).toEqual({ 政治稳定: 20, 经济发展: 10, 国际影响: 5 })
    expect(created.初始国家力量).toEqual({ 政治稳定: 20, 经济发展: 10, 国际影响: 5 })
    expect(created.领土).toEqual({ 总数: 2, country: ['DEU'], adm1: ['DE-BE'] })

    expect(result.indicators.东德).toEqual({ 政治稳定: 20, 经济发展: 10, 国际影响: 5 })
    expect(result.colorMap.东德).toBe('#123456')
  })

  it('重名时拒绝建立', () => {
    const { countries, result } = run([{ 类型: '建立', 政权名称: '中国' }])

    expect(result.applied).toEqual([])
    expect(result.failed).toEqual(['政权「中国」已存在，不能重复建立'])
    expect(names(countries)).toHaveLength(3)
  })

  it('带 原政权 时把领土从来源划走', () => {
    const { countries, result } = run(
      [
        {
          类型: '建立',
          政权名称: '北波兰',
          原政权: '波兰共和国',
          国家指标: { 政治稳定: 5, 经济发展: 0, 国际影响: 10 },
          领土: { country: ['POL'], adm1: ['PL-14'] },
        },
      ],
      { nextColor: () => '#abcdef' },
    )

    expect(result.failed).toEqual([])

    const source = countries[2] as Record<string, unknown>
    expect(source.领土).toEqual({ 总数: 1, adm1: ['PL-12'] })

    const created = countries[3] as Record<string, unknown>
    expect(created.领土).toEqual({ 总数: 2, country: ['POL'], adm1: ['PL-14'] })
  })

  it('原政权不存在时拒绝', () => {
    const { result } = run([{ 类型: '建立', 政权名称: '北波兰', 原政权: '不存在的国家' }])

    expect(result.failed).toEqual(['建立「北波兰」的 原政权「不存在的国家」不存在'])
  })
})

describe('灭亡政权', () => {
  it('缺省继承时领土变为无主，同时清理指标与颜色', () => {
    const { countries, result } = run([{ 类型: '灭亡', 政权名称: '波兰共和国' }])

    expect(result.applied).toEqual(['已灭亡政权：波兰共和国（领土变为无主）'])
    expect(names(countries)).toEqual(['中国', '美国'])
    expect(result.indicators.波兰共和国).toBeUndefined()
    expect(result.colorMap.波兰共和国).toBeUndefined()
  })

  it('继承国接管全部领土', () => {
    const { countries, result } = run([
      { 类型: '灭亡', 政权名称: '波兰共和国', 继承: '继承国', 继承国: ['中国'] },
    ])

    expect(result.failed).toEqual([])

    const china = countries[0] as Record<string, unknown>
    expect(china.领土).toEqual({
      总数: 6,
      country: ['CHN', 'POL'],
      adm1: ['CN-11', 'CN-12', 'PL-14', 'PL-12'],
    })
    expect(names(countries)).toEqual(['中国', '美国'])
  })

  it('领土分配可以按编号分割给多个继承国', () => {
    const { countries, result } = run([
      {
        类型: '灭亡',
        政权名称: '波兰共和国',
        继承: '继承国',
        继承国: ['中国', '美国'],
        领土分配: {
          中国: { country: ['POL'] },
          美国: { adm1: ['PL-14', 'PL-12'] },
        },
      },
    ])

    expect(result.failed).toEqual([])
    expect((countries[0] as Record<string, unknown>).领土).toEqual({
      总数: 4,
      country: ['CHN', 'POL'],
      adm1: ['CN-11', 'CN-12'],
    })
    expect((countries[1] as Record<string, unknown>).领土).toEqual({
      总数: 3,
      country: ['USA'],
      adm1: ['PL-14', 'PL-12'],
    })
  })

  it('多个继承国且没给 领土分配 时按顺序轮转分配', () => {
    const { countries, result } = run([
      { 类型: '灭亡', 政权名称: '波兰共和国', 继承: '继承国', 继承国: ['中国', '美国'] },
    ])

    expect(result.failed).toEqual([])
    expect(result.applied[0]).toContain('中国 分得 2 条')
    expect(result.applied[0]).toContain('美国 分得 1 条')

    // 波兰的 3 条编号（POL / PL-14 / PL-12）交替分给两国
    expect((countries[0] as Record<string, unknown>).领土).toEqual({
      总数: 5,
      country: ['CHN', 'POL'],
      adm1: ['CN-11', 'CN-12', 'PL-12'],
    })
    expect((countries[1] as Record<string, unknown>).领土).toEqual({
      总数: 2,
      country: ['USA'],
      adm1: ['PL-14'],
    })
  })

  it('拒绝灭亡玩家操控的政权，手动操作可以放行', () => {
    const blocked = run([{ 类型: '灭亡', 政权名称: '美国' }])

    expect(blocked.result.applied).toEqual([])
    expect(blocked.result.failed).toEqual(['「美国」由玩家操控，AI 不能灭亡它'])
    expect(names(blocked.countries)).toContain('美国')

    const allowed = run([{ 类型: '灭亡', 政权名称: '美国' }], { allowPlayerRegime: true })

    expect(allowed.result.failed).toEqual([])
    expect(names(allowed.countries)).toEqual(['中国', '波兰共和国'])
  })

  it('领土分配只能分配被灭政权真正持有的编号', () => {
    const { result } = run([
      {
        类型: '灭亡',
        政权名称: '波兰共和国',
        继承: '无主',
        领土分配: { 中国: { country: ['USA', 'POL'] } },
      },
    ])

    expect(result.applied[0]).toContain('中国 接管 1 条')
  })

  it('继承国不存在时拒绝', () => {
    const { result } = run([
      { 类型: '灭亡', 政权名称: '波兰共和国', 继承: '继承国', 继承国: ['火星共和国'] },
    ])

    expect(result.failed).toEqual(['灭亡「波兰共和国」的 继承国「火星共和国」不存在'])
  })

  it('不存在的政权无法灭亡', () => {
    const { result } = run([{ 类型: '灭亡', 政权名称: '不存在的国家' }])

    expect(result.failed).toEqual(['政权「不存在的国家」不存在'])
  })

  it('不能把世界上的最后一个政权灭亡', () => {
    const countries = [{ 国家名称: '中国', AI控制: true, 领土: { 总数: 0 } }]
    const result = applyRegimeChanges(countries, {}, {}, [{ 类型: '灭亡', 政权名称: '中国' }], {
      allowPlayerRegime: true,
    })

    expect(result.failed).toEqual(['「中国」是世界上的最后一个政权，不能灭亡'])
    expect(countries).toHaveLength(1)
  })
})

describe('政权更名', () => {
  it('更名同步迁移指标与颜色', () => {
    const { countries, result } = run([
      { 类型: '更名', 政权名称: '中国', 新名称: '中华人民共和国' },
    ])

    expect(result.applied).toEqual(['已更名：中国 → 中华人民共和国'])
    expect(names(countries)).toEqual(['中华人民共和国', '美国', '波兰共和国'])
    expect(result.indicators.中华人民共和国).toEqual({
      政治稳定: 10,
      经济发展: 20,
      国际影响: 30,
    })
    expect(result.indicators.中国).toBeUndefined()
    expect(result.colorMap.中华人民共和国).toBe('#d64545')
    expect(result.colorMap.中国).toBeUndefined()
  })

  it('重名或缺少新名称时拒绝', () => {
    const duplicated = run([{ 类型: '更名', 政权名称: '中国', 新名称: '美国' }])
    expect(duplicated.result.failed).toEqual(['政权「美国」已存在，不能改名成重名'])

    const missing = run([{ 类型: '更名', 政权名称: '中国' }])
    expect(missing.result.failed).toEqual(['更名「中国」时必须提供 新名称'])
  })

  it('拒绝更名玩家操控的政权', () => {
    const { result } = run([{ 类型: '更名', 政权名称: '美国', 新名称: '美利坚合众国' }])

    expect(result.failed).toEqual(['「美国」由玩家操控，AI 不能更名它'])
  })
})

describe('划转领土', () => {
  it('把指定编号从来源政权划给接收方', () => {
    const { countries, result } = run([
      { 类型: '领土', 政权名称: '中国', 来源政权: '波兰共和国', 领土: { adm1: ['PL-14'] } },
    ])

    expect(result.applied).toEqual(['已划转领土：波兰共和国 → 中国（1 条）'])
    expect((countries[0] as Record<string, unknown>).领土).toEqual({
      总数: 4,
      country: ['CHN'],
      adm1: ['CN-11', 'CN-12', 'PL-14'],
    })
    expect((countries[2] as Record<string, unknown>).领土).toEqual({
      总数: 2,
      country: ['POL'],
      adm1: ['PL-12'],
    })
  })

  it('省略 领土 时划走来源政权的全部疆域', () => {
    const { countries, result } = run([{ 类型: '领土', 政权名称: '中国', 来源政权: '波兰共和国' }])

    expect(result.applied).toEqual(['已划转领土：波兰共和国 → 中国（3 条）'])
    expect((countries[0] as Record<string, unknown>).领土).toEqual({
      总数: 6,
      country: ['CHN', 'POL'],
      adm1: ['CN-11', 'CN-12', 'PL-14', 'PL-12'],
    })
    expect((countries[2] as Record<string, unknown>).领土).toEqual({ 总数: 0 })
  })

  it('只划走来源政权真正拥有的编号，不会凭空造出领土', () => {
    const { result } = run([
      {
        类型: '领土',
        政权名称: '中国',
        来源政权: '波兰共和国',
        领土: { country: ['USA', 'POL'], adm1: ['CN-11'] },
      },
    ])

    expect(result.applied).toEqual(['已划转领土：波兰共和国 → 中国（1 条）'])
  })

  it('来源政权或接收方不存在时拒绝', () => {
    const missingSource = run([{ 类型: '领土', 政权名称: '中国', 来源政权: '火星共和国' }])
    expect(missingSource.result.failed).toEqual(['划转领土的 来源政权「火星共和国」不存在'])

    const missingTarget = run([{ 类型: '领土', 政权名称: '火星共和国', 来源政权: '中国' }])
    expect(missingTarget.result.failed).toEqual(['政权「火星共和国」不存在'])
  })

  it('不能把玩家操控政权的领土划走', () => {
    const { result } = run([{ 类型: '领土', 政权名称: '中国', 来源政权: '美国' }])

    expect(result.failed).toEqual(['「美国」由玩家操控，AI 不能把它的领土划走'])
  })

  it('地区名称会按 nameIndex 反查成编号', () => {
    const countries = createCountries()
    const result = applyRegimeChanges(
      countries,
      createIndicators(),
      createColorMap(),
      [{ 类型: '领土', 政权名称: '中国', 来源政权: '波兰共和国', 领土: { adm1: ['小波兰省'] } }],
      { nameIndex: { 小波兰省: 'PL-14' } },
    )

    expect(result.applied).toEqual(['已划转领土：波兰共和国 → 中国（1 条）'])
    expect((countries[0] as Record<string, unknown>).领土).toEqual({
      总数: 4,
      country: ['CHN'],
      adm1: ['CN-11', 'CN-12', 'PL-14'],
    })
  })

  it('编号写错级别时按来源政权真实级别归位', () => {
    const countries = createCountries()
    const result = applyRegimeChanges(countries, createIndicators(), createColorMap(), [
      { 类型: '领土', 政权名称: '中国', 来源政权: '波兰共和国', 领土: { country: ['PL-14'] } },
    ])

    expect(result.applied).toEqual(['已划转领土：波兰共和国 → 中国（1 条）'])
    expect((countries[0] as Record<string, unknown>).领土).toEqual({
      总数: 4,
      country: ['CHN'],
      adm1: ['CN-11', 'CN-12', 'PL-14'],
    })
  })
})

describe('新政权必须拥有领土', () => {
  it('政权更替：先建立再灭亡，领土完整转给新政权', () => {
    const { countries, result } = run([
      {
        类型: '建立',
        政权名称: '波兰人民共和国',
        政体: '社会主义共和制',
        国家指标: { 政治稳定: 5, 经济发展: 0, 国际影响: 1 },
      },
      { 类型: '灭亡', 政权名称: '波兰共和国', 继承: '继承国', 继承国: ['波兰人民共和国'] },
    ])

    expect(result.failed).toEqual([])
    expect(result.warnings).toEqual([])
    expect(names(countries)).toEqual(['中国', '美国', '波兰人民共和国'])
    expect((countries[2] as Record<string, unknown>).领土).toEqual({
      总数: 3,
      country: ['POL'],
      adm1: ['PL-14', 'PL-12'],
    })
  })

  it('新政权没有领土时给出提示', () => {
    const { result } = run([{ 类型: '建立', 政权名称: '流亡政府' }])

    expect(result.warnings).toEqual([
      '新政权「流亡政府」还没有领土：可以让 AI 用「领土」变更划入，或在「政权管理」里灭亡一个政权并选它作继承国。',
    ])
  })

  it('事后补一条 领土 变更就不会再提示', () => {
    const { result } = run([
      { 类型: '建立', 政权名称: '东德' },
      { 类型: '领土', 政权名称: '东德', 来源政权: '中国', 领土: { adm1: ['CN-11'] } },
    ])

    expect(result.failed).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('世界本身没有领土数据时不提示', () => {
    const countries: unknown[] = [{ 国家名称: '中国', AI控制: true }]
    const result = applyRegimeChanges(countries, {}, {}, [{ 类型: '建立', 政权名称: '东德' }])

    expect(result.warnings).toEqual([])
  })
})

describe('批量应用', () => {
  it('单条失败不影响其余变更', () => {
    const { countries, result } = run([
      { 类型: '灭亡', 政权名称: '不存在的国家' },
      { 类型: '建立', 政权名称: '东德', 国家指标: { 政治稳定: 1, 经济发展: 2, 国际影响: 3 } },
    ])

    expect(result.applied).toEqual(['已建立政权：东德（暂无领土）'])
    expect(result.failed).toEqual(['政权「不存在的国家」不存在'])
    expect(names(countries)).toContain('东德')
  })

  it('无效条目会单独报错', () => {
    const { result } = run([{ 类型: '未知动作', 政权名称: 'X' }])

    expect(result.failed).toEqual(['无效条目：缺少可识别的 类型（建立/灭亡/更名/领土）'])
  })

  it('先灭后建的顺序会被尊重', () => {
    const { countries, result } = run([
      { 类型: '灭亡', 政权名称: '波兰共和国' },
      { 类型: '建立', 政权名称: '波兰人民共和国' },
    ])

    expect(result.failed).toEqual([])
    expect(names(countries)).toEqual(['中国', '美国', '波兰人民共和国'])
  })
})

describe('代表色分配', () => {
  it('避开已用的颜色', () => {
    const color = pickRegimeColor(['#d64545', '#3b82f6', '#8a8f98'])

    expect(color).toMatch(/^#[0-9a-f]{6}$/)
    expect(['#d64545', '#3b82f6', '#8a8f98']).not.toContain(color)
  })

  it('默认不覆盖其他国家已有的颜色', () => {
    const { result } = run([{ 类型: '建立', 政权名称: '东德' }])

    const palette = Object.values(result.colorMap)
    expect(new Set(palette).size).toBe(palette.length)
  })
})

describe('校验入口', () => {
  it('政权名称为空时直接失败', () => {
    const validation = validateRegimeChange({ 类型: '建立', 政权名称: '  ' }, createCountries())

    expect(validation).toEqual({ ok: false, reason: '无效条目：缺少 政权名称' })
  })
})
