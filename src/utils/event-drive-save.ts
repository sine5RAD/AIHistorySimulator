import { makeTerritoryKey, normalizeTerritoryCode } from '@/lib/map/territory-code'
import type { GeoFeatureBounds, GeoPosition, WorldMapFeature } from '@/types/geo'
import type { Area } from '@/types/land'
import { DEFAULT_REGIME_COLOR } from '@/types/scenario'

import { isRecord } from './country-data'
import { convertMercatorAreasToLngLat, normalizeAreas, toColorInputValue } from './scenario-data'
import { CODE_LEVELS, type TerritoryCodeLevel } from './territory-summary'

/**
 * 事件驱动页的本地存档读取与「存档政治地图」解析。
 *
 * 事件驱动页把当前世界写进 localStorage 的若干键：
 * - 长期存档：`event-drive-world-chat-archive-json`，按世界名分条目；
 * - 快照：`event-drive-snapshot-history-json`，选中后会覆盖当前世界；
 * - 当前世界包：`event-drive-world-package-json`，作为没有存档时的兜底。
 *
 * 世界地图页只读取这些键，不直接依赖事件驱动页的组件实例。
 * 解析结果按「政权代表色 + 领土编号」组织，交给地图渲染：
 * - 国家级编号直接匹配国界要素；
 * - 一级 / 二级行政区编号在对应国家的分块里匹配；
 * - 世界生成导出的手绘国土（`landMap`）会从墨卡托纹理坐标换算成经纬度。
 */

export const EVENT_DRIVE_ARCHIVE_KEY = 'event-drive-world-chat-archive-json'
export const EVENT_DRIVE_SNAPSHOT_HISTORY_KEY = 'event-drive-snapshot-history-json'
export const EVENT_DRIVE_SELECTED_SNAPSHOT_KEY = 'event-drive-selected-snapshot-id'
export const EVENT_DRIVE_LAST_WORLD_KEY = 'event-drive-last-world-key'
export const WORLD_PACKAGE_TRANSFER_KEY = 'event-drive-world-package-json'

const LIVE_SESSION_SNAPSHOT_ID = '__live__'

/** 会改变「当前存档」的存储键，供 world-map 订阅 storage 事件。 */
export const EVENT_DRIVE_SAVE_STORAGE_KEYS = [
  EVENT_DRIVE_ARCHIVE_KEY,
  EVENT_DRIVE_SNAPSHOT_HISTORY_KEY,
  EVENT_DRIVE_SELECTED_SNAPSHOT_KEY,
  EVENT_DRIVE_LAST_WORLD_KEY,
  WORLD_PACKAGE_TRANSFER_KEY,
] as const

/** 事件驱动页的世界包。字段大多是可选的，兼容剧本 / 世界生成两种来源。 */
export interface EventDriveWorldPayload {
  source?: string
  generatedAt?: string
  currentCountryName?: string
  scenarioName?: string
  scenarioStartTime?: string
  countries?: unknown
  world?: unknown
  landMap?: unknown
  countryColorMap?: unknown
  territoryNames?: unknown
  /** 地区编号 -> 所属国家 ISO3，新存档会写入，用于精确匹配同名编号。 */
  territoryCountries?: unknown
  [key: string]: unknown
}

export interface EventDriveSaveSnapshot {
  /** 存档键或快照 id，用于判断当前地图画的是哪一份存档。 */
  key: string
  label: string
  source: 'snapshot' | 'archive' | 'package'
  updatedAt: string
  world: EventDriveWorldPayload
}

export interface SaveRegime {
  name: string
  color: string
  /** 该政权在这份存档里能落到地图上的领土块数。 */
  unitCount: number
}

export interface SaveTerritoryUnit {
  regimeName: string
  color: string
  code: string
  level: TerritoryCodeLevel
  /** 所属国家 ISO3；旧存档没有这个信息时为空，由地图按编号兜底匹配。 */
  countryCode: string
  name: string
}

export interface SaveAreaGroup {
  regimeName: string
  color: string
  areas: Area[]
  bounds: GeoFeatureBounds
  /** 手绘国土同样包成地图要素，复用悬停、命中与 Path2D 缓存。 */
  feature: WorldMapFeature
}

