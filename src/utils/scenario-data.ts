import type { CountryData } from '@/types/country'
import type { Area } from '@/types/land'
import type {
  LeaderData,
  RegimeData,
  ScenarioData,
  TerritoryData,
  TerritoryLevel,
} from '@/types/scenario'
import {
  DEFAULT_REGIME_COLOR,
  createEmptyRegimeData,
  createEmptyScenarioData,
  formatDateTimeLocal,
} from '@/types/scenario'
import { makeTerritoryKey, normalizeTerritoryCode } from '@/lib/map/territory-code'
import { isRecord, normalizeCountryData, normalizeCountryIndicators } from './country-data'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const roundCoordinate = (value: number): number => Math.round(value * 10000) / 10000

const TERRITORY_LEVELS: TerritoryLevel[] = ['country', 'adm1', 'adm2', 'adm3']
const COUNTRY_CODE_PATTERN = /^[A-Z]{3}$/
/** 国家 ISO3、ISO 3166-2 地区编号、中国 adcode（纯数字）。 */
const TERRITORY_CODE_PATTERN = /^(?:[A-Z]{3}|[A-Z]{2}-[A-Z0-9]{1,3}|\d{4,8})$/

const looksLikeTerritoryCode = (value: string): boolean =>
  TERRITORY_CODE_PATTERN.test(value.trim().toUpperCase())

const HEX_SHORT = /^#([0-9a-f]{3})$/i
const HEX_FULL = /^#([0-9a-f]{6})$/i
const RGB_PATTERN = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i
const HSL_PATTERN = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i

/** 把 #abc / #aabbcc 统一成小写 #aabbcc；不是十六进制颜色时返回 null。 */
export const normalizeHexColor = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  const shortMatch = HEX_SHORT.exec(trimmed)

  if (shortMatch?.[1]) {
    const [r, g, b] = shortMatch[1]
    if (!r || !g || !b) {
      return null
    }
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }

  const fullMatch = HEX_FULL.exec(trimmed)
  return fullMatch?.[1] ? `#${fullMatch[1].toLowerCase()}` : null
}

const channelToHex = (value: number): string =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')

const rgbToHex = (red: number, green: number, blue: number): string =>
  `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`

const hueToRgb = (p: number, q: number, t: number): number => {
  let next = t
  if (next < 0) next += 1
  if (next > 1) next -= 1
  if (next < 1 / 6) return p + (q - p) * 6 * next
  if (next < 1 / 2) return q
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6
  return p
}

/** HSL（色相 0~360，饱和度/亮度 0~100）转 #rrggbb。 */
export const hslToHex = (hue: number, saturation: number, lightness: number): string => {
  const h = (((hue % 360) + 360) % 360) / 360
  const s = Math.max(0, Math.min(100, saturation)) / 100
  const l = Math.max(0, Math.min(100, lightness)) / 100

  if (s === 0) {
    const channel = Math.round(l * 255)
    return rgbToHex(channel, channel, channel)
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  return rgbToHex(
    hueToRgb(p, q, h + 1 / 3) * 255,
    hueToRgb(p, q, h) * 255,
    hueToRgb(p, q, h - 1 / 3) * 255,
  )
}

/**
 * 给第 index 个政权生成一个默认代表色。
 * 使用黄金角分布色相，连续新建时颜色不会挤在一起。
 */
export const createRegimeColor = (index: number): string => {
  const hue = (210 + index * 137.508) % 360
  return hslToHex(hue, 62, 54)
}

const parseColorForPicker = (value: string): string | null => {
  const rgbMatch = RGB_PATTERN.exec(value)
  if (rgbMatch?.[1] && rgbMatch[2] && rgbMatch[3]) {
    return rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]))
  }

  const hslMatch = HSL_PATTERN.exec(value)
  if (hslMatch?.[1] && hslMatch[2] && hslMatch[3]) {
    return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]))
  }

  return null
}

/**
 * 把任意 CSS 颜色转换成 `<input type="color">` 可用的 #rrggbb。
 * 支持十六进制、rgb()/rgba() 与 hsl()/hsla()，其它写法回退到默认蓝色。
 */
export const toColorInputValue = (value: string): string => {
  const trimmed = value.trim()
  const hex = normalizeHexColor(trimmed)
  if (hex) {
    return hex
  }
  return parseColorForPicker(trimmed) ?? DEFAULT_REGIME_COLOR
}

/** 保留用户输入的颜色写法；十六进制统一小写，空值回退。 */
export const normalizeRegimeColor = (
  value: unknown,
  fallback: string = DEFAULT_REGIME_COLOR,
): string => {
  const trimmed = text(value).trim()
  if (!trimmed) {
    return fallback
  }

  return normalizeHexColor(trimmed) ?? trimmed
}

