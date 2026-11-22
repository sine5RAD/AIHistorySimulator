import { isRecord } from './country-data'
import { CODE_LEVELS, countTerritoryBuckets, readTerritoryBuckets } from './territory-summary'

/**
 * AI 的「静默查询领土」：模型只输出一个查询请求，客户端在本地把
 * 地区名称与编号的对照表塞回去，再让模型继续本轮推演。
 *
 * 这样模型不必把上万个编号背进上下文，也不必凭空编造编号；
 * 查询本身不落在聊天窗口，也不改动任何数据。
 */

/** 一次允许的查询轮次上限，防止模型反复查询卡死。 */
export const MAX_TERRITORY_QUERY_ROUNDS = 2

/** 单次最多返回几个政权的对照表。 */
export const MAX_QUERY_REGIMES = 4

/** 单次最多返回多少条编号；超出会截断并提示用关键词缩小范围。 */
export const MAX_QUERY_CODES = 300

export interface TerritoryQueryRequest {
  政权: string[]
  关键词?: string
}

export interface TerritoryQueryReplyOptions {
  /** 编号 → 名称，缺省时只给编号。 */
  names?: Record<string, string>
  maxRegimes?: number
  maxCodes?: number
}

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readNameList = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []

  return list.map(readText).filter((name) => name.length > 0)
}

/**
 * 解析 `{ "查询领土": ... }`。
 *
 * 兼容几种写法：
 * - `{ "查询领土": { "政权": ["甲国"], "关键词": "北部" } }`（推荐）
 * - `{ "查询领土": ["甲国", "乙国"] }`
 * - `{ "查询领土": "甲国" }`
 *
 * 不是查询请求时返回 null。
 */
export function parseTerritoryQuery(parsed: unknown): TerritoryQueryRequest | null {
  if (!isRecord(parsed) || !('查询领土' in parsed)) {
    return null
  }

  const raw = parsed.查询领土
  const names = isRecord(raw)
    ? [...readNameList(raw.政权), ...readNameList(raw.国家)]
    : readNameList(raw)

  if (!names.length) {
    return null
  }

  const keyword = isRecord(raw) ? readText(raw.关键词) : ''
  const uniqueNames = Array.from(new Set(names)).slice(0, MAX_QUERY_REGIMES)

  return {
    政权: uniqueNames,
    ...(keyword ? { 关键词: keyword } : {}),
  }
}

/** 判断一段回复是不是纯查询请求（用于决定是否要再跑一轮）。 */
export const isTerritoryQueryPayload = (parsed: unknown): boolean =>
  parseTerritoryQuery(parsed) !== null

interface TerritoryQueryEntry {
  编号: string
  名称?: string
}

const collectEntries = (
  territory: unknown,
  names: Record<string, string>,
  keyword: string,
  maxCodes: number,
): { entries: TerritoryQueryEntry[]; truncated: boolean } => {
  const buckets = readTerritoryBuckets(territory)
  const entries: TerritoryQueryEntry[] = []
  let truncated = false

  for (const level of CODE_LEVELS) {
    for (const code of buckets.codes[level]) {
      const label = names[code]?.trim() ?? ''
      const haystack = `${code} ${label}`.toLowerCase()

      if (keyword && !haystack.includes(keyword)) {
        continue
      }

      entries.push(label && label !== code ? { 编号: code, 名称: label } : { 编号: code })

      if (entries.length >= maxCodes) {
        truncated = true
        return { entries, truncated }
      }
    }
  }

  return { entries, truncated }
}

/**
 * 生成回给模型的对照表消息。
 *
 * 输出结构尽量贴近平常的「详细档案」，模型可以直接照抄 `编号`。
 */
export function buildTerritoryQueryReply(
  request: TerritoryQueryRequest,
  countries: readonly unknown[],
  options: TerritoryQueryReplyOptions = {},
): string {
  const names = options.names ?? {}
  const maxRegimes = options.maxRegimes ?? MAX_QUERY_REGIMES
  const maxCodes = options.maxCodes ?? MAX_QUERY_CODES
  const keyword = request.关键词?.trim().toLowerCase() ?? ''
  const results: Array<Record<string, unknown>> = []
  let truncated = false

  for (const requestName of request.政权.slice(0, maxRegimes)) {
    const index = countries.findIndex(
      (country) => isRecord(country) && readText(country.国家名称) === requestName,
    )

    if (index < 0) {
      results.push({ 国家名称: requestName, 未找到: true })
      continue
    }

    const record = countries[index] as Record<string, unknown>
    const { entries, truncated: hitLimit } = collectEntries(record.领土, names, keyword, maxCodes)

    truncated = truncated || hitLimit

    results.push({
      国家名称: requestName,
      总数: countTerritoryBuckets(readTerritoryBuckets(record.领土)),
      匹配数: entries.length,
      ...(entries.length ? { 领土: entries } : {}),
    })
  }

  const header = keyword
    ? `这是你查询的领土对照表（政权：${request.政权.join('、')}；关键词：${request.关键词}）。查询没有改动任何数据。`
    : `这是你查询的领土对照表（政权：${request.政权.join('、')}）。查询没有改动任何数据。`

  const lines = [header]

  if (truncated) {
    lines.push(`单次最多返回 ${maxCodes} 条，结果已截断；可以换一个更精确的“关键词”再查。`)
  }

  lines.push(
    '',
    '```json',
    JSON.stringify({ 国家: results }, null, 2),
    '```',
    '',
    '请直接基于这些编号完成本轮的推演与“政权变更”输出，不要再次查询同一批政权，也不要编造未出现的编号。',
  )

  return lines.join('\n')
}
