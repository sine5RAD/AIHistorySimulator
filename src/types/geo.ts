/**
 * GeoJSON 相关类型与归一化工具。
 *
 * 世界地图的数据来源不固定：
 * - Natural Earth（我们生成的 `public/geo/world.geojson`）：`properties.name` / `name_en` / `iso`
 * - 阿里云 DataV：`properties.name` / `adcode` / `level` / `parent`
 * - geoBoundaries：`properties.shapeName` / `shapeID` / `shapeGroup`
 *
 * 字段结构不完全稳定，这里统一成渲染与命中测试都方便使用的 `WorldMapFeature`。
 */

/** 一个经纬度坐标：[经度, 纬度] */
export type GeoPosition = [number, number]

/** 环：首尾不需要闭合，渲染时会自动 closePath */
export type GeoRing = GeoPosition[]

/** 一个多边形：第一个环是外环，其余是内环（洞） */
export type GeoPolygon = GeoRing[]

/** 一个要素的所有多边形（MultiPolygon 会被拍平到这里） */
export type GeoPolygons = GeoPolygon[]

export interface GeoFeatureBounds {
  minLng: number
  maxLng: number
  minLat: number
  maxLat: number
}

/** 行政层级：国家 / 一级 / 二级 / 三级行政区 */
export type GeoFeatureLevel = 'country' | 'adm1' | 'adm2' | 'adm3'

/** 归一化后的地图要素：渲染与点击检测只依赖这些字段 */
export interface WorldMapFeature {
  /** 唯一标识：国家用 ISO3，中国地级市用 adcode，其他用 shapeID */
  id: string
  /** 展示用短代码：国家 ISO3 / 中国 adcode / geoBoundaries shapeISO 或 `DEU-ADM2` */
  code: string
  /** 展示用名称，例如 `中国` / `广州市` */
  name: string
  /** 英文名，没有则为空串 */
  nameEn: string
  /** 所属国家 / 地区代码（ISO3），无法确定时为空串 */
  iso: string
  /** 上级名称，例如省名；国家要素为空串 */
  parent: string
  /** 行政层级，数据没给时按 `country` 处理 */
  level: GeoFeatureLevel
  polygons: GeoPolygons
  bounds: GeoFeatureBounds
}

interface RawGeometry {
  type?: unknown
  coordinates?: unknown
  geometries?: unknown
}

interface RawFeature {
  id?: unknown
  properties?: unknown
  geometry?: RawGeometry | null
}

export interface RawFeatureCollection {
  type?: unknown
  features?: unknown
}

/** 判断一个未知值是否是可用的 GeoJSON FeatureCollection */
export function isRawFeatureCollection(value: unknown): value is RawFeatureCollection {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const collection = value as RawFeatureCollection
  return collection.type === 'FeatureCollection' && Array.isArray(collection.features)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readString(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : ''
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return ''
}

/** 从一组候选字段里挑第一个非空字符串 */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readString(source[key])
    if (value) {
      return value
    }
  }
  return ''
}

const ID_KEYS = ['id', 'adcode', 'shapeID', 'code', 'iso', 'ADM0_A3', 'ISO_A3'] as const
const NAME_KEYS = ['name', 'NAME_ZH', 'shapeName', 'NAME_EN', 'NAME', 'name_en'] as const
const NAME_EN_KEYS = ['name_en', 'NAME_EN', 'NAME', 'shapeName'] as const
const ISO_KEYS = ['iso', 'ISO_A3', 'ADM0_A3', 'shapeGroup'] as const

/** `parent` 可能是字符串，也可能是 DataV 的 `{ adcode: 440000 }` 对象 */
function readParent(value: unknown): string {
  const direct = readString(value)
  if (direct) {
    return direct
  }
  if (typeof value === 'object' && value !== null) {
    return firstString(value as Record<string, unknown>, ['name', 'adcode', 'id'])
  }
  return ''
}

function readLevel(value: string): GeoFeatureLevel {
  const level = value.toLowerCase()
  if (level === 'adm1' || level === 'province' || level === 'state') {
    return 'adm1'
  }
  if (level === 'adm3' || level === 'county') {
    return 'adm3'
  }
  if (level === 'adm2' || level === 'city' || level === 'district' || level === 'municipality') {
    return 'adm2'
  }
  return 'country'
}

/** 展示用短代码：优先用数据给的，其次从 shapeID 前缀推，最后用「国家-层级」兜底 */
function deriveCode(
  properties: Record<string, unknown>,
  id: string,
  iso: string,
  level: GeoFeatureLevel,
): string {
  const direct = firstString(properties, ['code', 'shapeISO', 'adcode', 'iso', 'ISO_A3'])
  if (direct) {
    return direct
  }
  const [head, second] = id.split('-')
  if (head && second && /^[A-Z]{3}$/.test(head)) {
    return `${head}-${second}`
  }
  // geoBoundaries 的 shapeID 是一串不带前缀的哈希，对用户没有意义
  if (level !== 'country' && iso) {
    return `${iso}-${level.toUpperCase()}`
  }
  return id
}