const normalizeLeader = (value: unknown): LeaderData | null => {
  if (typeof value === 'string') {
    const name = value.trim()
    return name ? { 姓名: name, 职位: '', 简介: '' } : null
  }

  if (!isRecord(value)) {
    return null
  }

  const name = text(value.姓名) || text(value.name) || text(value.名字)
  const title = text(value.职位) || text(value.职务) || text(value.title) || text(value.头衔)
  const description = text(value.简介) || text(value.description) || text(value.说明)

  if (!name && !title && !description) {
    return null
  }

  return { 姓名: name, 职位: title, 简介: description }
}

const normalizeLeaders = (value: unknown): LeaderData[] => {
  if (typeof value === 'string') {
    const leader = normalizeLeader(value)
    return leader ? [leader] : []
  }

  if (isRecord(value)) {
    if (text(value.姓名) || text(value.name)) {
      const leader = normalizeLeader(value)
      return leader ? [leader] : []
    }

    const leaders: LeaderData[] = []

    for (const [name, detail] of Object.entries(value)) {
      if (typeof detail === 'string') {
        leaders.push({ 姓名: name, 职位: detail, 简介: '' })
        continue
      }

      if (isRecord(detail)) {
        leaders.push({
          姓名: name,
          职位: text(detail.职位) || text(detail.职务) || text(detail.title),
          简介: text(detail.简介) || text(detail.description),
        })
      }
    }

    return leaders
  }

  if (!Array.isArray(value)) {
    return []
  }

  return value.map(normalizeLeader).filter((leader): leader is LeaderData => leader !== null)
}

const normalizeArea = (value: unknown): Area | null => {
  const verticesSource = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.vertices)
      ? value.vertices
      : null

  if (!verticesSource) {
    return null
  }

  const vertices: [number, number][] = []

  for (const point of verticesSource) {
    if (!Array.isArray(point) || point.length < 2) {
      continue
    }

    const longitude = Number(point[0])
    const latitude = Number(point[1])

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      continue
    }

    vertices.push([longitude, latitude])
  }

  return vertices.length >= 3 ? { vertices } : null
}

/** 兼容 `{ areas: [...] }`、`[{ vertices }]`、`[[lng, lat], ...]` 三种写法。 */
const normalizeAreas = (value: unknown): Area[] => {
  if (Array.isArray(value)) {
    return value.map(normalizeArea).filter((area): area is Area => area !== null)
  }

  if (isRecord(value) && Array.isArray(value.vertices)) {
    const area = normalizeArea(value)
    return area ? [area] : []
  }

  if (isRecord(value) && Array.isArray(value.areas)) {
    return normalizeAreas(value.areas)
  }

  return []
}

/**
 * 世界生成里的国土坐标是墨卡托纹理坐标 `[u, v]`（0~1），
 * 剧本与内置世界地图统一使用 `[经度, 纬度]`，导入时在这里换算。
 */
