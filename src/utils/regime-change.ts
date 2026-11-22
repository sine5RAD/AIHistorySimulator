import type { CountryIndicatorData } from '@/types/country'
import type {
  AppliedRegimeChange,
  RegimeChangeData,
  RegimeChangeKind,
  RegimeTerritorySummary,
  RegimeSuccession,
} from '@/types/regime'
import { isRegimeChangeKind } from '@/types/regime'
import type { LeaderData } from '@/types/scenario'

import { isRecord, normalizeCountryIndicators } from './country-data'
import { createRegimeColor, toColorInputValue } from './scenario-data'
import {
  CODE_LEVELS,
  countTerritoryBuckets,
  createEmptyBuckets,
  readTerritoryBuckets,
  writeTerritoryBuckets,
  type TerritoryBuckets,
  type TerritoryCodeLevel,
} from './territory-summary'

/**
 * 推演中的政权变更：解析、校验与落库。
 *
 * 世界包里的政权是「精简版」，领土按级别只存编号，
 * 所以建国/灭国本质上是一次**编号搬迁**：
 * - 建立：把 `领土` 里的编号从来源政权划走，交给新政权；
 * - 灭亡：把被灭政权的编号交给继承国，或者直接丢弃（无主）；
 * - 更名：只换名字，领土与指标原地保留；
 * - 领土：在两个已存在的政权之间划转编号。
 *
 * 这里全部是纯函数（只原地改写传入的国家数组，便于复用响应式对象），
 * 方便在 `regime-change.spec.ts` 里逐条验证。
 */

export {
  countTerritoryBuckets,
  readTerritoryBuckets,
  writeTerritoryBuckets,
  type TerritoryBuckets,
  type TerritoryCodeLevel,
} from './territory-summary'

export interface RegimeChangeOptions {
  /**
   * 允许改写玩家操控（`AI控制: false`）的政权。
   *
   * 推演页手动操作时传 true；AI 自动写回时必须为 false，
   * 保证「AI 不能灭玩家国」这条底线不依赖提示词自觉。
   */
  allowPlayerRegime?: boolean
  /** 新建政权时的默认代表色；默认按已用颜色挑一个没被占用的。 */
  nextColor?: (usedColors: readonly string[]) => string
  /**
   * 地区名称 → 编号 的反查表。
   *
   * 有了它，`领土` 里既可以写编号，也可以写地区名（例如「巴伐利亚」），
   * 手写 JSON 和模型的口头描述都能落地。
   */
  nameIndex?: Record<string, string>
}

export interface RegimeChangeValidation {
  ok: boolean
  reason: string
}

export interface RegimeChangeResult {
  /** 已应用的变更摘要，可直接推送到聊天窗口。 */
  applied: string[]
  /** 与 `applied` 一一对应的结构化变更，供时间线等模块使用。 */
  appliedChanges: AppliedRegimeChange[]
  /** 未应用的原因。 */
  failed: string[]
  /** 应用成功但需要玩家注意的事项（例如新政权没有领土）。 */
  warnings: string[]
  /** 变更后的指标表（浅拷贝）。 */
  indicators: Record<string, CountryIndicatorData>
  /** 变更后的颜色表（浅拷贝）。 */
  colorMap: Record<string, string>
}

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const asCountry = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null

/** 政权在世界包里靠 `国家名称` 关联，这里统一读取方式。 */
export const readCountryName = (value: unknown): string =>
  isRecord(value) ? readText(value.国家名称) : ''

/** 找政权下标；找不到返回 -1。 */
export const findCountryIndex = (countries: readonly unknown[], name: string): number =>
  countries.findIndex((country) => readCountryName(country) === name)

const pushUniqueCodes = (target: string[], values: readonly unknown[]): void => {
  for (const value of values) {
    const code = readText(value)

    if (code && !target.includes(code)) {
      target.push(code)
    }
  }
}