export interface EventDriveSaveMap {
  save: EventDriveSaveSnapshot
  label: string
  regimes: SaveRegime[]
  units: SaveTerritoryUnit[]
  /** `编号|国家` -> 领土块；同名编号靠国家区分。 */
  byKey: Map<string, SaveTerritoryUnit>
  /** 编号 -> 领土块；旧存档没有国家代码时按编号兜底。 */
  byCode: Map<string, SaveTerritoryUnit[]>
  /** 世界生成 / 手绘国土多边形。 */
  areaGroups: SaveAreaGroup[]
  hasSubCountryUnits: boolean
  /** 有下级行政区编号但缺少国家代码，加载分块时只能全量加载。 */
  unknownSubCountryCountry: boolean
}

type ReadonlyStorage = Pick<Storage, 'getItem'>

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readStorageJson = (storage: ReadonlyStorage | null | undefined, key: string): unknown => {
  try {
    const raw = storage?.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

const readStorageText = (storage: ReadonlyStorage | null | undefined, key: string): string => {
  try {
    return (storage?.getItem(key) ?? '').trim()
  } catch {
    return ''
  }
}

const readStringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {}
  }

  const result: Record<string, string> = {}

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()
    const text = readText(rawValue)

    if (key && text) {
      result[key] = text
    }
  }

  return result
}

const getNestedWorld = (payload: EventDriveWorldPayload): Record<string, unknown> | null =>
  isRecord(payload.world) ? payload.world : null

/** 与事件驱动页的 `getWorldArchiveKey` 保持一致，世界地图据此找当前存档条目。 */
export function getWorldArchiveKey(payload: EventDriveWorldPayload | null | undefined): string {
  if (!payload) {
    return ''
  }

  const scenarioName = readText(payload.scenarioName)

  if (scenarioName) {
    const startTime = readText(payload.scenarioStartTime)
    return startTime ? `剧本 · ${scenarioName} · ${startTime}` : `剧本 · ${scenarioName}`
  }

  const currentName = readText(payload.currentCountryName)

  if (currentName) {
    return currentName
  }

  const generatedAt = readText(payload.generatedAt)

  if (generatedAt) {
    return `未命名世界_${generatedAt}`
  }

  return '未命名世界'
}

interface ArchiveEntryLike {
  world: EventDriveWorldPayload
  updatedAt: string
}

const readArchiveEntries = (
  storage: ReadonlyStorage | null | undefined,
): Record<string, ArchiveEntryLike> => {
  const payload = readStorageJson(storage, EVENT_DRIVE_ARCHIVE_KEY)

  if (!isRecord(payload)) {
    return {}
  }

  const entries: Record<string, ArchiveEntryLike> = {}

  for (const [worldKey, rawEntry] of Object.entries(payload)) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.world)) {
      continue
    }

    // 事件驱动页读取存档时也要求 chatMessages 是数组，这里保持一致。
    if (!Array.isArray(rawEntry.chatMessages)) {
      continue
    }

    entries[worldKey] = {
      world: rawEntry.world as EventDriveWorldPayload,
      updatedAt: readText(rawEntry.updatedAt),
    }
  }

  return entries
}

interface SnapshotEntryLike {
  id: string
  label: string
  world: EventDriveWorldPayload | null
  createdAt: string
}

const readSnapshotEntries = (storage: ReadonlyStorage | null | undefined): SnapshotEntryLike[] => {
  const payload = readStorageJson(storage, EVENT_DRIVE_SNAPSHOT_HISTORY_KEY)

  if (!Array.isArray(payload)) {
    return []
  }

  const entries: SnapshotEntryLike[] = []

  for (const rawEntry of payload) {
    if (!isRecord(rawEntry)) {
      continue
    }

    const id = readText(rawEntry.id)

    if (!id) {
      continue
    }

    entries.push({
      id,
      label: readText(rawEntry.label),
      world: isRecord(rawEntry.world) ? (rawEntry.world as EventDriveWorldPayload) : null,
      createdAt: readText(rawEntry.createdAt),
    })
  }

  return entries
}