export const convertMercatorAreaToLngLat = (area: Area): Area => ({
  vertices: area.vertices.map(([u, v]) => {
    const textureU = Math.max(0, Math.min(1, u))
    const textureV = Math.max(0, Math.min(1, v))
    const longitude = textureU * 360 - 180
    const latitude =
      (2 * Math.atan(Math.exp((0.5 - textureV) * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI)

    return [roundCoordinate(longitude), roundCoordinate(latitude)] as [number, number]
  }),
})

export const convertMercatorAreasToLngLat = (areas: Area[]): Area[] =>
  areas.map(convertMercatorAreaToLngLat)

const normalizeTerritory = (value: unknown, fallbackName = ''): TerritoryData | null => {
  if (typeof value === 'string') {
    const name = value.trim()
    if (!name) {
      return null
    }

    if (looksLikeTerritoryCode(name)) {
      const code = normalizeTerritoryCode(name)
      return {
        名称: name,
        代码: code,
        ...(COUNTRY_CODE_PATTERN.test(code) ? { 级别: 'country' as const } : {}),
      }
    }

    return { 名称: name }
  }

  if (!isRecord(value)) {
    return null
  }

  const name = text(value.名称) || text(value.name) || text(value.国家名称) || fallbackName.trim()
  const rawCode =
    text(value.代码) ||
    text(value.code) ||
    text(value.地区编号) ||
    text(value.regionCode) ||
    text(value.iso) ||
    text(value.ISO) ||
    text(value.id)
  const code = rawCode.trim() ? normalizeTerritoryCode(rawCode) : ''
  const rawCountryCode =
    text(value.国家代码) || text(value.countryCode) || text(value.iso) || text(value.parent)
  const normalizedCountryCode = rawCountryCode.trim().toUpperCase()
  const countryCode = COUNTRY_CODE_PATTERN.test(normalizedCountryCode) ? normalizedCountryCode : ''
  const rawLevel = (text(value.级别) || text(value.level)).trim().toLowerCase()
  const explicitLevel = TERRITORY_LEVELS.find((level) => level === rawLevel)
  const level = explicitLevel ?? (code && COUNTRY_CODE_PATTERN.test(code) ? 'country' : undefined)
  const areas = normalizeAreas(value.区域 ?? value.areas ?? value.land)

  if (!name && !code && !areas.length) {
    return null
  }

  return {
    名称: name || code,
    ...(code ? { 代码: code } : {}),
    ...(countryCode ? { 国家代码: countryCode } : {}),
    ...(level ? { 级别: level } : {}),
    ...(areas.length ? { 区域: areas } : {}),
  }
}

/** 归一化政权的领土列表，支持数组、单个国土对象与「名称 -> 国土」映射。 */
export function normalizeTerritoryList(value: unknown): TerritoryData[] {
  if (Array.isArray(value)) {
    // 直接写成 [[lng, lat], ...] 的单个多边形，也当作一条领土处理。
    const first = value[0]
    if (Array.isArray(first) && typeof first[0] === 'number') {
      const area = normalizeArea(value)
      return area ? [{ 名称: '未命名领土', 区域: [area] }] : []
    }

    return value
      .map((item) => normalizeTerritory(item))
      .filter((territory): territory is TerritoryData => territory !== null)
  }

  if (isRecord(value)) {
    if (Array.isArray(value.areas) || Array.isArray(value.vertices)) {
      const territory = normalizeTerritory(value)
      return territory ? [territory] : []
    }

    const territories: TerritoryData[] = []

    for (const [name, landValue] of Object.entries(value)) {
      const areas = normalizeAreas(landValue)
      if (areas.length) {
        territories.push({ 名称: name, 区域: areas })
        continue
      }

      const territory = normalizeTerritory(landValue, name)
      if (territory) {
        territories.push(territory)
      }
    }

    return territories
  }

  return []
}

/**
 * 剧本领土的唯一键：代码 + 所属国家。
 *
 * 整国编号（3 个字母）在缺省 `国家代码` 时用自身推断；
 * 这样 KOS / MNE / CYN 等地图国家要素仍能与地图要素键对应。
 */
export const getTerritoryKey = (territory: TerritoryData): string => {
  const code = normalizeTerritoryCode(territory.代码 ?? '')
  if (!code) {
    return ''
  }

  const explicitCountry = (territory.国家代码 ?? '').trim().toUpperCase()
  const inferredCountry = explicitCountry || (/^[A-Z]{3}$/.test(code) ? code : '')
  return makeTerritoryKey(code, inferredCountry)
}

/**
 * 把任意 JSON 归一化成合法政权。
 *
 * 兼容三种输入：
 * 1. 剧本导出的政权（包含代表色 / 政体 / 领导人 / 领土 / 初始国家力量）；
 * 2. 文章转 JSON 得到的 `CountryData`；
 * 3. 世界生成导出的单个国家（带 `land` 与 `countryColor`）。
 */
export function normalizeRegimeData(value: unknown, index = 0): RegimeData {
  const country = normalizeCountryData(value)
  const record = isRecord(value) ? value : {}
  const rawPower = record.初始国家力量 ?? record.国家指标
  const power = normalizeCountryIndicators(rawPower)
  const color = normalizeRegimeColor(
    record.代表色 ?? record.countryColor ?? record.color,
    createRegimeColor(index),
  )
  const government = text(record.政体) || country.政治制度 || ''
  const leaders = normalizeLeaders(record.领导人 ?? record.领袖 ?? record.leaders)
  let territories = normalizeTerritoryList(record.领土 ?? record.territories ?? record.territory)

  // 世界生成导出的是 { land: { areas: [{ vertices: [u, v] }] } }，换算成经纬度多边形。
  if (!territories.length && record.land !== undefined) {
    const landAreas = normalizeAreas(record.land)
    if (landAreas.length) {
      territories = [
        {
          名称: country.国家名称.trim() || `领土 ${index + 1}`,
          区域: convertMercatorAreasToLngLat(landAreas),
        },
      ]
    }
  }

  // 同一个「代码 + 国家」只保留一条；N/A 这类源数据重复编号靠国家代码区分。
  const seenKeys = new Set<string>()
  territories = territories.filter((territory) => {
    const key = getTerritoryKey(territory)
    if (!key) {
      return true
    }
    if (seenKeys.has(key)) {
      return false
    }
    seenKeys.add(key)
    return true
  })

  return {
    ...country,
    国家指标: { ...power },
    代表色: color,
    政体: government,
    领导人: leaders,
    领土: territories,
    初始国家力量: { ...power },
  }
}

/** 把「名称 -> 政权」的对象映射也接住，兼容手写剧本。 */
const normalizeRegimeCollection = (value: unknown): RegimeData[] => {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeRegimeData(item, index))
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([, item]) => isRecord(item) || typeof item === 'string')
      .map(([name, item], index) => {
        if (isRecord(item) && !text(item.国家名称)) {
          return normalizeRegimeData({ ...item, 国家名称: name }, index)
        }
        return normalizeRegimeData(item, index)
      })
  }

  return []
}

