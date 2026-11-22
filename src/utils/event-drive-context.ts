import { isRecord } from './country-data'

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const COUNTED_TERRITORY_LEVELS = ['adm1', 'adm2', 'adm3'] as const

/**
 * 把领土压缩成适合发给模型的摘要。
 *
 * 兼容两种数据：
 * - 事件驱动现在保存的紧凑版 `{ 总数, country: [...], adm1: [...] }`；
 * - 旧存档里的完整数组 `[{ 名称, 代码, 级别, 区域? }]`。
 *
 * 逐条地区编号对叙事推演帮助不大，这里只保留总数、国家级代码与各级数量。
 */
export const summarizeTerritory = (value: unknown): Record<string, unknown> | null => {
  if (Array.isArray(value)) {
    const summary: Record<string, unknown> = { 总数: value.length }
    const countryCodes: string[] = []
    const levelCounts: Record<string, number> = {}
    let customAreaCount = 0

    for (const item of value) {
      if (!isRecord(item)) {
        continue
      }

      const level = readText(item.级别)
      const code = readText(item.代码)
      const hasCustomArea = Array.isArray(item.区域) && item.区域.length > 0

      if (level) {
        levelCounts[level] = (levelCounts[level] ?? 0) + 1
      } else if (hasCustomArea) {
        customAreaCount += 1
      }

      if (code && (level === 'country' || (!level && /^[A-Z]{3}$/i.test(code)))) {
        countryCodes.push(code.toUpperCase())
      }
    }

    if (countryCodes.length) {
      summary.国家级代码 = countryCodes
    }

    for (const level of COUNTED_TERRITORY_LEVELS) {
      const count = levelCounts[level]

      if (count) {
        summary[`${level}数量`] = count
      }
    }

    if (customAreaCount) {
      summary.自定义区域数量 = customAreaCount
    }

    return summary
  }

  if (!isRecord(value)) {
    return null
  }

  const summary: Record<string, unknown> = {}
  const total = readNumber(value.总数)

  if (total !== undefined) {
    summary.总数 = total
  }

  if (Array.isArray(value.country)) {
    const codes = value.country
      .map(readText)
      .filter((code) => code.length > 0)
      .map((code) => code.toUpperCase())

    if (codes.length) {
      summary.国家级代码 = codes
    }
  }

  for (const level of COUNTED_TERRITORY_LEVELS) {
    const list = value[level]

    if (Array.isArray(list) && list.length) {
      summary[`${level}数量`] = list.length
    }
  }

  const customAreaCount = readNumber(value.自定义区域数量)

  if (customAreaCount) {
    summary.自定义区域数量 = customAreaCount
  }

  return Object.keys(summary).length ? summary : null
}

const readLeaderBriefs = (value: unknown): Array<Record<string, string>> => {
  if (!Array.isArray(value)) {
    return []
  }

  const leaders: Array<Record<string, string>> = []

  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }

    const leader: Record<string, string> = {}
    const name = readText(item.姓名)
    const title = readText(item.职位)

    if (name) {
      leader.姓名 = name
    }
    if (title) {
      leader.职位 = title
    }
    if (Object.keys(leader).length) {
      leaders.push(leader)
    }
  }

  return leaders
}

/**
 * 每轮默认发送的国家简报。
 *
 * 只保留叙事与国策推演最常用的字段：名称、控制方式、三国力、政体、政治制度、
 * 经济状况、领导人姓名/职位、人口总数和领土摘要。详细档案用 `toDetailCountry`。
 */
export const toBriefCountry = (country: Record<string, unknown>): Record<string, unknown> => {
  const brief: Record<string, unknown> = {}
  const name = readText(country.国家名称)
  const indicators = isRecord(country.国家指标)
    ? country.国家指标
    : isRecord(country.初始国家力量)
      ? country.初始国家力量
      : null

  if (name) {
    brief.国家名称 = name
  }
  if (typeof country.AI控制 === 'boolean') {
    brief.AI控制 = country.AI控制
  }
  if (indicators) {
    brief.国家指标 = indicators
  }

  for (const key of ['政体', '政治制度', '经济状况'] as const) {
    const value = readText(country[key])

    if (value) {
      brief[key] = value
    }
  }

  const leaders = readLeaderBriefs(country.领导人)

  if (leaders.length) {
    brief.领导人 = leaders
  }

  const populationTotal = isRecord(country.人口) ? readNumber(country.人口.总数) : undefined

  if (populationTotal !== undefined && populationTotal > 0) {
    brief.人口总数 = populationTotal
  }

  const territory = summarizeTerritory(country.领土)

  if (territory) {
    brief.领土 = territory
  }

  return brief
}

/** 按需详情：保留完整精简档案，但把领土换回摘要，避免一次附带上千条地区编号。 */
export const toDetailCountry = (country: Record<string, unknown>): Record<string, unknown> => {
  const { 领土: territoryValue, ...rest } = country
  const territory = summarizeTerritory(territoryValue)

  return territory ? { ...rest, 领土: territory } : rest
}

export const buildBriefCountries = (
  countries: readonly unknown[],
): Array<Record<string, unknown>> =>
  countries
    .filter((country): country is Record<string, unknown> => isRecord(country))
    .map(toBriefCountry)

export const buildDetailCountries = (
  countries: readonly unknown[],
  matchedNames: readonly string[],
): Array<Record<string, unknown>> => {
  const names = new Set(matchedNames.map((name) => name.trim()).filter((name) => name.length > 0))

  if (!names.size) {
    return []
  }

  return countries
    .filter((country): country is Record<string, unknown> => isRecord(country))
    .filter((country) => names.has(readText(country.国家名称)))
    .map(toDetailCountry)
}
