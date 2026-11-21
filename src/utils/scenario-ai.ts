import type { RegimeData, ScenarioData } from '@/types/scenario'
import { isRecord } from './country-data'

const CJK_PATTERN = /[\u3400-\u9fff]/g

/**
 * 粗略估算 token，用来在发送前判断是否明显超出上下文。
 * 中文按约 1 token/字、其余按约 3.5 字符/token 计，偏保守。
 */
export const estimateTextTokens = (text: string): number => {
  const cjk = text.match(CJK_PATTERN)?.length ?? 0
  const nonCjk = Math.max(0, text.length - cjk)
  return Math.ceil(cjk + nonCjk / 3.5)
}

const isEmptyValue = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return true
  }

  if (typeof value === 'string') {
    return value.trim().length === 0
  }

  if (typeof value === 'number') {
    return !Number.isFinite(value)
  }

  if (typeof value === 'boolean') {
    return false
  }

  if (Array.isArray(value)) {
    return value.length === 0 || value.every(isEmptyValue)
  }

  if (isRecord(value)) {
    return Object.values(value).every(isEmptyValue)
  }

  return false
}

/** 递归去掉空字符串、空数组、空对象，保留 0 / false 这类有意义的值。 */
const pruneEmpty = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty).filter((item) => !isEmptyValue(item))
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {}

    for (const [key, item] of Object.entries(value)) {
      const pruned = pruneEmpty(item)
      if (!isEmptyValue(pruned)) {
        result[key] = pruned
      }
    }

    return result
  }

  return value
}

const compactRegime = (regime: RegimeData): Record<string, unknown> => {
  const compact: Record<string, unknown> = {
    国家名称: regime.国家名称,
    AI控制: regime.AI控制,
    代表色: regime.代表色,
    政体: regime.政体,
    领导人: regime.领导人
      .filter((leader) => leader.姓名.trim() || leader.职位.trim() || leader.简介.trim())
      .map((leader) => ({
        姓名: leader.姓名,
        职位: leader.职位,
        简介: leader.简介,
      })),
    初始国家力量: { ...regime.初始国家力量 },
  }

  const population: Record<string, unknown> = {}

  if (regime.人口.总数 > 0) {
    population.总数 = regime.人口.总数
  }
  if (!isEmptyValue(regime.人口.种族比例)) {
    population.种族比例 = regime.人口.种族比例
  }
  if (!isEmptyValue(population)) {
    compact.人口 = population
  }

  const passthroughFields = [
    '政治制度',
    '经济状况',
    '城市',
    '国歌',
    '货币',
    '武装力量',
    '武装力量法',
    '宗教信仰',
    '名词定义',
    '政治',
    '科技',
    '种族',
  ] as const

  for (const field of passthroughFields) {
    const value = (regime as unknown as Record<string, unknown>)[field]
    if (!isEmptyValue(value)) {
      compact[field] = value
    }
  }

  // 领土只保留编号并按住级别分组，省略 4,000 多条名称/国家代码。
  const territoriesByLevel: Record<string, string[]> = {}
  let customAreaCount = 0

  for (const territory of regime.领土) {
    const code = territory.代码?.trim()

    if (code) {
      const level = territory.级别 ?? 'unknown'
      const codes = territoriesByLevel[level] ?? []
      codes.push(code)
      territoriesByLevel[level] = codes
    } else if (territory.区域?.length) {
      customAreaCount += 1
    }
  }

  const territories: Record<string, unknown> = { 总数: regime.领土.length }
  for (const [level, codes] of Object.entries(territoriesByLevel)) {
    territories[level] = codes
  }
  if (customAreaCount > 0) {
    territories.自定义区域数量 = customAreaCount
  }
  compact.领土 = territories

  // 国家指标与初始国家力量同值，精简版省略国家指标；空字段也统一省略。
  return pruneEmpty(compact) as Record<string, unknown>
}

export interface ScenarioAiPayload {
  text: string
  chars: number
  tokens: number
  regimeCount: number
  territoryCount: number
}

/**
 * 生成给「剧本审校 AI」的精简 JSON。
 *
 * 与完整剧本 JSON 的差异：
 * - 省略空字段、空数组、空对象；
 * - 省略与初始国家力量重复的国家指标；
 * - 领土按级别分组，只保留编号，省略名称、国家代码和多边形顶点。
 */
export function buildScenarioAiPayload(scenario: ScenarioData): ScenarioAiPayload {
  const payload = {
    剧本名称: scenario.剧本名称,
    开局时间: scenario.开局时间,
    存在国家: scenario.存在国家.map(compactRegime),
  }
  const text = JSON.stringify(payload)

  return {
    text,
    chars: text.length,
    tokens: estimateTextTokens(text),
    regimeCount: scenario.存在国家.length,
    territoryCount: scenario.存在国家.reduce((total, regime) => total + regime.领土.length, 0),
  }
}