/**
 * 归一化整份剧本。
 *
 * 接受 `{ 剧本名称, 开局时间, 存在国家 }`、`{ countries }`、世界包
 * `{ world: { countries } }`、政权数组，甚至单个政权 / 国家档案。
 */
export function normalizeScenarioData(value: unknown): ScenarioData {
  const empty = createEmptyScenarioData()

  if (Array.isArray(value)) {
    return {
      ...empty,
      存在国家: normalizeRegimeCollection(value),
    }
  }

  if (!isRecord(value)) {
    return empty
  }

  const root = isRecord(value.剧本) ? value.剧本 : isRecord(value.scenario) ? value.scenario : value
  const nestedWorld = isRecord(root.world) ? root.world : null
  const countriesValue =
    root.存在国家 ??
    root.countries ??
    root.国家 ??
    (nestedWorld ? nestedWorld.countries : undefined)

  if (countriesValue === undefined) {
    const looksLikeCountry =
      typeof root.国家名称 === 'string' ||
      typeof root.代表色 === 'string' ||
      typeof root.政治制度 === 'string'

    return looksLikeCountry ? { ...empty, 存在国家: [normalizeRegimeData(root, 0)] } : empty
  }

  const name = text(root.剧本名称) || text(root.name) || empty.剧本名称
  const startTime =
    text(root.开局时间) || text(root.startTime) || text(root.开始时间) || empty.开局时间

  return {
    剧本名称: name,
    开局时间: startTime,
    存在国家: normalizeRegimeCollection(countriesValue),
  }
}

/**
 * 从世界生成导出的世界数据生成剧本：
 * 国家信息来自 `countries`，颜色来自 `countryColorMap`，
 * 领土来自 `landMap` 并自动完成墨卡托坐标转换。
 */
export function createScenarioFromWorldData(
  value: unknown,
  sourceLabel = '导入的世界',
): ScenarioData {
  const root = isRecord(value) ? value : {}
  const world = isRecord(root.world) ? root.world : root
  const countries = Array.isArray(world.countries)
    ? world.countries
    : Array.isArray(root.countries)
      ? root.countries
      : []
  const landMap = isRecord(world.landMap)
    ? world.landMap
    : isRecord(root.landMap)
      ? root.landMap
      : {}
  const colorMap = isRecord(world.countryColorMap)
    ? world.countryColorMap
    : isRecord(root.countryColorMap)
      ? root.countryColorMap
      : {}

  const regimes: RegimeData[] = []
  const usedNames = new Set<string>()

  const pushRegime = (regimeValue: unknown, index: number, fallbackName: string) => {
    const regime = normalizeRegimeData(regimeValue, index)
    const name = regime.国家名称.trim() || fallbackName
    const key = name.trim()

    if (usedNames.has(key)) {
      return
    }
    usedNames.add(key)

    const color = normalizeRegimeColor(colorMap[name], regime.代表色)
    const landAreas = normalizeAreas(landMap[name])
    const territories: TerritoryData[] = landAreas.length
      ? [
          {
            名称: name || `领土 ${index + 1}`,
            区域: convertMercatorAreasToLngLat(landAreas),
          },
        ]
      : regime.领土

    regimes.push({
      ...regime,
      国家名称: name,
      代表色: color,
      领土: territories,
    })
  }

  if (countries.length) {
    countries.forEach((country, index) => {
      pushRegime(country, index, `政权 ${index + 1}`)
    })

    // 世界生成里可能有「有国土但没有国家档案」的条目，一并补上。
    for (const name of Object.keys(landMap)) {
      if (usedNames.has(name.trim())) {
        continue
      }
      pushRegime({ 国家名称: name }, regimes.length, name)
    }
  } else {
    for (const name of Object.keys(landMap)) {
      pushRegime({ 国家名称: name }, regimes.length, name)
    }
  }

  return {
    剧本名称: sourceLabel,
    开局时间: formatDateTimeLocal(new Date()),
    存在国家: regimes,
  }
}