/** 把 incoming 合并进 country 的领土（去重）。 */
const mergeTerritory = (country: Record<string, unknown>, incoming: TerritoryBuckets): void => {
  const current = readTerritoryBuckets(country.领土)

  for (const level of CODE_LEVELS) {
    pushUniqueCodes(current.codes[level], incoming.codes[level])
  }

  current.customAreas += incoming.customAreas
  country.领土 = writeTerritoryBuckets(current)
}

/** 从 country 的领土里划走 incoming 的编号与自定义区域。 */
const subtractTerritory = (country: Record<string, unknown>, incoming: TerritoryBuckets): void => {
  const current = readTerritoryBuckets(country.领土)

  for (const level of CODE_LEVELS) {
    const removed = new Set(incoming.codes[level])
    current.codes[level] = current.codes[level].filter((code) => !removed.has(code))
  }

  current.customAreas = Math.max(0, current.customAreas - incoming.customAreas)
  country.领土 = writeTerritoryBuckets(current)
}

/**
 * 求「实际能划走的领土」。
 *
 * - `requested` 为空表示不指定范围，直接划走 `owned` 的全部；
 * - 指定了范围时，编号按来源政权真实持有的级别归位（写错级别也能接住），
 *   也可以直接写地区名称，由 `nameIndex` 反查成编号；
 * - 两边都对不上的值直接丢弃，避免凭空造出领土。
 */
const intersectTerritory = (
  owned: TerritoryBuckets,
  requested: TerritoryBuckets,
  nameIndex: Record<string, string> = {},
): TerritoryBuckets => {
  const result = createEmptyBuckets()

  if (countTerritoryBuckets(requested) === 0) {
    for (const level of CODE_LEVELS) {
      result.codes[level] = [...owned.codes[level]]
    }

    result.customAreas = owned.customAreas
    return result
  }

  const ownedLevels = new Map<string, TerritoryCodeLevel>()

  for (const level of CODE_LEVELS) {
    for (const code of owned.codes[level]) {
      ownedLevels.set(code, level)
    }
  }

  for (const level of CODE_LEVELS) {
    for (const raw of requested.codes[level]) {
      const code = ownedLevels.has(raw) ? raw : nameIndex[raw]
      const ownedLevel = code ? ownedLevels.get(code) : undefined

      if (!code || !ownedLevel) {
        continue
      }

      if (!result.codes[ownedLevel].includes(code)) {
        result.codes[ownedLevel].push(code)
      }
    }
  }

  result.customAreas = Math.min(requested.customAreas, owned.customAreas)
  return result
}

/**
 * 把领土按顺序平均分给若干个继承国。
 *
 * 用于「多国瓜分」但 AI 没给 `领土分配` 的情况：分成几份总比全部塞给第一个
 * 继承国合理，也避免其余继承国什么都没拿到。
 */
const splitTerritory = (buckets: TerritoryBuckets, parts: number): TerritoryBuckets[] => {
  const shares = Array.from({ length: parts }, () => createEmptyBuckets())
  let cursor = 0

  for (const level of CODE_LEVELS) {
    for (const code of buckets.codes[level]) {
      const share = shares[cursor % parts]

      if (share) {
        share.codes[level].push(code)
      }

      cursor += 1
    }
  }

  for (let index = 0; index < buckets.customAreas; index += 1) {
    const share = shares[index % parts]

    if (share) {
      share.customAreas += 1
    }
  }

  return shares
}

/** 按已用颜色挑一个没被占用的代表色；颜色用尽时按数量兜底。 */
export function pickRegimeColor(usedColors: readonly string[]): string {
  const used = new Set(usedColors.map((color) => toColorInputValue(color)))

  for (let index = 0; index < 64; index += 1) {
    const color = createRegimeColor(index)

    if (!used.has(toColorInputValue(color))) {
      return color
    }
  }

  return createRegimeColor(usedColors.length)
}

