import type {
  CityData,
  CountryData,
  CountryIndicatorData,
  DefinitionData,
  EthnicGroupData,
  Party,
  PoliticalAllianceData,
  PoliticalData,
  PopulationData,
  TechnologyData,
} from '@/types/country'
import { createEmptyCountryData } from '@/types/country'

/** 判断一个未知值是否为普通对象（排除 null 与数组）。 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** 安全读取对象字段。 */
export const getProp = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const asFiniteNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const readStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {}
  }

  const result: Record<string, string> = {}

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()
    if (!key) {
      continue
    }

    if (typeof rawValue === 'string') {
      result[key] = rawValue
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = String(rawValue)
    }
  }

  return result
}

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

const readRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

const clampIndicator = (value: number): number => Math.max(-100, Math.min(100, value))

const readIndicator = (value: unknown): number =>
  Math.round(clampIndicator(asFiniteNumber(value)) * 100) / 100

/** 把任意输入归一化成合法的三国力指标，并裁剪到 -100 ~ 100。 */
export const normalizeCountryIndicators = (value: unknown): CountryIndicatorData => {
  const record = isRecord(value) ? value : {}

  return {
    政治稳定: readIndicator(record.政治稳定),
    经济发展: readIndicator(record.经济发展),
    国际影响: readIndicator(record.国际影响),
  }
}

const normalizePopulation = (value: unknown): PopulationData => {
  const record = isRecord(value) ? value : {}

  return {
    总数: Math.max(0, asFiniteNumber(record.总数)),
    种族比例: readStringRecord(record.种族比例),
  }
}

const normalizeCity = (value: Record<string, unknown>): CityData => ({
  名称: asString(value.名称),
  简介: asString(value.简介),
  人口比例: readStringRecord(value.人口比例),
  经济状况: asString(value.经济状况),
  政治状况: asString(value.政治状况),
})

const normalizeDefinition = (value: Record<string, unknown>): DefinitionData => ({
  术语: asString(value.术语),
  定义: asString(value.定义),
})

const normalizeParty = (value: Record<string, unknown>): Party => ({
  名称: asString(value.名称),
  简介: asString(value.简介),
  主要人物: readStringRecord(value.主要人物),
})

const normalizeAlliance = (value: Record<string, unknown>): PoliticalAllianceData => ({
  联盟名称: asString(value.联盟名称),
  政党: readRecordArray(value.政党).map(normalizeParty),
})

const normalizePolitical = (value: unknown): PoliticalData => {
  const record = isRecord(value) ? value : {}

  return {
    政党: readRecordArray(record.政党).map(normalizeParty),
    联盟: readRecordArray(record.联盟).map(normalizeAlliance),
    政治状况: readStringRecord(record.政治状况),
  }
}

const normalizeTechnology = (value: unknown): TechnologyData => {
  const record = isRecord(value) ? value : {}

  return {
    重工业: asString(record.重工业),
    轻工业: asString(record.轻工业),
    第三产业: asString(record.第三产业),
    航天工业: asString(record.航天工业),
    信息产业: asString(record.信息产业),
    农业: asString(record.农业),
  }
}

const normalizeEthnicGroup = (value: Record<string, unknown>): EthnicGroupData => ({
  名称: asString(value.名称),
  简介: asString(value.简介),
  文化: asString(value.文化),
  宗教: asString(value.宗教),
})

/**
 * 把任意 JSON 归一化成完整的 `CountryData`。
 *
 * - 缺失字段用空字符串 / 0 / [] / {} 占位；
 * - 数组里的非法项会被丢弃，避免一个坏字段拖垮整份档案；
 * - 数值型等级被裁剪到 -100 ~ 100，防止导入后推演数值越界。
 */
export function normalizeCountryData(value: unknown): CountryData {
  if (!isRecord(value)) {
    return createEmptyCountryData()
  }

  const record = value
  const military = isRecord(record.武装力量) ? record.武装力量 : {}

  return {
    国家名称: asString(record.国家名称),
    AI控制: typeof record.AI控制 === 'boolean' ? record.AI控制 : false,
    国家指标: normalizeCountryIndicators(record.国家指标),
    人口: normalizePopulation(record.人口),
    政治制度: asString(record.政治制度),
    经济状况: asString(record.经济状况),
    城市: readRecordArray(record.城市).map(normalizeCity),
    国歌: asString(record.国歌),
    货币: asString(record.货币),
    武装力量: {
      名称: asString(military.名称),
      规模: asString(military.规模),
      兵役制度: asString(military.兵役制度),
      军种: readStringArray(military.军种),
    },
    武装力量法: asString(record.武装力量法),
    宗教信仰: asString(record.宗教信仰),
    名词定义: readRecordArray(record.名词定义).map(normalizeDefinition),
    政治: normalizePolitical(record.政治),
    科技: normalizeTechnology(record.科技),
    种族: readRecordArray(record.种族).map(normalizeEthnicGroup),
  }
}