/** 从政权中提取纯 `CountryData`，用于导出国家档案或在世界生成里复用。 */
export function toCountryData(regime: RegimeData): CountryData {
  const country = normalizeCountryData(regime)
  return {
    ...country,
    国家指标: { ...regime.初始国家力量 },
  }
}

/** 导出时的政权 JSON：场景字段在前，CountryData 字段在后。 */
export function serializeRegimeForExport(regime: RegimeData): RegimeData {
  const country = toCountryData(regime)
  const { 国家名称, ...restCountry } = country

  return {
    国家名称,
    代表色: regime.代表色,
    政体: regime.政体,
    领导人: regime.领导人.map((leader) => ({ ...leader })),
    领土: regime.领土.map((territory) => ({
      名称: territory.名称,
      ...(territory.代码 ? { 代码: territory.代码 } : {}),
      ...(territory.国家代码 ? { 国家代码: territory.国家代码 } : {}),
      ...(territory.级别 ? { 级别: territory.级别 } : {}),
      ...(territory.区域?.length
        ? {
            区域: territory.区域.map((area) => ({
              vertices: area.vertices.map(
                ([longitude, latitude]) => [longitude, latitude] as [number, number],
              ),
            })),
          }
        : {}),
    })),
    初始国家力量: { ...regime.初始国家力量 },
    ...restCountry,
  }
}

/** 导出时的剧本 JSON。 */
export function serializeScenarioForExport(scenario: ScenarioData): ScenarioData {
  return {
    剧本名称: scenario.剧本名称,
    开局时间: scenario.开局时间,
    存在国家: scenario.存在国家.map(serializeRegimeForExport),
  }
}

/**
 * 把国家档案应用到当前政权：
 * - 档案里有场景字段就覆盖，没有就保留当前值；
 * - 三国力指标始终与「初始国家力量」保持同步。
 */
export function applyCountryArchive(regime: RegimeData, archive: unknown): RegimeData {
  const normalized = normalizeRegimeData(archive)
  const record = isRecord(archive) ? archive : {}
  const hasColor = typeof record.代表色 === 'string' && record.代表色.trim().length > 0
  const hasGovernment = typeof record.政体 === 'string' && record.政体.trim().length > 0
  const hasPower = isRecord(record.初始国家力量) || isRecord(record.国家指标)
  const hasLeaders =
    Array.isArray(record.领导人) || isRecord(record.领导人) || typeof record.领导人 === 'string'
  const hasTerritories =
    Array.isArray(record.领土) ||
    isRecord(record.领土) ||
    typeof record.领土 === 'string' ||
    record.land !== undefined

  const nextPower = hasPower ? { ...normalized.初始国家力量 } : { ...regime.初始国家力量 }

  const next: RegimeData = {
    ...normalized,
    代表色: hasColor ? normalized.代表色 : regime.代表色,
    政体: hasGovernment ? normalized.政体 : regime.政体 || normalized.政体,
    领导人: hasLeaders ? normalized.领导人 : regime.领导人,
    领土: hasTerritories ? normalized.领土 : regime.领土,
    初始国家力量: nextPower,
    国家指标: { ...nextPower },
  }

  return next
}

/**
 * 新建政权的默认值，放在这里方便页面和测试共用。
 *
 * 剧本默认是「AI 推演所有政权」，玩家需要在政权设定里主动勾选「玩家操控国家」
 * 才会把 `AI控制` 置为 false；这样新建几十个政权时不会全部变成玩家操控。
 */
export const createNextRegime = (index: number, color?: string): RegimeData => {
  const regime = createEmptyRegimeData(color ?? createRegimeColor(index))
  regime.国家名称 = `新政权 ${index + 1}`
  regime.AI控制 = true
  return regime
}

/** 从一组政权中挑一个还没被使用的代表色。 */
export const pickUnusedRegimeColor = (regimes: RegimeData[]): string => {
  const used = new Set(regimes.map((regime) => toColorInputValue(regime.代表色)))

  for (let index = 0; index < 64; index += 1) {
    const color = createRegimeColor(index)
    if (!used.has(color)) {
      return color
    }
  }

  return createRegimeColor(regimes.length)
}

export const safeFileName = (value: string, fallback = '剧本'): string => {
  const safe = value.trim().replace(/[/:*?"<>|\\]+/g, '_')
  return safe || fallback
}