const normalizeLeaders = (value: unknown): LeaderData[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const leaders: LeaderData[] = []

  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim()

      if (name) {
        leaders.push({ 姓名: name, 职位: '', 简介: '' })
      }
      continue
    }

    if (!isRecord(item)) {
      continue
    }

    const leader: LeaderData = {
      姓名: readText(item.姓名) || readText(item.name) || readText(item.名字),
      职位: readText(item.职位) || readText(item.title),
      简介: readText(item.简介) || readText(item.description),
    }

    if (leader.姓名 || leader.职位) {
      leaders.push(leader)
    }
  }

  return leaders
}

const readSuccession = (value: unknown): RegimeSuccession | undefined => {
  const text = readText(value)

  if (text === '继承国' || text === '无主') {
    return text
  }

  return undefined
}

const readNameList = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []

  return list.map(readText).filter((name) => name.length > 0)
}

/** 把 AI 或手动面板给的任意对象归一化成一条政权变更；类型不认识时返回 null。 */
export function normalizeRegimeChange(value: unknown): RegimeChangeData | null {
  if (!isRecord(value)) {
    return null
  }

  const kind = readText(value.类型)

  if (!isRegimeChangeKind(kind)) {
    return null
  }

  const change: RegimeChangeData = {
    类型: kind,
    政权名称: readText(value.政权名称) || readText(value.国家名称),
  }

  const nextName =
    readText(value.新名称) || readText(value.新政权名称) || readText(value.新国家名称)

  if (nextName) {
    change.新名称 = nextName
  }

  const sourceName = readText(value.原政权) || readText(value.原国家)

  if (sourceName) {
    change.原政权 = sourceName
  }

  const transferSource = readText(value.来源政权) || readText(value.出让方) || readText(value.从)

  if (transferSource) {
    change.来源政权 = transferSource
  }

  for (const key of ['原因', '日期', '政体', '政治制度', '经济状况', '代表色', '校验'] as const) {
    const text = readText(value[key])

    if (text) {
      change[key] = text
    }
  }

  if (typeof value.AI控制 === 'boolean') {
    change.AI控制 = value.AI控制
  }

  const leaders = normalizeLeaders(value.领导人)

  if (leaders.length) {
    change.领导人 = leaders
  }

  if (isRecord(value.国家指标)) {
    change.国家指标 = normalizeCountryIndicators(value.国家指标)
  } else if (isRecord(value.初始国家力量)) {
    change.国家指标 = normalizeCountryIndicators(value.初始国家力量)
  }

  const succession = readSuccession(value.继承)

  if (succession) {
    change.继承 = succession
  }

  const inheritors = readNameList(value.继承国)

  if (inheritors.length) {
    change.继承国 = inheritors
  }

  if (isRecord(value.领土分配)) {
    const allocation: Record<string, RegimeTerritorySummary> = {}

    for (const [targetName, summary] of Object.entries(value.领土分配)) {
      const name = targetName.trim()

      if (name) {
        allocation[name] = writeTerritoryBuckets(readTerritoryBuckets(summary))
      }
    }

    if (Object.keys(allocation).length) {
      change.领土分配 = allocation
    }
  }

  const territory = readTerritoryBuckets(value.领土)

  if (countTerritoryBuckets(territory) > 0) {
    change.领土 = writeTerritoryBuckets(territory)
  }

  return change
}

const isPlayerControlled = (country: Record<string, unknown>): boolean => country.AI控制 === false

