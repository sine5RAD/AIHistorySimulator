import type { WorldMapFeature } from '@/types/geo'

/** 统一代码大小写；数字编号不受影响。 */
export const normalizeTerritoryCode = (value: string): string => value.trim().toUpperCase()

/**
 * 领土唯一键：代码 + 所属国家。
 *
 * 地图源数据里存在 N/A 这类非唯一代码（Abyei 与 Keserwan-Jbeil），
 * 只按代码匹配会串到同一块领土，因此应用层统一使用该组合键。
 */
export const makeTerritoryKey = (code: string, countryCode = ''): string =>
  `${normalizeTerritoryCode(code)}|${countryCode.trim().toUpperCase()}`

/**
 * 计算地图要素对应的领土编号。
 *
 * - 国家使用 ISO3；
 * - 下级行政区优先使用数据里的人类可读编号（中国 adcode、ISO 3166-2 等）；
 * - 如果数据的 `code` 只是「国家-层级」占位符，则退回 `国家:要素ID`，保证编号唯一。
 */
export function getFeatureTerritoryCode(feature: WorldMapFeature): string {
  const iso = (feature.iso || '').trim().toUpperCase()
  const code = (feature.code || '').trim()

  if (feature.level === 'country') {
    return normalizeTerritoryCode(iso || code || feature.id)
  }

  const genericCode = iso ? `${iso}-${feature.level.toUpperCase()}` : ''
  const codeIsGeneric = code === genericCode
  const codeIsId = code === feature.id

  if (code && !codeIsGeneric && !codeIsId) {
    return normalizeTerritoryCode(code)
  }

  // 中国 DataV 的 adcode 是纯数字，即使和 id 相同也保留，便于阅读。
  if (code && /^\d+$/.test(code)) {
    return normalizeTerritoryCode(code)
  }

  if (iso) {
    return normalizeTerritoryCode(`${iso}:${feature.id}`)
  }

  return normalizeTerritoryCode(code || feature.id)
}

/** 地图要素的唯一键，与剧本领土的 `getTerritoryKey` 对应。 */
export function getFeatureTerritoryKey(feature: WorldMapFeature): string {
  const code = getFeatureTerritoryCode(feature)
  const iso = (feature.iso || '').trim().toUpperCase()
  const inferredCountry = iso || (/^[A-Z]{3}$/.test(code) ? code : '')
  return makeTerritoryKey(code, inferredCountry)
}