const readPackagePayload = (
  local: ReadonlyStorage | null | undefined,
  session: ReadonlyStorage | null | undefined,
): EventDriveWorldPayload | null => {
  for (const storage of [session, local]) {
    const payload = readStorageJson(storage, WORLD_PACKAGE_TRANSFER_KEY)

    if (isRecord(payload)) {
      return payload as EventDriveWorldPayload
    }
  }

  return null
}

/**
 * 读取事件驱动页当前加载的存档。
 *
 * 解析顺序与事件驱动页 `onMounted` 一致：
 * 1. 选中的快照优先（快照没有世界时表示已清空当前世界）；
 * 2. 当前世界包在存档里存在对应条目时，用该条目；
 * 3. 上次打开的世界键；
 * 4. 只有一个存档条目时用它；
 * 5. 没有可用存档条目时退回当前世界包。
 *
 * 都没有时返回 null，世界地图保持原来的现代国界显示。
 */
export function readActiveEventDriveSave(
  local: ReadonlyStorage | null = typeof window === 'undefined' ? null : window.localStorage,
  session: ReadonlyStorage | null = typeof window === 'undefined' ? null : window.sessionStorage,
): EventDriveSaveSnapshot | null {
  const archive = readArchiveEntries(local)
  const archiveKeys = Object.keys(archive)
  const packagePayload = readPackagePayload(local, session)
  const packageKey = getWorldArchiveKey(packagePayload)
  const lastWorldKey = readStorageText(local, EVENT_DRIVE_LAST_WORLD_KEY)

  let archiveKey = ''

  if (packageKey && archive[packageKey]) {
    archiveKey = packageKey
  } else if (lastWorldKey && archive[lastWorldKey]) {
    archiveKey = lastWorldKey
  } else if (archiveKeys.length === 1 && archiveKeys[0]) {
    archiveKey = archiveKeys[0]
  }

  // 事件驱动页最后才应用快照，所以快照优先于存档条目。
  const snapshotId = readStorageText(local, EVENT_DRIVE_SELECTED_SNAPSHOT_KEY)

  if (snapshotId && snapshotId !== LIVE_SESSION_SNAPSHOT_ID) {
    const snapshot = readSnapshotEntries(local).find((entry) => entry.id === snapshotId)

    if (snapshot) {
      if (!snapshot.world) {
        return null
      }

      return {
        key: snapshot.id,
        label: snapshot.label || getWorldArchiveKey(snapshot.world),
        source: 'snapshot',
        updatedAt: snapshot.createdAt,
        world: snapshot.world,
      }
    }
  }

  if (archiveKey) {
    const entry = archive[archiveKey]

    if (entry) {
      return {
        key: archiveKey,
        label: archiveKey,
        source: 'archive',
        updatedAt: entry.updatedAt,
        world: entry.world,
      }
    }
  }

  if (packagePayload) {
    return {
      key: packageKey || 'world-package',
      label: packageKey || '未命名世界',
      source: 'package',
      updatedAt: readText(packagePayload.generatedAt),
      world: packagePayload,
    }
  }

  return null
}

const getCountries = (payload: EventDriveWorldPayload): unknown[] => {
  if (Array.isArray(payload.countries)) {
    return payload.countries
  }

  const world = getNestedWorld(payload)

  return world && Array.isArray(world.countries) ? world.countries : []
}

const readMapFrom = (
  payload: EventDriveWorldPayload,
  world: Record<string, unknown> | null,
  key: 'territoryNames' | 'territoryCountries' | 'countryColorMap' | 'landMap',
): unknown => payload[key] ?? world?.[key]

const normalizeLevel = (rawLevel: string, code: string): TerritoryCodeLevel => {
  const level = rawLevel.trim().toLowerCase()

  if (level && level !== 'unknown' && (CODE_LEVELS as readonly string[]).includes(level)) {
    return level as TerritoryCodeLevel
  }

  return /^[A-Z]{3}\*?$/.test(code) ? 'country' : 'unknown'
}

const normalizeCountryCode = (
  rawCountryCode: string,
  code: string,
  level: TerritoryCodeLevel,
): string => {
  const upper = rawCountryCode.trim().toUpperCase()

  if (/^[A-Z]{3}$/.test(upper)) {
    return upper
  }

  if (level === 'country' && /^[A-Z]{3}\*?$/.test(code)) {
    return code.replace(/\*$/, '')
  }

  // 旧存档没有国家代码时，从 `AUS:...` 这类合成编号里能看出国家。
  const prefix = /^([A-Z]{3}):/.exec(code)
  return prefix?.[1] ?? ''
}