/** 校验一条变更能否应用；`reason` 为可直接展示的中文原因。 */
export function validateRegimeChange(
  change: RegimeChangeData,
  countries: readonly unknown[],
  options: RegimeChangeOptions = {},
): RegimeChangeValidation {
  const name = change.政权名称.trim()

  if (!name) {
    return { ok: false, reason: '无效条目：缺少 政权名称' }
  }

  if (change.类型 === '建立') {
    if (findCountryIndex(countries, name) >= 0) {
      return { ok: false, reason: `政权「${name}」已存在，不能重复建立` }
    }

    const sourceName = change.原政权?.trim()

    if (sourceName && findCountryIndex(countries, sourceName) < 0) {
      return { ok: false, reason: `建立「${name}」的 原政权「${sourceName}」不存在` }
    }

    return { ok: true, reason: '' }
  }

  const index = findCountryIndex(countries, name)

  if (index < 0) {
    return { ok: false, reason: `政权「${name}」不存在` }
  }

  if (change.类型 === '领土') {
    const sourceName = change.来源政权?.trim() ?? ''

    if (!sourceName) {
      return { ok: false, reason: `给「${name}」划入领土必须提供 来源政权` }
    }

    if (sourceName === name) {
      return { ok: false, reason: `划转领土的 来源政权 不能是「${name}」自己` }
    }

    const sourceIndex = findCountryIndex(countries, sourceName)

    if (sourceIndex < 0) {
      return { ok: false, reason: `划转领土的 来源政权「${sourceName}」不存在` }
    }

    const source = asCountry(countries[sourceIndex])

    if (source && isPlayerControlled(source) && !options.allowPlayerRegime) {
      return {
        ok: false,
        reason: `「${sourceName}」由玩家操控，AI 不能把它的领土划走`,
      }
    }

    return { ok: true, reason: '' }
  }

  const record = asCountry(countries[index])

  if (record && isPlayerControlled(record) && !options.allowPlayerRegime) {
    return {
      ok: false,
      reason: `「${name}」由玩家操控，AI 不能${change.类型 === '灭亡' ? '灭亡' : '更名'}它`,
    }
  }

  if (change.类型 === '更名') {
    const nextName = change.新名称?.trim()

    if (!nextName) {
      return { ok: false, reason: `更名「${name}」时必须提供 新名称` }
    }

    if (nextName === name) {
      return { ok: false, reason: `更名「${name}」的新旧名称相同` }
    }

    if (findCountryIndex(countries, nextName) >= 0) {
      return { ok: false, reason: `政权「${nextName}」已存在，不能改名成重名` }
    }

    return { ok: true, reason: '' }
  }

  // 灭亡
  if (countries.length <= 1) {
    return { ok: false, reason: `「${name}」是世界上的最后一个政权，不能灭亡` }
  }

  const inheritors = (change.继承国 ?? [])
    .map((inheritor) => inheritor.trim())
    .filter((inheritor) => inheritor.length > 0 && inheritor !== name)

  if (change.继承 === '继承国' && !inheritors.length) {
    return { ok: false, reason: `灭亡「${name}」时 继承 为继承国，但没有给出可用的 继承国` }
  }

  for (const inheritor of inheritors) {
    if (findCountryIndex(countries, inheritor) < 0) {
      return { ok: false, reason: `灭亡「${name}」的 继承国「${inheritor}」不存在` }
    }
  }

  for (const targetName of Object.keys(change.领土分配 ?? {})) {
    if (findCountryIndex(countries, targetName) < 0) {
      return { ok: false, reason: `灭亡「${name}」的 领土分配 指向不存在的「${targetName}」` }
    }
  }

  return { ok: true, reason: '' }
}

const resolveColor = (
  rawColor: string | undefined,
  countries: readonly unknown[],
  pickColor: (usedColors: readonly string[]) => string,
): string => {
  const explicit = rawColor?.trim()

  if (explicit) {
    return explicit
  }

  const usedColors = countries
    .map((country) => (isRecord(country) ? readText(country.代表色) : ''))
    .filter((color) => color.length > 0)

  return pickColor(usedColors)
}

interface ApplyContext {
  countries: unknown[]
  indicators: Record<string, CountryIndicatorData>
  colorMap: Record<string, string>
  pickColor: (usedColors: readonly string[]) => string
  nameIndex: Record<string, string>
}

