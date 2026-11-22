import { isRecord } from './country-data'
import { summarizeTerritoryBrief, summarizeTerritoryDetail } from './territory-summary'

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * 简报用的领土摘要。
 *
 * 只保留总数、国家级代码与各级数量；具体地区编号太长，
 * 逐条塞进每轮请求会随政权数量线性膨胀。
 */
export const summarizeTerritory = summarizeTerritoryBrief

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

/**
 * 按需详情：保留完整精简档案，并把领土换成「详情版」摘要。
 *
 * 与简报版的关键区别是**多给 `adm1` 的实际编号**：
 * AI 只有在详情档里见过编号，才能在 `政权变更` 的 `领土` 字段里填出真实编号。
 */
export const toDetailCountry = (
  country: Record<string, unknown>,
  nameIndex?: Record<string, string>,
): Record<string, unknown> => {
  const { 领土: territoryValue, ...rest } = country
  const territory = summarizeTerritoryDetail(territoryValue, nameIndex)

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
  nameIndex?: Record<string, string>,
): Array<Record<string, unknown>> => {
  const names = new Set(matchedNames.map((name) => name.trim()).filter((name) => name.length > 0))

  if (!names.size) {
    return []
  }

  return countries
    .filter((country): country is Record<string, unknown> => isRecord(country))
    .filter((country) => names.has(readText(country.国家名称)))
    .map((country) => toDetailCountry(country, nameIndex))
}