const computeAreaBounds = (areas: readonly Area[]): GeoFeatureBounds | null => {
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY

  for (const area of areas) {
    for (const [lng, lat] of area.vertices) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        continue
      }
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }

  return Number.isFinite(minLng) && Number.isFinite(minLat)
    ? { minLng, maxLng, minLat, maxLat }
    : null
}

/**
 * 把当前存档解析成地图能直接使用的领土表。
 *
 * 颜色优先取 `countryColorMap`，其次取政权自身的 `代表色`；
 * 领土同时兼容紧凑对象 `{ adm1: [编号] }` 与旧存档的数组写法。
 */
export function buildEventDriveSaveMap(save: EventDriveSaveSnapshot): EventDriveSaveMap {
  const payload = save.world
  const world = getNestedWorld(payload)
  const countries = getCountries(payload)
  const colorMap = (() => {
    const topLevel = readStringMap(payload.countryColorMap)

    return Object.keys(topLevel).length ? topLevel : readStringMap(world?.countryColorMap)
  })()
  const territoryNames = readStringMap(readMapFrom(payload, world, 'territoryNames'))
  const territoryCountries = readStringMap(readMapFrom(payload, world, 'territoryCountries'))

  const units: SaveTerritoryUnit[] = []
  const areaGroups: SaveAreaGroup[] = []
  const regimeColors = new Map<string, string>()
  const unitCounts = new Map<string, number>()
  const colorByCountryName = new Map<string, string>()

  const rememberRegime = (name: string, color: string) => {
    if (!name) {
      return
    }

    if (!regimeColors.has(name)) {
      regimeColors.set(name, color)
    }

    if (!unitCounts.has(name)) {
      unitCounts.set(name, 0)
    }
  }

  const addUnit = (unit: SaveTerritoryUnit) => {
    units.push(unit)
    rememberRegime(unit.regimeName, unit.color)
    unitCounts.set(unit.regimeName, (unitCounts.get(unit.regimeName) ?? 0) + 1)
  }

  const addAreaGroup = (regimeName: string, color: string, areas: Area[]) => {
    const bounds = computeAreaBounds(areas)

    if (!bounds) {
      return
    }

    const index = areaGroups.length + 1
    const feature: WorldMapFeature = {
      id: `save-area-${index}`,
      code: `AREA-${index}`,
      name: regimeName || '手绘国土',
      nameEn: '',
      iso: '',
      parent: '',
      level: 'country',
      polygons: areas.map((area) => [
        area.vertices.map(([longitude, latitude]) => [longitude, latitude] as GeoPosition),
      ]),
      bounds,
    }

    areaGroups.push({ regimeName, color, areas, bounds, feature })
    rememberRegime(regimeName, color)
  }

  for (const [index, rawCountry] of countries.entries()) {
    if (!isRecord(rawCountry)) {
      continue
    }

    const name =
      readText(rawCountry.国家名称) || readText(rawCountry.国家) || `未命名政权 ${index + 1}`
    const color = toColorInputValue(
      colorMap[name] ||
        readText(rawCountry.代表色) ||
        readText(rawCountry.countryColor) ||
        DEFAULT_REGIME_COLOR,
    )
    colorByCountryName.set(name, color)
    rememberRegime(name, color)

    const rawTerritories = rawCountry.领土 ?? rawCountry.territories ?? rawCountry.territory

    if (Array.isArray(rawTerritories)) {
      for (const rawTerritory of rawTerritories) {
        if (!isRecord(rawTerritory)) {
          continue
        }

        const code = normalizeTerritoryCode(
          readText(rawTerritory.代码) || readText(rawTerritory.code) || readText(rawTerritory.id),
        )
        const rawLevel = readText(rawTerritory.级别) || readText(rawTerritory.level)
        const level = normalizeLevel(rawLevel, code)
        const countryCode = normalizeCountryCode(
          readText(rawTerritory.国家代码) || readText(rawTerritory.countryCode),
          code,
          level,
        )
        const areas = normalizeAreas(rawTerritory.区域 ?? rawTerritory.areas ?? rawTerritory.land)

        if (areas.length) {
          addAreaGroup(name, color, areas)
        }

        if (code) {
          addUnit({
            regimeName: name,
            color,
            code,
            level,
            countryCode,
            name: readText(rawTerritory.名称) || territoryNames[code] || code,
          })
        }
      }

      continue
    }

    if (!isRecord(rawTerritories)) {
      continue
    }

    for (const [rawLevel, rawCodes] of Object.entries(rawTerritories)) {
      const levelKey = rawLevel.trim()

      if (levelKey === '总数' || levelKey === '自定义区域数量') {
        continue
      }

      if (!Array.isArray(rawCodes)) {
        continue
      }

      for (const rawCode of rawCodes) {
        const code = normalizeTerritoryCode(readText(rawCode))

        if (!code) {
          continue
        }

        const level = normalizeLevel(levelKey, code)
        addUnit({
          regimeName: name,
          color,
          code,
          level,
          countryCode: normalizeCountryCode(territoryCountries[code] ?? '', code, level),
          name: territoryNames[code] ?? code,
        })
      }
    }
  }

  // 世界生成导出的是 `landMap: { 国家名: { areas: [{ vertices: [u, v] }] } }`；
  // u/v 是 0~1 的墨卡托纹理坐标，这里换算成经纬度。
  const landMap = readMapFrom(payload, world, 'landMap')

  if (isRecord(landMap)) {
    for (const [rawName, rawLand] of Object.entries(landMap)) {
      const name = rawName.trim()

      if (!name) {
        continue
      }

      const areas = convertMercatorAreasToLngLat(normalizeAreas(rawLand))

      if (!areas.length) {
        continue
      }

      const color =
        colorByCountryName.get(name) ?? toColorInputValue(colorMap[name] || DEFAULT_REGIME_COLOR)

      addAreaGroup(name, color, areas)
    }
  }

  const byKey = new Map<string, SaveTerritoryUnit>()
  const byCode = new Map<string, SaveTerritoryUnit[]>()

  for (const unit of units) {
    const key = makeTerritoryKey(unit.code, unit.countryCode)

    if (!byKey.has(key)) {
      byKey.set(key, unit)
    }

    const list = byCode.get(unit.code) ?? []
    list.push(unit)
    byCode.set(unit.code, list)
  }

  const regimeNames = new Set<string>([...regimeColors.keys(), ...unitCounts.keys()])
  const regimes: SaveRegime[] = [...regimeNames].map((name) => ({
    name,
    color: regimeColors.get(name) ?? DEFAULT_REGIME_COLOR,
    unitCount: unitCounts.get(name) ?? 0,
  }))

  return {
    save,
    label: save.label || getWorldArchiveKey(payload),
    regimes,
    units,
    byKey,
    byCode,
    areaGroups,
    hasSubCountryUnits: units.some((unit) => unit.level !== 'country'),
    unknownSubCountryCountry: units.some((unit) => unit.level !== 'country' && !unit.countryCode),
  }
}

/**
 * 用地图要素的编号与所属国家匹配存档领土。
 *
 * - 先按「编号 + 国家」精确匹配，`N/A` 这类重复编号不会串到邻国；
 * - 旧存档没有国家代码时退回按编号匹配；
 * - 有国家代码但当前要素属于另一个国家时不强行上色。
 */
export function resolveSaveTerritory(
  map: EventDriveSaveMap,
  rawCode: string,
  rawCountryCode = '',
): SaveTerritoryUnit | null {
  const code = normalizeTerritoryCode(rawCode)

  if (!code) {
    return null
  }

  const countryCode = rawCountryCode.trim().toUpperCase()

  if (countryCode) {
    const exact = map.byKey.get(makeTerritoryKey(code, countryCode))

    if (exact) {
      return exact
    }
  }

  const candidates = map.byCode.get(code)

  if (!candidates?.length) {
    return null
  }

  if (countryCode) {
    const countryMatch = candidates.find((unit) => unit.countryCode === countryCode)

    if (countryMatch) {
      return countryMatch
    }

    if (candidates.every((unit) => unit.countryCode.length > 0)) {
      return null
    }
  }

  return candidates[0] ?? null
}