const applyCreate = (change: RegimeChangeData, context: ApplyContext): string => {
  const name = change.政权名称.trim()
  const sourceName = change.原政权?.trim() ?? ''
  const sourceIndex = sourceName ? findCountryIndex(context.countries, sourceName) : -1
  const source = sourceIndex >= 0 ? asCountry(context.countries[sourceIndex]) : null
  const requested = readTerritoryBuckets(change.领土)
  // 有来源政权时只划走它真实持有的领土（名称会被反查成编号）；
  // 没有来源时视为无主土地上的新建政权，`领土` 原样接受。
  const incoming = source
    ? intersectTerritory(readTerritoryBuckets(source.领土), requested, context.nameIndex)
    : requested

  if (source) {
    subtractTerritory(source, incoming)
  }

  const power = normalizeCountryIndicators(
    change.国家指标 ?? source?.国家指标 ?? source?.初始国家力量,
  )
  const color = resolveColor(change.代表色, context.countries, context.pickColor)
  const leaders = normalizeLeaders(change.领导人)

  const record: Record<string, unknown> = {
    国家名称: name,
    AI控制: typeof change.AI控制 === 'boolean' ? change.AI控制 : true,
    代表色: color,
    国家指标: { ...power },
    初始国家力量: { ...power },
    领土: writeTerritoryBuckets(incoming),
  }

  if (leaders.length) {
    record.领导人 = leaders
  }

  for (const key of ['政体', '政治制度', '经济状况'] as const) {
    const text = change[key]?.trim()

    if (text) {
      record[key] = text
    }
  }

  context.countries.push(record)
  context.indicators[name] = { ...power }
  context.colorMap[name] = color

  const detail = [
    sourceName ? `源自「${sourceName}」` : '',
    change.政体 ? `政体=${change.政体}` : '',
    countTerritoryBuckets(incoming) > 0 ? `领土 ${countTerritoryBuckets(incoming)} 条` : '暂无领土',
    change.原因 ? `原因：${change.原因}` : '',
  ]
    .filter(Boolean)
    .join('；')

  return `已建立政权：${name}${detail ? `（${detail}）` : ''}`
}

const applyDestroy = (change: RegimeChangeData, context: ApplyContext): string => {
  const name = change.政权名称.trim()
  const index = findCountryIndex(context.countries, name)
  const record = asCountry(context.countries[index])

  if (index < 0 || !record) {
    return `未找到政权：${name}`
  }

  const dying = readTerritoryBuckets(record.领土)
  const inheritors = (change.继承国 ?? [])
    .map((inheritor) => inheritor.trim())
    .filter((inheritor) => inheritor.length > 0 && inheritor !== name)
  const allocationEntries = Object.entries(change.领土分配 ?? {})
  const movedNotes: string[] = []

  if (allocationEntries.length) {
    for (const [targetName, summary] of allocationEntries) {
      const targetIndex = findCountryIndex(context.countries, targetName)
      const target = targetIndex >= 0 ? asCountry(context.countries[targetIndex]) : null

      if (!target) {
        continue
      }

      // 只能分配被灭政权真正持有的编号，防止凭空给某个继承国加地。
      const share = intersectTerritory(dying, readTerritoryBuckets(summary), context.nameIndex)

      mergeTerritory(target, share)
      movedNotes.push(`${targetName} 接管 ${countTerritoryBuckets(share)} 条`)
    }
  } else if (change.继承 === '继承国') {
    const targets = inheritors
      .map((name) => {
        const targetIndex = findCountryIndex(context.countries, name)

        return {
          name,
          record: targetIndex >= 0 ? asCountry(context.countries[targetIndex]) : null,
        }
      })
      .filter(
        (target): target is { name: string; record: Record<string, unknown> } =>
          target.record !== null,
      )

    if (targets.length === 1) {
      const [only] = targets

      if (only) {
        mergeTerritory(only.record, dying)
        movedNotes.push(`${only.name} 继承全部领土`)
      }
    } else if (targets.length > 1) {
      // 没给 领土分配 时按顺序轮转分配，避免默认只给第一个继承国、其余分不到地。
      const shares = splitTerritory(dying, targets.length)

      for (const [index, target] of targets.entries()) {
        const share = shares[index]

        if (!share) {
          continue
        }

        mergeTerritory(target.record, share)
        movedNotes.push(`${target.name} 分得 ${countTerritoryBuckets(share)} 条`)
      }
    }
  }

  context.countries.splice(index, 1)
  delete context.indicators[name]
  delete context.colorMap[name]

  const detail = [
    movedNotes.length ? movedNotes.join('、') : '领土变为无主',
    change.原因 ? `原因：${change.原因}` : '',
  ]
    .filter(Boolean)
    .join('；')

  return `已灭亡政权：${name}${detail ? `（${detail}）` : ''}`
}

