import type { RegimeTerritorySummary } from '@/types/regime'

import { isRecord } from './country-data'

/**
 * 领土编号的读写与两种摘要。
 *
 * 世界包里的领土有三种写法：紧凑对象 `{ 总数, country: [], adm1: [] }`、
 * 完整数组 `[{ 名称, 代码, 级别, 区域? }]`，以及世界生成导出、只有整国代码的写法。
 * 这里统一拆成「按级别分组的编号 + 自定义多边形数量」，再按用途给两种摘要：
 *
 * - **简报版**（每轮都发）：只有国家级代码与各级数量，省 token；
 * - **详情版**（消息提到某国时才发）：把 `adm1` 的实际编号也给出来，
 *   让 AI 在 `政权变更` 的 `领土` 字段里能填真实编号而不是编造。
 *
 * `adm2` 及以下只给数量：1947 剧本里的 `adm2` 是 `AUS:25037944B10938266492584`
 * 这类合成 ID，一条就二十多字符，全量发出去会撑爆上下文。
 */

export const CODE_LEVELS = ['country', 'adm1', 'adm2', 'adm3', 'unknown'] as const

export type TerritoryCodeLevel = (typeof CODE_LEVELS)[number]

/** 按级别拆开的领土编号，加上无法用编号迁移的自定义多边形数量。 */
export interface TerritoryBuckets {
  codes: Record<TerritoryCodeLevel, string[]>
  customAreas: number
}

const COUNTED_LEVELS = ['adm1', 'adm2', 'adm3'] as const

/** 没写 `级别` 的三字母编号按国家要素处理，与「数组写法」的口径一致。 */
const COUNTRY_CODE_PATTERN = /^[A-Z]{3}\*?$/i

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const createEmptyBuckets = (): TerritoryBuckets => ({
  codes: { country: [], adm1: [], adm2: [], adm3: [], unknown: [] },
  customAreas: 0,
})

const pushUniqueCodes = (target: string[], values: readonly unknown[]): void => {
  for (const value of values) {
    const code = readText(value)

    if (code && !target.includes(code)) {
      target.push(code)
    }
  }
}

const toCodeLevel = (rawLevel: string, code: string): TerritoryCodeLevel => {
  const level = rawLevel.trim()

  // 显式的 `unknown` 与缺省级别一样，交给编号形状去判定。
  if (level && level !== 'unknown' && (CODE_LEVELS as readonly string[]).includes(level)) {
    return level as TerritoryCodeLevel
  }

  return COUNTRY_CODE_PATTERN.test(code) ? 'country' : 'unknown'
}

/**
 * 读取领土。
 *
 * 兼容两种写法：
 * - 世界包里的紧凑对象 `{ 总数, country: [], adm1: [], 自定义区域数量 }`；
 * - 旧存档 / 世界生成导出的数组 `[{ 名称, 代码, 级别, 区域? }]`。
 */
export function readTerritoryBuckets(value: unknown): TerritoryBuckets {
  const buckets = createEmptyBuckets()

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) {
        continue
      }

      const code = readText(item.代码)

      if (code) {
        pushUniqueCodes(buckets.codes[toCodeLevel(readText(item.级别), code)], [code])
      } else if (Array.isArray(item.区域) && item.区域.length > 0) {
        buckets.customAreas += 1
      }
    }

    return buckets
  }

  if (!isRecord(value)) {
    return buckets
  }

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()

    if (key === '总数') {
      continue
    }

    if (key === '自定义区域数量') {
      const count = readNumber(rawValue)
      buckets.customAreas = count === undefined ? 0 : Math.max(0, count)
      continue
    }

    if (Array.isArray(rawValue)) {
      for (const rawCode of rawValue) {
        const code = readText(rawCode)

        if (code) {
          pushUniqueCodes(buckets.codes[toCodeLevel(key, code)], [code])
        }
      }
    }
  }

  return buckets
}

/** 统计领土条目数（编号条数 + 自定义区域数），与世界包的 `总数` 口径一致。 */
export const countTerritoryBuckets = (buckets: TerritoryBuckets): number =>
  CODE_LEVELS.reduce((total, level) => total + buckets.codes[level].length, 0) + buckets.customAreas

/** 把按级别拆开的编号写回紧凑结构。 */
export function writeTerritoryBuckets(buckets: TerritoryBuckets): RegimeTerritorySummary {
  const summary: RegimeTerritorySummary = { 总数: countTerritoryBuckets(buckets) }

  for (const level of CODE_LEVELS) {
    const codes = buckets.codes[level]

    if (codes.length) {
      summary[level] = [...codes]
    }
  }

  if (buckets.customAreas > 0) {
    summary.自定义区域数量 = buckets.customAreas
  }

  return summary
}

const buildBaseSummary = (value: unknown, buckets: TerritoryBuckets): Record<string, unknown> => {
  // 紧凑数据里存着 `总数`，优先沿用它，避免历史数据的总数与编号条数不一致时被改写。
  const storedTotal = isRecord(value) ? readNumber(value.总数) : undefined
  const summary: Record<string, unknown> = {
    总数: storedTotal ?? countTerritoryBuckets(buckets),
  }
  const countryCodes = buckets.codes.country

  if (countryCodes.length) {
    summary.国家级代码 = [...countryCodes]
  }

  for (const level of COUNTED_LEVELS) {
    const count = buckets.codes[level].length

    if (count) {
      summary[`${level}数量`] = count
    }
  }

  if (buckets.codes.unknown.length) {
    summary.未分类数量 = buckets.codes.unknown.length
  }

  if (buckets.customAreas) {
    summary.自定义区域数量 = buckets.customAreas
  }

  return summary
}

/**
 * 简报版领土摘要（每轮发送）。
 *
 * 只给国家级代码与各级数量：逐条地区编号对叙事帮助不大，
 * 却会让 token 随政权数量线性膨胀。
 */
export function summarizeTerritoryBrief(value: unknown): Record<string, unknown> | null {
  const buckets = readTerritoryBuckets(value)

  if (countTerritoryBuckets(buckets) === 0) {
    return isRecord(value) && readNumber(value.总数) !== undefined
      ? { 总数: readNumber(value.总数) }
      : null
  }

  return buildBaseSummary(value, buckets)
}

/**
 * 详情版领土摘要（只在消息提到该政权时发送）。
 *
 * 额外给出 `adm1` 的编号与名称：编号让 AI 能精确填写 `领土`，
 * 名称让它理解这块地的地理位置（分区时不会瞎挑）。
 */
export function summarizeTerritoryDetail(
  value: unknown,
  nameIndex?: Record<string, string>,
): Record<string, unknown> | null {
  const buckets = readTerritoryBuckets(value)

  if (countTerritoryBuckets(buckets) === 0) {
    return isRecord(value) && readNumber(value.总数) !== undefined
      ? { 总数: readNumber(value.总数) }
      : null
  }

  const summary = buildBaseSummary(value, buckets)
  const adm1 = buckets.codes.adm1

  if (adm1.length) {
    summary.adm1 = adm1.map((code) => {
      const name = nameIndex?.[code]?.trim()

      return name && name !== code ? { 编号: code, 名称: name } : { 编号: code }
    })
  }

  // 归不到标准级别的编号（AF_KAN 这类）也给出来，否则 AI 永远无法指名它们。
  const unclassified = buckets.codes.unknown

  if (unclassified.length) {
    summary.未分类 = [...unclassified]
  }

  return summary
}