/** 把原始坐标数组校验并转成 GeoRing；点数不足 3 个的环视为无效 */
function normalizeRing(value: unknown): GeoRing | null {
  if (!Array.isArray(value)) {
    return null
  }
  const ring: GeoRing = []
  for (const point of value) {
    if (!Array.isArray(point)) {
      return null
    }
    const [lng, lat] = point as unknown[]
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) {
      return null
    }
    ring.push([lng, lat])
  }
  return ring.length >= 3 ? ring : null
}

function normalizePolygon(value: unknown): GeoPolygon | null {
  if (!Array.isArray(value)) {
    return null
  }
  const rings: GeoPolygon = []
  for (const rawRing of value) {
    const ring = normalizeRing(rawRing)
    if (ring) {
      rings.push(ring)
    }
  }
  return rings.length > 0 ? rings : null
}

/** 递归收集几何体中的所有多边形，顺序不影响渲染结果 */
function collectPolygons(geometry: RawGeometry | null | undefined, target: GeoPolygons): void {
  if (!geometry) {
    return
  }
  const { type, coordinates, geometries } = geometry
  if (type === 'Polygon') {
    const polygon = normalizePolygon(coordinates)
    if (polygon) {
      target.push(polygon)
    }
    return
  }
  if (type === 'MultiPolygon') {
    if (Array.isArray(coordinates)) {
      for (const rawPolygon of coordinates) {
        const polygon = normalizePolygon(rawPolygon)
        if (polygon) {
          target.push(polygon)
        }
      }
    }
    return
  }
  if (type === 'GeometryCollection' && Array.isArray(geometries)) {
    for (const child of geometries) {
      collectPolygons(child as RawGeometry, target)
    }
  }
}

function computeBounds(polygons: GeoPolygons): GeoFeatureBounds | null {
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY

  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
    return null
  }
  return { minLng, maxLng, minLat, maxLat }
}

/**
 * 跨 180° 经线的要素（俄罗斯、新西兰、斐济、美国阿留申…）如果按原始经度算包围盒，
 * 会得到 minLng=-180 / maxLng=180 这种“横跨全球”的结果，裁剪和命中测试都会出错。
 * 这里把西半球的点整体 +360，让要素落在连续的经度区间里；
 * 渲染时地图本来就会画三份经度副本，所以画面不受影响。
 */
function unwrapAntimeridian(polygons: GeoPolygons): void {
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const point of ring) {
        if (point[0] < 0) {
          point[0] += 360
        }
      }
    }
  }
}

/**
 * 把 GeoJSON FeatureCollection 归一化成渲染用的要素数组。
 * 无法绘制的要素（无几何、点/线、坐标损坏）会被直接丢弃。
 */
export function normalizeWorldFeatures(
  collection: RawFeatureCollection,
  defaultLevel: GeoFeatureLevel = 'country',
): WorldMapFeature[] {
  const rawFeatures = Array.isArray(collection.features)
    ? (collection.features as RawFeature[])
    : []
  const features: WorldMapFeature[] = []

  rawFeatures.forEach((rawFeature, index) => {
    const polygons: GeoPolygons = []
    collectPolygons(rawFeature?.geometry, polygons)
    if (polygons.length === 0) {
      return
    }

    let bounds = computeBounds(polygons)
    if (!bounds) {
      return
    }
    if (bounds.maxLng - bounds.minLng > 180) {
      unwrapAntimeridian(polygons)
      const unwrapped = computeBounds(polygons)
      if (unwrapped) {
        bounds = unwrapped
      }
    }

    const properties =
      typeof rawFeature.properties === 'object' && rawFeature.properties !== null
        ? (rawFeature.properties as Record<string, unknown>)
        : {}

    const rawId = readString(rawFeature.id)
    const id = rawId || firstString(properties, ID_KEYS) || `feature-${index}`
    const name = firstString(properties, NAME_KEYS) || id
    const nameEn = firstString(properties, NAME_EN_KEYS)
    const iso = (firstString(properties, ISO_KEYS) || (id.length === 3 ? id : '')).toUpperCase()
    const parent = readParent(properties.parent)
    const rawLevel = readString(properties.level)
    const level = rawLevel ? readLevel(rawLevel) : defaultLevel

    features.push({
      id,
      code: deriveCode(properties, id, iso, level),
      name,
      nameEn,
      iso,
      parent,
      level,
      polygons,
      bounds,
    })
  })

  return features
}