const applyRename = (change: RegimeChangeData, context: ApplyContext): string => {
  const name = change.政权名称.trim()
  const nextName = change.新名称?.trim() ?? ''
  const index = findCountryIndex(context.countries, name)
  const record = asCountry(context.countries[index])

  if (index < 0 || !record) {
    return `未找到政权：${name}`
  }

  record.国家名称 = nextName

  const indicator = context.indicators[name]

  if (indicator) {
    context.indicators[nextName] = indicator
    delete context.indicators[name]
  }

  const color = context.colorMap[name] ?? readText(record.代表色)

  if (color) {
    context.colorMap[nextName] = color
  }
  delete context.colorMap[name]

  return `已更名：${name} → ${nextName}`
}

/** 把 source 名下的指定领土划给 target；用于政权更替后补地、割地与占领。 */
const applyTransfer = (change: RegimeChangeData, context: ApplyContext): string => {
  const targetName = change.政权名称.trim()
  const sourceName = change.来源政权?.trim() ?? ''
  const targetIndex = findCountryIndex(context.countries, targetName)
  const sourceIndex = findCountryIndex(context.countries, sourceName)
  const target = targetIndex >= 0 ? asCountry(context.countries[targetIndex]) : null
  const source = sourceIndex >= 0 ? asCountry(context.countries[sourceIndex]) : null

  if (!target || !source) {
    return `未找到政权：${targetName} / ${sourceName}`
  }

  const moved = intersectTerritory(
    readTerritoryBuckets(source.领土),
    readTerritoryBuckets(change.领土),
    context.nameIndex,
  )

  subtractTerritory(source, moved)
  mergeTerritory(target, moved)

  const count = countTerritoryBuckets(moved)
  const detail = [
    count > 0 ? `${count} 条` : '来源政权没有可划转的编号',
    change.原因 ? `原因：${change.原因}` : '',
  ]
    .filter(Boolean)
    .join('；')

  return `已划转领土：${sourceName} → ${targetName}（${detail}）`
}

const CHANGE_APPLIERS: Record<
  RegimeChangeKind,
  (change: RegimeChangeData, context: ApplyContext) => string
> = {
  建立: applyCreate,
  灭亡: applyDestroy,
  更名: applyRename,
  领土: applyTransfer,
}

const readCountryIndicators = (
  record: Record<string, unknown> | null,
): CountryIndicatorData | undefined => {
  if (!record) {
    return undefined
  }

  const value = isRecord(record.国家指标)
    ? record.国家指标
    : isRecord(record.初始国家力量)
      ? record.初始国家力量
      : null

  return value ? normalizeCountryIndicators(value) : undefined
}

/** 实际接管了领土的继承国；「无主」灭亡返回空数组。 */
const resolveSuccessors = (change: RegimeChangeData, name: string): string[] => {
  const allocationNames = Object.keys(change.领土分配 ?? {})
    .map((target) => target.trim())
    .filter((target) => target.length > 0)

  if (allocationNames.length) {
    return Array.from(new Set(allocationNames))
  }

  if (change.继承 !== '继承国') {
    return []
  }

  const inheritors = (change.继承国 ?? [])
    .map((inheritor) => inheritor.trim())
    .filter((inheritor) => inheritor.length > 0 && inheritor !== name)

  return Array.from(new Set(inheritors))
}

interface PreChangeSnapshot {
  colorMap: Record<string, string>
  indicators: Record<string, CountryIndicatorData>
  record: Record<string, unknown> | null
}

interface PostChangeSnapshot {
  colorMap: Record<string, string>
  indicators: Record<string, CountryIndicatorData>
}

/**
 * 把一条已生效的变更整理成时间线可用的结构。
 *
 * 灭亡与更名要取「变更前」的颜色与指标（政权已经不在表里了），
 * 建立与领土划转取「变更后」的结果。
 */
const describeAppliedChange = (
  change: RegimeChangeData,
  before: PreChangeSnapshot,
  after: PostChangeSnapshot,
): AppliedRegimeChange => {
  const name = change.政权名称.trim()
  const applied: AppliedRegimeChange = {
    类型: change.类型,
    政权名称: name,
  }
  const nextName = change.新名称?.trim()

  if (nextName) {
    applied.新名称 = nextName
  }

  const reason = change.原因?.trim()

  if (reason) {
    applied.原因 = reason
  }

  const dateText = change.日期?.trim()

  if (dateText) {
    applied.日期 = dateText
  }

  if (change.类型 === '灭亡') {
    const successors = resolveSuccessors(change, name)

    if (successors.length) {
      applied.继承国 = successors
    }
  }

  const beforeColor = before.colorMap[name] ?? (before.record ? readText(before.record.代表色) : '')
  const beforeIndicators = before.indicators[name] ?? readCountryIndicators(before.record)
  const targetName = change.类型 === '更名' && nextName ? nextName : name
  const afterColor = after.colorMap[targetName] ?? beforeColor
  const afterIndicators = after.indicators[targetName] ?? beforeIndicators

  const color =
    change.类型 === '建立' || change.类型 === '领土' ? afterColor : beforeColor || afterColor

  if (color) {
    applied.代表色 = color
  }

  const indicators =
    change.类型 === '灭亡' || change.类型 === '更名' ? beforeIndicators : afterIndicators

  if (indicators) {
    applied.国家指标 = { ...indicators }
  }

  return applied
}

/**
 * 按顺序应用一批政权变更。
 *
 * 传入的 `countries` 数组会被原地改写（增删与领土调整），
 * `indicators` / `colorMap` 不会被改写，返回的是浅拷贝后的新对象。
 * 某条变更失败只影响它自己，其余照常应用。
 */
export function applyRegimeChanges(
  countries: unknown[],
  indicators: Record<string, CountryIndicatorData>,
  colorMap: Record<string, string>,
  changes: readonly unknown[],
  options: RegimeChangeOptions = {},
): RegimeChangeResult {
  const context: ApplyContext = {
    countries,
    indicators: { ...indicators },
    colorMap: { ...colorMap },
    pickColor: options.nextColor ?? pickRegimeColor,
    nameIndex: options.nameIndex ?? {},
  }
  const applied: string[] = []
  const appliedChanges: AppliedRegimeChange[] = []
  const failed: string[] = []
  const createdNames: string[] = []
  // 世界本身没有领土数据时（手绘世界、纯文本剧本），不该抱怨"没有领土"。
  const hadTerritory = countries.some((country) => {
    const record = asCountry(country)

    return record ? countTerritoryBuckets(readTerritoryBuckets(record.领土)) > 0 : false
  })

  for (const rawChange of changes) {
    const change = normalizeRegimeChange(rawChange)

    if (!change) {
      failed.push('无效条目：缺少可识别的 类型（建立/灭亡/更名/领土）')
      continue
    }

    const validation = validateRegimeChange(change, context.countries, options)

    if (!validation.ok) {
      failed.push(validation.reason)
      continue
    }

    const changeName = change.政权名称.trim()
    const recordIndex = findCountryIndex(context.countries, changeName)
    const before: PreChangeSnapshot = {
      colorMap: { ...context.colorMap },
      indicators: { ...context.indicators },
      record: recordIndex >= 0 ? asCountry(context.countries[recordIndex]) : null,
    }

    if (change.类型 === '建立') {
      createdNames.push(changeName)
    }

    applied.push(CHANGE_APPLIERS[change.类型](change, context))
    appliedChanges.push(
      describeAppliedChange(change, before, {
        colorMap: context.colorMap,
        indicators: context.indicators,
      }),
    )
  }

  const warnings = collectTerritoryWarnings(context.countries, createdNames, hadTerritory)

  return {
    applied,
    appliedChanges,
    failed,
    warnings,
    indicators: context.indicators,
    colorMap: context.colorMap,
  }
}

/**
 * 建国却没有领土是最常见的错误：AI 容易只写一条「灭亡」而忘了划地。
 * 这里不改数据，只把问题明确指出来，让玩家知道该补哪一步。
 */
function collectTerritoryWarnings(
  countries: readonly unknown[],
  createdNames: readonly string[],
  hadTerritory: boolean,
): string[] {
  if (!hadTerritory) {
    return []
  }

  const warnings: string[] = []

  for (const name of createdNames) {
    const index = findCountryIndex(countries, name)
    const record = index >= 0 ? asCountry(countries[index]) : null

    if (!record) {
      continue
    }

    if (countTerritoryBuckets(readTerritoryBuckets(record.领土)) > 0) {
      continue
    }

    warnings.push(
      `新政权「${name}」还没有领土：可以让 AI 用「领土」变更划入，或在「政权管理」里灭亡一个政权并选它作继承国。`,
    )
  }

  return warnings
}

export interface AssistantChangePayload {
  /** 交给原有的国家指标应用流程的条目。 */
  indicatorEntries: unknown[]
  /** 政权变更条目，交给 `applyRegimeChanges`。 */
  regimeChanges: unknown[]
}

const asEntryArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

/**
 * 拆分 AI 回复里的结构化变更。
 *
 * 兼容三种写法：
 * 1. 裸数组（旧格式，只有国家指标变更）；
 * 2. `{ 指标变更: [...], 政权变更: [...] }`（新格式）；
 * 3. 单条政权变更对象。
 */
export function splitAssistantChangePayload(parsed: unknown): AssistantChangePayload {
  const bareArray = asEntryArray(parsed)

  if (bareArray) {
    return {
      indicatorEntries: bareArray.filter((entry) => !isRegimeChangeEntry(entry)),
      regimeChanges: bareArray.filter(isRegimeChangeEntry),
    }
  }

  if (!isRecord(parsed)) {
    return { indicatorEntries: [], regimeChanges: [] }
  }

  const indicatorContainer = asEntryArray(parsed.指标变更)
  const regimeContainer = asEntryArray(parsed.政权变更)
  const singleRegime = isRegimeChangeEntry(parsed.政权变更) ? [parsed.政权变更] : null

  if (indicatorContainer || regimeContainer || singleRegime) {
    return {
      indicatorEntries: indicatorContainer ?? [],
      regimeChanges: regimeContainer ?? singleRegime ?? [],
    }
  }

  if (isRegimeChangeEntry(parsed)) {
    return { indicatorEntries: [], regimeChanges: [parsed] }
  }

  return { indicatorEntries: [parsed], regimeChanges: [] }
}

/** 只认带合法 `类型` 的对象，避免把普通叙述里的 JSON 当成政权变更。 */
export function isRegimeChangeEntry(value: unknown): boolean {
  return isRecord(value) && isRegimeChangeKind(value.类型)
}
