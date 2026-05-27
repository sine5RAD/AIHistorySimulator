<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue'

import { createEmptyWorldData, type WorldData } from '@/types/world'
import type { CountryData, Party } from '../../types/country'
import type { LandData } from '@/types/land'
import { createEmptyLandData } from '@/types/land'

const worldData = ref<WorldData>(createEmptyWorldData())
const countryJsonError = ref('')
const worldJsonError = ref('')
const countryJsonInput = ref<HTMLInputElement | null>(null)
const worldJsonInput = ref<HTMLInputElement | null>(null)
const globeCanvas = ref<HTMLCanvasElement | null>(null)
// 旋转与拖拽状态（用于鼠标拖动旋转球体）
const rotation = ref(0) // 当前经度偏移，弧度
const tilt = ref(0) // 当前纬度偏移，弧度
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const startRotation = ref(0)
const startTilt = ref(0)
const activePointerId = ref<number | null>(null)

let removeGlobeListeners: (() => void) | null = null
let globeTextureCanvas: HTMLCanvasElement | null = null
let globeTextureWidth = 0
let globeTextureHeight = 0
let globeTextureData: Uint8ClampedArray | null = null
// 纹理级别的陆地掩码（与纹理同尺寸），1 表示陆地，0 表示海洋
let globeLandMask: Uint8Array | null = null
let globeRenderRaf: number | null = null
const SESSION_DRAFT_KEY = 'worldDataDraft'
const currentCountryIndex = ref(0)
const currentCountry = computed(
  () => worldData.value.countries[currentCountryIndex.value] ?? createNormalizedCountry(),
)
const currentCountryLand = computed(() => {
  const key = currentCountry.value.国家名称.trim()
  return key ? (landMap.value[key] ?? null) : null
})
const currentCountryColor = computed(() => getCountryColor(currentCountry.value.国家名称))
const countryColorEntries = computed(() => Object.entries(countryColorMap.value))
let globeRenderToken = 0

// 国土映射：国家名称 -> 国土数据（独立于国家数据）
const landMap = ref<Record<string, LandData>>({})
// 国家颜色映射：国家名称 -> 颜色（hex / css color）
const countryColorMap = ref<Record<string, string>>({})

const hashCountryName = (countryName: string) => {
  let hash = 0
  for (let i = 0; i < countryName.length; i += 1) {
    hash = (hash * 31 + countryName.charCodeAt(i)) >>> 0
  }
  return hash
}

const createCountryColor = (countryName: string) => {
  const normalized = countryName.trim()
  if (!normalized) return 'rgba(120,120,120,0.8)'

  const hash = hashCountryName(normalized)
  const hue = hash % 360
  const saturation = 55 + (hash % 20)
  const lightness = 45 + (hash % 10)
  return `hsl(${hue} ${saturation}% ${lightness}%)`
}

const withColorAlpha = (color: string, alpha: number) => {
  const clampedAlpha = Math.max(0, Math.min(1, alpha))
  if (color.startsWith('hsl(')) {
    return color.replace(/^hsl\((.*)\)$/, `hsla($1 / ${clampedAlpha})`)
  }
  if (color.startsWith('rgb(')) {
    return color.replace(/^rgb\((.*)\)$/, `rgba($1, ${clampedAlpha})`)
  }
  if (color.startsWith('#')) {
    return color
  }
  return color
}

type RgbColor = { r: number; g: number; b: number }

const colorParserCanvas = document.createElement('canvas')
const colorParserContext = colorParserCanvas.getContext('2d')

const clampRgbChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const parseCssColorToRgb = (color: string): RgbColor => {
  if (!colorParserContext) {
    return { r: 120, g: 120, b: 120 }
  }

  colorParserContext.fillStyle = '#000000'
  colorParserContext.fillStyle = color
  const normalized = colorParserContext.fillStyle

  const rgbMatch = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgbMatch) {
    return {
      r: clampRgbChannel(Number(rgbMatch[1])),
      g: clampRgbChannel(Number(rgbMatch[2])),
      b: clampRgbChannel(Number(rgbMatch[3])),
    }
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{6})$/i)
  if (hexMatch) {
    const hex = hexMatch[1] ?? ''
    if (hex.length !== 6) {
      return { r: 120, g: 120, b: 120 }
    }
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    }
  }

  return { r: 120, g: 120, b: 120 }
}

const currentCountryColorRgb = computed(() => parseCssColorToRgb(currentCountryColor.value))

const updateCurrentCountryColorChannel = (channel: 'r' | 'g' | 'b', value: number) => {
  const countryName = currentCountry.value.国家名称.trim()
  if (!countryName) return

  const nextRgb = { ...currentCountryColorRgb.value, [channel]: clampRgbChannel(value) }
  setCountryColor(countryName, `rgb(${nextRgb.r}, ${nextRgb.g}, ${nextRgb.b})`)
  scheduleRenderWorldGlobe()
}

const setCountryLand = (countryName: string, land: LandData) => {
  if (!countryName) return
  landMap.value[countryName.trim()] = land
}

const getCountryLand = (countryName: string): LandData => {
  const key = (countryName || '').trim()
  if (!key) return createEmptyLandData()
  let existing = landMap.value[key]
  if (!existing) {
    existing = createEmptyLandData()
    landMap.value[key] = existing
  }
  return existing
}

const peekCountryLand = (countryName: string): LandData | null => {
  const key = (countryName || '').trim()
  return key ? (landMap.value[key] ?? null) : null
}

const removeCountryLand = (countryName: string) => {
  if (!countryName) return
  delete landMap.value[countryName.trim()]
}

const listCountryLands = () => ({ ...landMap.value })

type WorldDraft = {
  countries?: unknown
  worldMapImage?: unknown
  landMap?: unknown
  countryColorMap?: unknown
}

const saveWorldDraft = () => {
  try {
    window.sessionStorage.setItem(
      SESSION_DRAFT_KEY,
      JSON.stringify({
        ...worldData.value,
        landMap: listCountryLands(),
        countryColorMap: { ...countryColorMap.value },
      }),
    )
  } catch (err) {
    console.error('Failed to save world draft to sessionStorage', err)
  }
}

const restoreWorldDraft = (draft: unknown) => {
  if (!isRecord(draft)) return

  const draftCountries = getProp(draft, 'countries')
  if (Array.isArray(draftCountries)) {
    const normalized = normalizeCountries(draftCountries)
    if (normalized.length) {
      upsertCountries(normalized)
    }
  }

  const mapImg = getProp(draft, 'worldMapImage')
  if (typeof mapImg === 'string') {
    worldData.value.worldMapImage = mapImg
  }

  if (isRecord((draft as WorldDraft).landMap)) {
    const savedLandMap = (draft as WorldDraft).landMap as Record<string, unknown>
    for (const [countryName, landValue] of Object.entries(savedLandMap)) {
      if (!isRecord(landValue) || !Array.isArray((landValue as { areas?: unknown }).areas)) continue
      const savedAreas = (landValue as { areas: unknown[] }).areas
      const areas = savedAreas
        .map((area: unknown) => {
          if (!isRecord(area) || !Array.isArray((area as { vertices?: unknown }).vertices)) {
            return null
          }
          const savedVertices = (area as { vertices: unknown[] }).vertices
          const vertices = savedVertices
            .filter(
              (vertex: unknown): vertex is [number, number] =>
                Array.isArray(vertex) && vertex.length >= 2,
            )
            .map(
              (vertex: [number, number]) =>
                [Number(vertex[0]), Number(vertex[1])] as [number, number],
            )
          return vertices.length ? { vertices } : null
        })
        .filter((area): area is { vertices: [number, number][] } => !!area)

      if (areas.length) {
        setCountryLand(countryName, { areas })
      }
    }
  }

  if (isRecord((draft as WorldDraft).countryColorMap)) {
    const savedCountryColorMap = (draft as WorldDraft).countryColorMap as Record<string, unknown>
    for (const [countryName, colorValue] of Object.entries(savedCountryColorMap)) {
      if (typeof colorValue === 'string' && colorValue.trim()) {
        setCountryColor(countryName, colorValue)
      }
    }
  }
}

const setCountryColor = (countryName: string, color: string) => {
  const key = countryName.trim()
  if (!key) return
  countryColorMap.value[key] = color
}

const getCountryColor = (countryName: string): string => {
  const key = countryName.trim()
  if (!key) return 'rgba(120,120,120,0.8)'

  const existing = countryColorMap.value[key]
  if (existing) return existing

  const nextColor = createCountryColor(key)
  countryColorMap.value[key] = nextColor
  return nextColor
}

const peekCountryColor = (countryName: string): string | null => {
  const key = (countryName || '').trim()
  return key ? (countryColorMap.value[key] ?? null) : null
}

const removeCountryColor = (countryName: string) => {
  const key = countryName.trim()
  if (!key) return
  delete countryColorMap.value[key]
}

const isRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
const getProp = (obj: unknown, key: string): unknown =>
  isRecord(obj) ? (obj as Record<string, unknown>)[key] : undefined

const createEmptyCityData = () => ({
  名称: '',
  简介: '',
  人口比例: {} as Record<string, string>,
  经济状况: '',
  政治状况: '',
})

const createEmptyDefinitionData = () => ({
  术语: '',
  定义: '',
})

const createEmptyAllianceData = () => ({
  联盟名称: '',
  政党: [] as Party[],
})

const createEmptyPartyData = (): Party => ({
  名称: '',
  简介: '',
  主要人物: {},
})

const createEmptyEthnicGroupData = () => ({
  名称: '',
  简介: '',
  文化: '',
  宗教: '',
})

const createNormalizedCountry = (country: Partial<CountryData> = {}): CountryData => ({
  国家名称: country.国家名称 ?? '',
  人口: {
    总数: country.人口?.总数 ?? 0,
    种族比例: { ...country.人口?.种族比例 },
  },
  政治制度: country.政治制度 ?? '',
  经济状况: country.经济状况 ?? '',
  城市: (country.城市 ?? []).map((city) => ({
    名称: city?.名称 ?? '',
    简介: city?.简介 ?? '',
    人口比例: { ...city?.人口比例 },
    经济状况: city?.经济状况 ?? '',
    政治状况: city?.政治状况 ?? '',
  })),
  国歌: country.国歌 ?? '',
  货币: country.货币 ?? '',
  武装力量: {
    名称: country.武装力量?.名称 ?? '',
    规模: country.武装力量?.规模 ?? '',
    兵役制度: country.武装力量?.兵役制度 ?? '',
    军种: [...(country.武装力量?.军种 ?? [])],
  },
  武装力量法: country.武装力量法 ?? '',
  宗教信仰: country.宗教信仰 ?? '',
  名词定义: (country.名词定义 ?? []).map((definition) => ({
    术语: definition?.术语 ?? '',
    定义: definition?.定义 ?? '',
  })),
  政治: {
    政党: (country.政治?.政党 ?? []).map((party) => ({
      名称: party?.名称 ?? '',
      简介: party?.简介 ?? '',
      主要人物: { ...party?.主要人物 },
    })),
    联盟: (country.政治?.联盟 ?? []).map((alliance) => ({
      联盟名称: alliance?.联盟名称 ?? '',
      政党: (alliance?.政党 ?? []).map((party) => ({
        名称: party?.名称 ?? '',
        简介: party?.简介 ?? '',
        主要人物: { ...party?.主要人物 },
      })),
    })),
    政治状况: country.政治?.政治状况 ? { ...country.政治.政治状况 } : {},
  },
  科技: {
    重工业: country.科技?.重工业 ?? '',
    轻工业: country.科技?.轻工业 ?? '',
    第三产业: country.科技?.第三产业 ?? '',
    航天工业: country.科技?.航天工业 ?? '',
    信息产业: country.科技?.信息产业 ?? '',
    农业: country.科技?.农业 ?? '',
  },
  种族: (country.种族 ?? []).map((ethnicGroup) => ({
    名称: ethnicGroup?.名称 ?? '',
    简介: ethnicGroup?.简介 ?? '',
    文化: ethnicGroup?.文化 ?? '',
    宗教: ethnicGroup?.宗教 ?? '',
  })),
})

const createNormalizedCountryFromUnknown = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return createNormalizedCountry()
  }

  return createNormalizedCountry(value as Partial<CountryData>)
}

// ---- 国土编辑状态与工具 ----
const isEditingLand = ref(false)
const editingPins = ref<{ u: number; v: number; sx: number; sy: number }[]>([])

// 在画布屏幕坐标 -> 纹理坐标 (u,v) 的映射（与 renderWorldGlobe 使用的计算保持一致）
const canvasPixelToUV = (canvasX: number, canvasY: number) => {
  const canvas = globeCanvas.value
  if (!canvas) return null

  const width = canvas.width
  const height = canvas.height
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.42

  const normalizedX = (canvasX - centerX) / radius
  const normalizedY = (centerY - canvasY) / radius
  const distanceSquared = normalizedX * normalizedX + normalizedY * normalizedY
  if (distanceSquared > 1) return null

  const normalizedZ = Math.sqrt(1 - distanceSquared)
  const yaw = rotation.value
  const pitch = tilt.value
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)

  const rotatedY = normalizedY * cosPitch - normalizedZ * sinPitch
  const pitchZ = normalizedY * sinPitch + normalizedZ * cosPitch
  const rotatedX = normalizedX * cosYaw + pitchZ * sinYaw
  const rotatedZ = -normalizedX * sinYaw + pitchZ * cosYaw

  const latitude = Math.asin(Math.max(-1, Math.min(1, rotatedY)))
  const longitude = Math.atan2(rotatedX, rotatedZ)
  const clampedLatitude = Math.max(-maxMercatorLatitude, Math.min(maxMercatorLatitude, latitude))
  const mercatorY = 0.5 - Math.log(Math.tan(Math.PI / 4 + clampedLatitude / 2)) / (2 * Math.PI)
  const u = (longitude + Math.PI) / (2 * Math.PI)
  const v = clamp01(mercatorY)

  return { u, v }
}

// 画布点击处理：放置图钉或结束编辑
const onCanvasPlacePin = (clientX: number, clientY: number) => {
  const canvas = globeCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const sx = Math.round(clientX - rect.left)
  const sy = Math.round(clientY - rect.top)
  const uv = canvasPixelToUV(sx, sy)
  if (!uv) return

  // 如果点击靠近第一个图钉，则认为关闭多边形并尝试保存
  if (editingPins.value.length > 0) {
    const first = editingPins.value[0]
    if (first) {
      const dx = sx - first.sx
      const dy = sy - first.sy
      const dist2 = dx * dx + dy * dy
      if (dist2 < 20 * 20) {
        // 结束编辑
        finishEditingPolygon()
        return
      }
    }
  }

  editingPins.value.push({ u: uv.u, v: uv.v, sx, sy })
  scheduleRenderWorldGlobe()
}

const finishEditingPolygon = () => {
  if (editingPins.value.length < 3) {
    // 不足以形成多边形
    editingPins.value = []
    isEditingLand.value = false
    scheduleRenderWorldGlobe()
    return
  }

  const polygon: [number, number][] = editingPins.value.map((p) => [p.u, p.v])
  // 检查与现有区域是否重合（若任一顶点在对方内则判定为重合）
  const countryName = currentCountry.value?.国家名称?.trim() || ''
  if (!countryName) {
    alert('请选择国家后再添加国土')
    editingPins.value = []
    isEditingLand.value = false
    return
  }

  const existingLand = landMap.value[countryName]
  let overlap = false
  if (existingLand && existingLand.areas.length) {
    for (const area of existingLand.areas) {
      if (polygonsOverlap(polygon, area.vertices)) {
        overlap = true
        break
      }
    }
  }

  if (overlap) {
    alert('新增国土与现有国土存在重合，操作已取消')
    editingPins.value = []
    isEditingLand.value = false
    scheduleRenderWorldGlobe()
    return
  }

  // 添加到国土
  const land = getCountryLand(countryName)
  land.areas.push({ vertices: polygon })
  setCountryLand(countryName, land)

  editingPins.value = []
  isEditingLand.value = false
  scheduleRenderWorldGlobe()
}

// 简单的点-in-多边形（uv 空间）
const pointInPolygon = (pt: [number, number], poly: [number, number][]) => {
  const x = pt[0]
  const y = pt[1]
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]
    const pj = poly[j]
    if (!pi || !pj) continue
    const xi = pi[0]
    const yi = pi[1]
    const xj = pj[0]
    const yj = pj[1]

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi
    if (intersect) inside = !inside
  }
  return inside
}

const bboxOf = (poly: [number, number][]) => {
  let minx = Infinity
  let miny = Infinity
  let maxx = -Infinity
  let maxy = -Infinity
  for (const [x, y] of poly) {
    if (x < minx) minx = x
    if (y < miny) miny = y
    if (x > maxx) maxx = x
    if (y > maxy) maxy = y
  }
  return { minx, miny, maxx, maxy }
}

const bboxOverlap = (a: ReturnType<typeof bboxOf>, b: ReturnType<typeof bboxOf>) =>
  !(a.maxx < b.minx || a.minx > b.maxx || a.maxy < b.miny || a.miny > b.maxy)

const polygonsOverlap = (a: [number, number][], b: [number, number][]) => {
  const bboxA = bboxOf(a)
  const bboxB = bboxOf(b)
  if (!bboxOverlap(bboxA, bboxB)) return false

  // 检查任一顶点在对方内
  for (const p of a) if (pointInPolygon(p, b)) return true
  for (const p of b) if (pointInPolygon(p, a)) return true
  return false
}

type RotatedPoint = { x: number; y: number; z: number }

const uvToRotatedPoint = (u: number, v: number): RotatedPoint => {
  const longitude = u * 2 * Math.PI - Math.PI
  const latitude = 2 * Math.atan(Math.exp((0.5 - v) * 2 * Math.PI)) - Math.PI / 2

  const cosLat = Math.cos(latitude)
  const sphereX = cosLat * Math.sin(longitude)
  const sphereY = Math.sin(latitude)
  const sphereZ = cosLat * Math.cos(longitude)

  const yaw = rotation.value
  const pitch = tilt.value
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(-pitch)
  const sinPitch = Math.sin(-pitch)

  const x1 = cosYaw * sphereX + -sinYaw * sphereZ
  const z1 = sinYaw * sphereX + cosYaw * sphereZ
  const y1 = cosPitch * sphereY + -sinPitch * z1
  const z2 = sinPitch * sphereY + cosPitch * z1

  return { x: x1, y: y1, z: z2 }
}

const lerpRotatedPoint = (a: RotatedPoint, b: RotatedPoint, t: number): RotatedPoint => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

const normalizeRotatedPoint = (point: RotatedPoint): RotatedPoint => {
  const length = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z)
  if (!Number.isFinite(length) || length === 0) {
    return { x: 0, y: 0, z: 1 }
  }

  return {
    x: point.x / length,
    y: point.y / length,
    z: point.z / length,
  }
}

const slerpRotatedPoint = (a: RotatedPoint, b: RotatedPoint, t: number): RotatedPoint => {
  const start = normalizeRotatedPoint(a)
  const end = normalizeRotatedPoint(b)
  const dot = Math.max(-1, Math.min(1, start.x * end.x + start.y * end.y + start.z * end.z))
  const omega = Math.acos(dot)

  if (omega < 1e-6) {
    return normalizeRotatedPoint(lerpRotatedPoint(start, end, t))
  }

  const sinOmega = Math.sin(omega)
  const scaleA = Math.sin((1 - t) * omega) / sinOmega
  const scaleB = Math.sin(t * omega) / sinOmega

  return normalizeRotatedPoint({
    x: start.x * scaleA + end.x * scaleB,
    y: start.y * scaleA + end.y * scaleB,
    z: start.z * scaleA + end.z * scaleB,
  })
}

const projectRotatedPointToHorizon = (point: RotatedPoint): RotatedPoint => {
  const horizontalLength = Math.sqrt(point.x * point.x + point.y * point.y)
  if (!Number.isFinite(horizontalLength) || horizontalLength === 0) {
    return { x: 0, y: 0, z: 0 }
  }

  return {
    x: point.x / horizontalLength,
    y: point.y / horizontalLength,
    z: 0,
  }
}

const buildCurvedPolygonPoints = (points: RotatedPoint[], segmentsPerEdge = 12) => {
  if (points.length < 2) return [] as RotatedPoint[]

  const result: RotatedPoint[] = []
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    if (!current || !next) continue

    if (i === 0) {
      result.push(normalizeRotatedPoint(current))
    }

    for (let step = 1; step <= segmentsPerEdge; step += 1) {
      const t = step / segmentsPerEdge
      result.push(slerpRotatedPoint(current, next, t))
    }
  }

  return result
}

// 将多边形裁剪到前半球（z >= 0），让被地平线遮挡的部分也能沿地平线补齐渲染
const clipPolygonToFrontHemisphere = (points: RotatedPoint[]) => {
  if (points.length < 3) return [] as RotatedPoint[]

  const epsilon = 1e-6
  const horizonSegments = 16

  const isInside = (point: RotatedPoint) => point.z >= -epsilon

  const addHorizonArc = (result: RotatedPoint[], from: RotatedPoint, to: RotatedPoint) => {
    const fromAngle = Math.atan2(from.y, from.x)
    const toAngle = Math.atan2(to.y, to.x)
    let delta = toAngle - fromAngle

    while (delta <= -Math.PI) delta += Math.PI * 2
    while (delta > Math.PI) delta -= Math.PI * 2

    if (Math.abs(delta) < 1e-6) {
      return
    }

    for (let step = 1; step <= horizonSegments; step += 1) {
      const t = step / horizonSegments
      const angle = fromAngle + delta * t
      result.push({ x: Math.cos(angle), y: Math.sin(angle), z: 0 })
    }
  }

  const result: RotatedPoint[] = []
  const startIndex = points.findIndex((point) => isInside(point))
  if (startIndex < 0) {
    return result
  }

  const startPoint = points[startIndex]
  if (!startPoint) {
    return result
  }

  result.push(normalizeRotatedPoint(startPoint))
  let pendingExit: RotatedPoint | null = null

  for (let offset = 1; offset <= points.length; offset += 1) {
    const currentIndex = (startIndex + offset - 1) % points.length
    const nextIndex = (startIndex + offset) % points.length
    const current = points[currentIndex]
    const next = points[nextIndex]
    if (!current || !next) continue
    const currentInside = isInside(current)
    const nextInside = isInside(next)

    if (currentInside && nextInside) {
      if (nextIndex !== startIndex) {
        result.push(normalizeRotatedPoint(next))
      }
      continue
    }

    if (currentInside && !nextInside) {
      const t = current.z / (current.z - next.z)
      const horizonPoint = projectRotatedPointToHorizon(lerpRotatedPoint(current, next, t))
      result.push(horizonPoint)
      pendingExit = horizonPoint
      continue
    }

    if (!currentInside && nextInside) {
      const t = current.z / (current.z - next.z)
      const horizonPoint = projectRotatedPointToHorizon(lerpRotatedPoint(current, next, t))
      if (pendingExit) {
        addHorizonArc(result, pendingExit, horizonPoint)
      }
      result.push(horizonPoint)
      if (nextIndex !== startIndex) {
        result.push(normalizeRotatedPoint(next))
      }
      pendingExit = null
    }
  }

  return result
}

const handleMapUpload = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) return

  const reader = new FileReader()
  reader.onload = () => {
    worldData.value.worldMapImage = String(reader.result ?? '')
  }
  reader.readAsDataURL(file)
}

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('地图图片加载失败'))
    image.src = src
  })

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const maxMercatorLatitude = (85.05112878 * Math.PI) / 180

const wrapTextureX = (value: number, width: number) => ((value % width) + width) % width

const clampTextureY = (value: number, height: number) => Math.min(height - 1, Math.max(0, value))

const sampleTextureChannel = (
  texture: Uint8ClampedArray,
  width: number,
  height: number,
  sampleX: number,
  sampleY: number,
  channelOffset: number,
) => {
  const baseX = Math.floor(sampleX)
  const baseY = Math.floor(sampleY)
  const nextX = baseX + 1
  const nextY = baseY + 1
  const fracX = sampleX - baseX
  const fracY = sampleY - baseY

  const x0 = wrapTextureX(baseX, width)
  const x1 = wrapTextureX(nextX, width)
  const y0 = clampTextureY(baseY, height)
  const y1 = clampTextureY(nextY, height)

  const index00 = (y0 * width + x0) * 4 + channelOffset
  const index10 = (y0 * width + x1) * 4 + channelOffset
  const index01 = (y1 * width + x0) * 4 + channelOffset
  const index11 = (y1 * width + x1) * 4 + channelOffset

  const top = (texture[index00] ?? 0) * (1 - fracX) + (texture[index10] ?? 0) * fracX
  const bottom = (texture[index01] ?? 0) * (1 - fracX) + (texture[index11] ?? 0) * fracX

  return top * (1 - fracY) + bottom * fracY
}

const LAND_OVERLAY_ALPHA = 0.1
const LAND_OVERLAY_R = 255
const LAND_OVERLAY_G = 220
const LAND_OVERLAY_B = 40

// 判断给定 RGB 是否为陆地（与 Python 脚本近似的规则）
const sampleIsLand = (r: number, g: number, b: number, a = 255) => {
  const alphaThreshold = 10
  if (a <= alphaThreshold) return false
  const blueRatio = 1.1
  const blueMargin = 24
  const maxrg = Math.max(r, g)
  const blueIsDominant = b >= maxrg * blueRatio && b >= maxrg + blueMargin
  return !blueIsDominant
}

// 客户端版本：直接在纹理上生成陆地掩码（与 Python 脚本同样的蓝色主导规则）
const generateLandMaskClient = () => {
  if (!globeTextureData || !globeTextureWidth || !globeTextureHeight) return

  const w = globeTextureWidth
  const h = globeTextureHeight
  const mask = new Uint8Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const r = globeTextureData[idx] ?? 0
      const g = globeTextureData[idx + 1] ?? 0
      const b = globeTextureData[idx + 2] ?? 0
      const a = globeTextureData[idx + 3] ?? 255
      mask[y * w + x] = sampleIsLand(r, g, b, a) ? 1 : 0
    }
  }

  globeLandMask = mask
}

const prepareGlobeTexture = async (src: string) => {
  const renderToken = ++globeRenderToken

  try {
    const image = await loadImageElement(src)

    if (renderToken !== globeRenderToken) {
      return false
    }

    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height

    if (!sourceWidth || !sourceHeight) {
      return false
    }

    if (!globeTextureCanvas) {
      globeTextureCanvas = document.createElement('canvas')
    }

    globeTextureCanvas.width = sourceWidth
    globeTextureCanvas.height = sourceHeight

    const sourceContext = globeTextureCanvas.getContext('2d', { willReadFrequently: true })
    if (!sourceContext) {
      return false
    }

    sourceContext.drawImage(image, 0, 0, sourceWidth, sourceHeight)
    globeTextureData = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight).data
    globeTextureWidth = sourceWidth
    globeTextureHeight = sourceHeight

    // 纯前端：直接在客户端根据纹理颜色生成陆地掩码
    globeLandMask = null
    try {
      generateLandMaskClient()
    } catch (err) {
      console.error('客户端生成陆地掩码失败', err)
      globeLandMask = null
    }

    return true
  } catch (error) {
    console.error('Failed to prepare globe texture', error)
    return false
  }
}

const renderWorldGlobe = () => {
  const canvas = globeCanvas.value

  if (!canvas) {
    return
  }

  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    return
  }

  const width = canvas.width
  const height = canvas.height
  context.clearRect(0, 0, width, height)

  if (!globeTextureData || !globeTextureWidth || !globeTextureHeight) {
    return
  }

  const pixels = context.createImageData(width, height)
  const data = pixels.data
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.42
  const yaw = rotation.value
  const pitch = tilt.value
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const lightX = -0.35
  const lightY = 0.35
  const lightZ = 0.87

  for (let y = 0; y < height; y += 1) {
    const normalizedY = (centerY - y) / radius

    for (let x = 0; x < width; x += 1) {
      const normalizedX = (x - centerX) / radius
      const distanceSquared = normalizedX * normalizedX + normalizedY * normalizedY

      if (distanceSquared > 1) {
        continue
      }

      const normalizedZ = Math.sqrt(1 - distanceSquared)

      const rotatedY = normalizedY * cosPitch - normalizedZ * sinPitch
      const pitchZ = normalizedY * sinPitch + normalizedZ * cosPitch
      const rotatedX = normalizedX * cosYaw + pitchZ * sinYaw
      const rotatedZ = -normalizedX * sinYaw + pitchZ * cosYaw

      const latitude = Math.asin(Math.max(-1, Math.min(1, rotatedY)))
      const longitude = Math.atan2(rotatedX, rotatedZ)
      const clampedLatitude = Math.max(
        -maxMercatorLatitude,
        Math.min(maxMercatorLatitude, latitude),
      )
      const mercatorY = 0.5 - Math.log(Math.tan(Math.PI / 4 + clampedLatitude / 2)) / (2 * Math.PI)
      const u = (longitude + Math.PI) / (2 * Math.PI)
      const v = clamp01(mercatorY)
      const brightness =
        0.28 +
        0.72 * Math.max(0.15, normalizedX * lightX + normalizedY * lightY + normalizedZ * lightZ)
      const alpha = 255
      const pixelIndex = (y * width + x) * 4
      const sampleX = u * globeTextureWidth - 0.5
      const sampleY = v * globeTextureHeight - 0.5

      const sampleR = sampleTextureChannel(
        globeTextureData,
        globeTextureWidth,
        globeTextureHeight,
        sampleX,
        sampleY,
        0,
      )
      const sampleG = sampleTextureChannel(
        globeTextureData,
        globeTextureWidth,
        globeTextureHeight,
        sampleX,
        sampleY,
        1,
      )
      const sampleB = sampleTextureChannel(
        globeTextureData,
        globeTextureWidth,
        globeTextureHeight,
        sampleX,
        sampleY,
        2,
      )

      // 判断是否为陆地：优先使用预计算的掩码，否则实时按颜色判断
      let isLand = false
      if (globeLandMask && globeTextureWidth > 0 && globeTextureHeight > 0) {
        const tx = wrapTextureX(Math.floor(u * globeTextureWidth), globeTextureWidth)
        const ty = clampTextureY(Math.floor(v * globeTextureHeight), globeTextureHeight)
        isLand = !!globeLandMask[ty * globeTextureWidth + tx]
      } else {
        isLand = sampleIsLand(Math.round(sampleR), Math.round(sampleG), Math.round(sampleB), 255)
      }

      const baseR = Math.round(sampleR * brightness)
      const baseG = Math.round(sampleG * brightness)
      const baseB = Math.round(sampleB * brightness)

      if (isLand) {
        // 半透明黄色覆盖：在原底色上叠加黄层，而不是直接替换
        const overlayR = LAND_OVERLAY_R
        const overlayG = LAND_OVERLAY_G
        const overlayB = LAND_OVERLAY_B
        data[pixelIndex] = Math.round(
          baseR * (1 - LAND_OVERLAY_ALPHA) + overlayR * LAND_OVERLAY_ALPHA,
        )
        data[pixelIndex + 1] = Math.round(
          baseG * (1 - LAND_OVERLAY_ALPHA) + overlayG * LAND_OVERLAY_ALPHA,
        )
        data[pixelIndex + 2] = Math.round(
          baseB * (1 - LAND_OVERLAY_ALPHA) + overlayB * LAND_OVERLAY_ALPHA,
        )
        data[pixelIndex + 3] = alpha
      } else {
        data[pixelIndex] = baseR
        data[pixelIndex + 1] = baseG
        data[pixelIndex + 2] = baseB
        data[pixelIndex + 3] = alpha
      }
    }
  }

  context.putImageData(pixels, 0, 0)

  // 绘制所有国家的已存在区域：非选中国家为淡色，选中国家为强调色
  const selCountryName = currentCountry.value?.国家名称?.trim() || ''
  if (landMap.value && Object.keys(landMap.value).length) {
    context.save()
    context.lineWidth = 1.5
    for (const [countryName, land] of Object.entries(landMap.value)) {
      if (!land || !land.areas) continue
      const isSelected = countryName === selCountryName
      const countryColor = getCountryColor(countryName)
      for (const area of land.areas) {
        if (!area || !area.vertices || !area.vertices.length) continue
        const rotatedPoints = area.vertices
          .filter((vert): vert is [number, number] => !!vert)
          .map(([u, v]) => uvToRotatedPoint(u, v))
        const curvedPoints = buildCurvedPolygonPoints(rotatedPoints, 16)
        const clippedPoints = clipPolygonToFrontHemisphere(curvedPoints)
        if (clippedPoints.length < 3) continue

        const centerX = canvas.width / 2
        const centerY = canvas.height / 2
        const radius = Math.min(canvas.width, canvas.height) * 0.42

        context.beginPath()
        for (let i = 0; i < clippedPoints.length; i += 1) {
          const point = clippedPoints[i]
          if (!point) continue
          const sx = centerX + point.x * radius
          const sy = centerY - point.y * radius
          if (i === 0) {
            context.moveTo(sx, sy)
          } else {
            context.lineTo(sx, sy)
          }
        }
        context.closePath()

        context.fillStyle = isSelected
          ? withColorAlpha(countryColor, 0.22)
          : withColorAlpha(countryColor, 0.2)
        context.strokeStyle = isSelected
          ? withColorAlpha(countryColor, 0.95)
          : withColorAlpha(countryColor, 0.65)
        context.lineWidth = isSelected ? 2 : 1
        context.fill()
        context.stroke()
      }
    }
    context.restore()
  }

  // 绘制当前正在编辑的图钉与连线
  if (isEditingLand.value && editingPins.value.length) {
    context.save()
    context.strokeStyle = 'rgba(40,120,240,0.95)'
    context.fillStyle = 'rgba(40,120,240,0.95)'
    context.lineWidth = 2
    context.beginPath()
    for (let i = 0; i < editingPins.value.length; i++) {
      const p = editingPins.value[i]
      if (!p) continue
      if (i === 0) context.moveTo(p.sx, p.sy)
      else context.lineTo(p.sx, p.sy)
    }
    context.stroke()
    for (const p of editingPins.value) {
      context.beginPath()
      context.arc(p.sx, p.sy, 6, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }
}

const scheduleRenderWorldGlobe = () => {
  if (globeRenderRaf !== null) {
    return
  }

  globeRenderRaf = window.requestAnimationFrame(() => {
    globeRenderRaf = null
    renderWorldGlobe()
  })
}

// 鼠标/触控拖拽交互：更新 rotation 并重渲染
const onPointerDown = (e: PointerEvent) => {
  // 编辑模式：左键（或触控）放置图钉，右键继续拖拽地图
  if (isEditingLand.value) {
    if (!globeCanvas.value) return

    if (e.pointerType !== 'touch' && e.button === 2) {
      isDragging.value = true
      dragStartX.value = e.clientX
      dragStartY.value = e.clientY
      startRotation.value = rotation.value
      startTilt.value = tilt.value
      activePointerId.value = e.pointerId

      try {
        globeCanvas.value.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      return
    }

    if (e.pointerType !== 'touch' && e.button !== 0) return
    onCanvasPlacePin(e.clientX, e.clientY)
    return
  }

  // 非编辑模式：仅响应右键或触控开始拖拽（将左键保留给编辑）
  if (e.pointerType !== 'touch' && e.button !== 2) return

  if (!globeCanvas.value) return

  isDragging.value = true
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  startRotation.value = rotation.value
  startTilt.value = tilt.value
  activePointerId.value = e.pointerId

  try {
    globeCanvas.value.setPointerCapture(e.pointerId)
  } catch {
    // ignore
  }
}

const onPointerMove = (e: PointerEvent) => {
  if (!isDragging.value || e.pointerId !== activePointerId.value) return
  const canvas = globeCanvas.value
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  const radius = Math.min(rect.width, rect.height) * 0.42
  const dx = e.clientX - dragStartX.value
  const dy = e.clientY - dragStartY.value
  // 将像素位移映射为弧度偏移，方向取反以匹配拖动方向
  const deltaX = (dx / Math.max(1, radius)) * -1
  const deltaY = (dy / Math.max(1, radius)) * -1
  rotation.value = startRotation.value + deltaX
  tilt.value = Math.max(-1.45, Math.min(1.45, startTilt.value + deltaY))

  scheduleRenderWorldGlobe()
}

const endPointerDrag = (e: PointerEvent) => {
  if (e && activePointerId.value !== null && e.pointerId !== activePointerId.value) return
  if (globeCanvas.value && activePointerId.value !== null) {
    try {
      globeCanvas.value.releasePointerCapture(activePointerId.value)
    } catch {
      // ignore
    }
  }

  isDragging.value = false
  activePointerId.value = null
}

const attachGlobeListeners = (canvas: HTMLCanvasElement) => {
  // 先解除旧的监听
  if (removeGlobeListeners) {
    removeGlobeListeners()
    removeGlobeListeners = null
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', endPointerDrag)
  canvas.addEventListener('pointercancel', endPointerDrag)
  // 禁止右键菜单以便使用右键拖拽
  const ctxHandler = (ev: Event) => ev.preventDefault()
  canvas.addEventListener('contextmenu', ctxHandler)

  removeGlobeListeners = () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', endPointerDrag)
    canvas.removeEventListener('pointercancel', endPointerDrag)
    canvas.removeEventListener('contextmenu', ctxHandler)
  }
}

const normalizeCountries = (data: unknown): CountryData[] => {
  if (Array.isArray(data)) {
    return data.map((item) => {
      const country = createNormalizedCountryFromUnknown(item)
      if (isRecord(item)) {
        applyCountryMetadata(country.国家名称.trim(), item)
      }
      return country
    })
  }

  if (data && typeof data === 'object') {
    const maybeWorld = data as { countries?: unknown }

    if (Array.isArray(maybeWorld.countries)) {
      return maybeWorld.countries.map((item) => {
        const country = createNormalizedCountryFromUnknown(item)
        if (isRecord(item)) {
          applyCountryMetadata(country.国家名称.trim(), item)
        }
        return country
      })
    }

    const country = createNormalizedCountryFromUnknown(data)
    applyCountryMetadata(country.国家名称.trim(), data)
    return [country]
  }

  return []
}

const getCountryNameKey = (country: CountryData) => country.国家名称.trim()

const upsertCountries = (countries: CountryData[]) => {
  for (const country of countries) {
    const countryName = getCountryNameKey(country)

    if (!countryName) {
      worldData.value.countries.push(country)
      continue
    }

    const existingIndex = worldData.value.countries.findIndex(
      (existingCountry) => getCountryNameKey(existingCountry) === countryName,
    )

    if (existingIndex >= 0) {
      worldData.value.countries.splice(existingIndex, 1, country)
      continue
    }

    worldData.value.countries.push(country)
  }
}

const handleCountryJsonImport = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  countryJsonError.value = ''

  if (!file) return

  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as unknown
    const countries = normalizeCountries(parsed)

    if (!countries.length) {
      countryJsonError.value = 'JSON 内容为空或格式不正确。'
      return
    }

    upsertCountries(countries)
    input.value = ''
  } catch (error) {
    countryJsonError.value = '国家 JSON 读取失败，请确认文件内容是有效的 JSON。'
    console.error('Failed to import country json', error)
  }
}

const handleWorldJsonImport = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  worldJsonError.value = ''

  if (!file) return

  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as unknown

    const nextWorldData = createEmptyWorldData()

    if (Array.isArray(parsed)) {
      nextWorldData.countries = normalizeCountries(parsed)
    } else if (parsed && typeof parsed === 'object') {
      const maybeWorld = parsed as {
        countries?: unknown
        worldMapImage?: unknown
        landMap?: unknown
        countryColorMap?: unknown
      }

      if (Array.isArray(maybeWorld.countries)) {
        nextWorldData.countries = normalizeCountries(maybeWorld.countries)
      }

      if (typeof maybeWorld.worldMapImage === 'string') {
        nextWorldData.worldMapImage = maybeWorld.worldMapImage
      }

      if (isRecord(maybeWorld.landMap)) {
        const savedLandMap = maybeWorld.landMap as Record<string, unknown>
        for (const [countryName, landValue] of Object.entries(savedLandMap)) {
          if (!isRecord(landValue) || !Array.isArray((landValue as { areas?: unknown }).areas))
            continue
          const savedAreas = (landValue as { areas: unknown[] }).areas
          const areas = savedAreas
            .map((area: unknown) => {
              if (!isRecord(area) || !Array.isArray((area as { vertices?: unknown }).vertices))
                return null
              const savedVertices = (area as { vertices: unknown[] }).vertices
              const vertices = savedVertices
                .filter(
                  (vertex: unknown): vertex is [number, number] =>
                    Array.isArray(vertex) && vertex.length >= 2,
                )
                .map(
                  (vertex: [number, number]) =>
                    [Number(vertex[0]), Number(vertex[1])] as [number, number],
                )
              return vertices.length ? { vertices } : null
            })
            .filter((area): area is { vertices: [number, number][] } => !!area)

          if (areas.length) {
            setCountryLand(countryName, { areas })
          }
        }
      }

      if (isRecord(maybeWorld.countryColorMap)) {
        const savedCountryColorMap = maybeWorld.countryColorMap as Record<string, unknown>
        for (const [countryName, colorValue] of Object.entries(savedCountryColorMap)) {
          if (typeof colorValue === 'string' && colorValue.trim()) {
            setCountryColor(countryName, colorValue)
          }
        }
      }
    }

    if (!nextWorldData.countries.length && !nextWorldData.worldMapImage) {
      worldJsonError.value = 'JSON 内容为空或格式不正确。'
      return
    }

    worldData.value = nextWorldData
    input.value = ''
  } catch (error) {
    worldJsonError.value = '世界观 JSON 读取失败，请确认文件内容是有效的 JSON。'
    console.error('Failed to import world json', error)
  }
}

const removeCountry = (index: number) => {
  worldData.value.countries.splice(index, 1)
}

const addStringItem = (items: string[]) => {
  items.push('')
}

const removeStringItem = (items: string[], index: number) => {
  items.splice(index, 1)
}

const startEditingLand = () => {
  editingPins.value = []
  isEditingLand.value = true
  scheduleRenderWorldGlobe()
}

const cancelEditingLand = () => {
  editingPins.value = []
  isEditingLand.value = false
  scheduleRenderWorldGlobe()
}

const removeArea = (index: number) => {
  const countryName = currentCountry.value?.国家名称?.trim() || ''
  if (!countryName) return
  const land = peekCountryLand(countryName)
  if (!land || !land.areas || index < 0 || index >= land.areas.length) return

  const nextAreas = land.areas.filter((_, areaIndex) => areaIndex !== index)
  if (!nextAreas.length) {
    removeCountryLand(countryName)
  } else {
    setCountryLand(countryName, { ...land, areas: nextAreas })
  }
  scheduleRenderWorldGlobe()
}

const addRecordItem = (record: Record<string, string>, defaultKey: string) => {
  let nextKey = defaultKey.trim() || '新项'
  let suffix = 1

  while (Object.prototype.hasOwnProperty.call(record, nextKey)) {
    nextKey = `${defaultKey}${suffix}`
    suffix += 1
  }

  record[nextKey] = ''
}

const removeRecordItem = (record: Record<string, string>, key: string) => {
  delete record[key]
}

const renameRecordKey = (record: Record<string, string>, oldKey: string, event: Event) => {
  const nextKey = (event.target as HTMLInputElement).value.trim()

  if (!nextKey || nextKey === oldKey) {
    return
  }

  const value = record[oldKey] ?? ''
  delete record[oldKey]
  record[nextKey] = value
}

const setRecordValue = (record: Record<string, string>, key: string, event: Event) => {
  record[key] = (event.target as HTMLInputElement).value
}

type SerializableCountry = CountryData & {
  land?: LandData
  countryColor?: string
}

const serializeCountryForJson = (country: CountryData): SerializableCountry => {
  const countryName = getCountryNameKey(country)
  const land = peekCountryLand(countryName)
  const countryColor = peekCountryColor(countryName) ?? getCountryColor(countryName)

  return {
    ...country,
    ...(land ? { land } : {}),
    ...(countryColor ? { countryColor } : {}),
  }
}

const serializeWorldForJson = () => ({
  ...worldData.value,
  countries: worldData.value.countries.map((country) => serializeCountryForJson(country)),
})

const applyCountryMetadata = (countryName: string, value: unknown) => {
  if (!value || typeof value !== 'object') return

  const meta = value as { land?: unknown; countryColor?: unknown; color?: unknown }

  if (meta.land && isRecord(meta.land)) {
    const savedLand = meta.land as { areas?: unknown }
    const areas = Array.isArray(savedLand.areas) ? savedLand.areas : []

    const normalizedAreas = areas
      .map((area: unknown) => {
        if (!isRecord(area) || !Array.isArray((area as { vertices?: unknown }).vertices))
          return null

        const savedVertices = (area as { vertices: unknown[] }).vertices
        const vertices = savedVertices
          .filter(
            (vertex: unknown): vertex is [number, number] =>
              Array.isArray(vertex) && vertex.length >= 2,
          )
          .map(
            (vertex: [number, number]) =>
              [Number(vertex[0]), Number(vertex[1])] as [number, number],
          )

        return vertices.length ? { vertices } : null
      })
      .filter((area): area is { vertices: [number, number][] } => !!area)

    if (normalizedAreas.length) {
      setCountryLand(countryName, { areas: normalizedAreas })
    }
  }

  const nextColor =
    typeof meta.countryColor === 'string'
      ? meta.countryColor
      : typeof meta.color === 'string'
        ? meta.color
        : ''

  if (nextColor) {
    setCountryColor(countryName, nextColor)
  }
}

const addCity = (country: CountryData) => {
  country.城市.push(createEmptyCityData())
}

const removeCity = (country: CountryData, index: number) => {
  country.城市.splice(index, 1)
}

const addDefinition = (country: CountryData) => {
  country.名词定义.push(createEmptyDefinitionData())
}

const removeDefinition = (country: CountryData, index: number) => {
  country.名词定义.splice(index, 1)
}

const addAlliance = (country: CountryData) => {
  country.政治.联盟.push(createEmptyAllianceData())
}

const removeAlliance = (country: CountryData, index: number) => {
  country.政治.联盟.splice(index, 1)
}

const addParty = (parties: Party[]) => {
  parties.push(createEmptyPartyData())
}

const removeParty = (parties: Party[], index: number) => {
  parties.splice(index, 1)
}

const addEthnicGroup = (country: CountryData) => {
  country.种族.push(createEmptyEthnicGroupData())
}

const removeEthnicGroup = (country: CountryData, index: number) => {
  country.种族.splice(index, 1)
}

const createSafeFileName = (value: string) => {
  const safeName = value.trim().replace(/[/:*?"<>|]+/g, '_')

  return safeName || 'country'
}

const downloadCountryJson = (country: CountryData) => {
  const json = JSON.stringify(serializeCountryForJson(country), null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = `${createSafeFileName(country.国家名称)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

const downloadCountryListJson = () => {
  const json = JSON.stringify(
    worldData.value.countries.map((country) => serializeCountryForJson(country)),
    null,
    2,
  )
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = 'countries.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

const downloadWorldJson = () => {
  const json = JSON.stringify(
    {
      ...serializeWorldForJson(),
      landMap: listCountryLands(),
      countryColorMap: { ...countryColorMap.value },
    },
    null,
    2,
  )
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = 'world.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

const triggerCountryJsonImport = () => {
  countryJsonInput.value?.click()
}

const triggerSingleCountryJsonImport = () => {
  countryJsonInput.value?.click()
}

const triggerWorldJsonImport = () => {
  worldJsonInput.value?.click()
}

onMounted(() => {
  // 从 sessionStorage 加载草稿（在标签页内持久化，关闭标签页后清除）
  try {
    const draftJson = window.sessionStorage.getItem(SESSION_DRAFT_KEY)
    if (draftJson) {
      restoreWorldDraft(JSON.parse(draftJson))
    }
  } catch (err) {
    console.error('Failed to load world draft from sessionStorage', err)
  }

  // 还会导入一个来自 text-to-json 的临时 JSON，然后移除该临时键
  const json = window.localStorage.getItem('copiedCountryJson')
  if (json) {
    try {
      const parsed = JSON.parse(json)
      const countries = normalizeCountries(parsed)

      if (countries.length) {
        upsertCountries(countries)
      }
    } catch (err) {
      console.error('Failed to import copiedCountryJson', err)
    } finally {
      window.localStorage.removeItem('copiedCountryJson')
    }
  }

  // 在 DOM 更新后绑定拖拽事件（如果 canvas 存在）
  void nextTick().then(() => {
    if (globeCanvas.value) {
      attachGlobeListeners(globeCanvas.value)
    }
  })
  // 暴露调试用的国土帮助函数到 window（便于在控制台调用）
  try {
    const win = window as unknown as { __landHelpers?: unknown }
    win.__landHelpers = {
      getCountryLand,
      listCountryLands,
      setCountryLand,
      removeCountryLand,
    }
  } catch {
    // ignore
  }
})

onBeforeUnmount(() => {
  if (removeGlobeListeners) {
    removeGlobeListeners()
    removeGlobeListeners = null
  }
})

// 将 worldData 保存到 sessionStorage，以便在同一标签页内导航时保留
watch(worldData, () => saveWorldDraft(), { deep: true })

watch(landMap, () => saveWorldDraft(), { deep: true })

watch(countryColorMap, () => saveWorldDraft(), { deep: true })

// 当国家数组变化时，修正 currentCountryIndex 的范围
watch(
  () => worldData.value.countries.length,
  (len) => {
    if (!len) {
      currentCountryIndex.value = 0
      return
    }

    // 环绕计数以确保索引在有效范围内
    currentCountryIndex.value = ((currentCountryIndex.value % len) + len) % len
  },
)

watch(
  () => currentCountryIndex.value,
  () => {
    scheduleRenderWorldGlobe()
  },
)

// 当国家列表变化时，同步 landMap：为新国家初始化空国土，移除已删除国家的映射
watch(
  () => worldData.value.countries.map((c) => c.国家名称?.trim() || ''),
  (names) => {
    const existingLandKeys = new Set(Object.keys(landMap.value))
    const existingColorKeys = new Set(Object.keys(countryColorMap.value))
    for (const name of names) {
      if (!name) continue
      existingLandKeys.delete(name)
      existingColorKeys.delete(name)
      if (!(name in landMap.value)) {
        setCountryLand(name, createEmptyLandData())
      }
      if (!(name in countryColorMap.value)) {
        setCountryColor(name, createCountryColor(name))
      }
    }

    // 删除那些不再存在的键
    for (const leftover of existingLandKeys) {
      removeCountryLand(leftover)
    }
    for (const leftover of existingColorKeys) {
      removeCountryColor(leftover)
    }
  },
)

watch(
  () => worldData.value.worldMapImage,
  async (src) => {
    globeTextureData = null
    globeTextureWidth = 0
    globeTextureHeight = 0

    if (!src) {
      scheduleRenderWorldGlobe()
      return
    }

    const prepared = await prepareGlobeTexture(src)
    if (!prepared) {
      return
    }

    void nextTick().then(() => {
      scheduleRenderWorldGlobe()
      if (globeCanvas.value) attachGlobeListeners(globeCanvas.value)
    })
  },
)

const prevCountry = () => {
  const len = worldData.value.countries.length
  if (!len) return
  currentCountryIndex.value = (currentCountryIndex.value - 1 + len) % len
}

const nextCountry = () => {
  const len = worldData.value.countries.length
  if (!len) return
  currentCountryIndex.value = (currentCountryIndex.value + 1) % len
}
</script>

<template>
  <main class="page-shell">
    <div class="page-title-row">
      <h1>世界生成</h1>
      <div class="title-actions">
        <button type="button" @click="triggerWorldJsonImport">导入世界观 JSON</button>
        <button type="button" @click="downloadWorldJson">导出世界观 JSON</button>
      </div>
    </div>

    <section class="panel">
      <label class="label">上传世界地图（PNG/JPEG）</label>
      <input type="file" accept="image/*" @change="handleMapUpload" />
      <div v-if="worldData.worldMapImage" class="map-preview">
        <h3>球面预览</h3>
        <div class="map-preview-row" style="display: flex; gap: 16px; align-items: flex-start">
          <div style="flex: 0 0 720px">
            <canvas ref="globeCanvas" class="globe-canvas" width="720" height="720" />
          </div>
          <aside class="land-preview-card" style="flex: 1; min-width: 260px">
            <h4>当前国家国土</h4>
            <div v-if="!currentCountry || !currentCountry.国家名称">请选择一个国家以查看国土</div>
            <div v-else>
              <div style="margin-bottom: 8px">
                <strong>{{ currentCountry.国家名称 }}</strong>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
                <span
                  :style="{
                    width: '14px',
                    height: '14px',
                    borderRadius: '999px',
                    background: currentCountryColor,
                    border: '1px solid rgba(255,255,255,0.25)',
                    display: 'inline-block',
                  }"
                />
                <span>颜色：{{ currentCountryColor }}</span>
              </div>
              <div
                style="
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 8px;
                  margin-bottom: 12px;
                "
              >
                <label style="display: flex; flex-direction: column; gap: 4px">
                  <span>R</span>
                  <input
                    type="number"
                    min="0"
                    max="255"
                    :value="currentCountryColorRgb.r"
                    @input="
                      updateCurrentCountryColorChannel(
                        'r',
                        Number(($event.target as HTMLInputElement).value),
                      )
                    "
                  />
                </label>
                <label style="display: flex; flex-direction: column; gap: 4px">
                  <span>G</span>
                  <input
                    type="number"
                    min="0"
                    max="255"
                    :value="currentCountryColorRgb.g"
                    @input="
                      updateCurrentCountryColorChannel(
                        'g',
                        Number(($event.target as HTMLInputElement).value),
                      )
                    "
                  />
                </label>
                <label style="display: flex; flex-direction: column; gap: 4px">
                  <span>B</span>
                  <input
                    type="number"
                    min="0"
                    max="255"
                    :value="currentCountryColorRgb.b"
                    @input="
                      updateCurrentCountryColorChannel(
                        'b',
                        Number(($event.target as HTMLInputElement).value),
                      )
                    "
                  />
                </label>
              </div>
              <div style="margin-bottom: 8px">
                <button type="button" @click="startEditingLand" :disabled="isEditingLand">
                  添加区域（进入编辑）
                </button>
                <button type="button" @click="cancelEditingLand" v-if="isEditingLand">
                  取消编辑
                </button>
              </div>

              <div
                v-if="!currentCountryLand || !currentCountryLand.areas.length"
                class="empty-hint"
              >
                当前国家暂无已保存区域
              </div>

              <ol v-else>
                <li
                  v-for="(area, idx) in currentCountryLand.areas"
                  :key="idx"
                  style="margin-bottom: 8px"
                >
                  区域 {{ idx + 1 }} - 顶点 {{ area.vertices.length }}
                  <div style="margin-top: 6px">
                    <button type="button" @click="removeArea(idx)">删除</button>
                  </div>
                </li>
              </ol>
            </div>

            <div style="margin-top: 16px">
              <h5 style="margin-bottom: 8px">国家-颜色</h5>
              <div v-if="!countryColorEntries.length" class="empty-hint">暂无颜色数据</div>
              <ul v-else style="padding-left: 0; list-style: none; margin: 0">
                <li
                  v-for="[countryName, color] in countryColorEntries"
                  :key="countryName"
                  style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px"
                >
                  <span
                    :style="{
                      width: '12px',
                      height: '12px',
                      borderRadius: '999px',
                      background: color,
                      border: '1px solid rgba(255,255,255,0.25)',
                      display: 'inline-block',
                      flex: '0 0 auto',
                    }"
                  />
                  <span
                    style="
                      min-width: 0;
                      overflow: hidden;
                      text-overflow: ellipsis;
                      white-space: nowrap;
                    "
                  >
                    {{ countryName }}
                  </span>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
      <div v-else class="empty-hint globe-empty-hint">
        请先上传一张墨卡托投影世界地图，页面会自动转换为球面。
      </div>
    </section>

    <section class="panel">
      <div class="panel-title-row">
        <h2>国家</h2>
        <div class="title-actions">
          <button type="button" @click="triggerCountryJsonImport">导入国家列表 JSON</button>
          <button type="button" @click="downloadCountryListJson">导出国家列表 JSON</button>
        </div>
      </div>
      <input
        ref="countryJsonInput"
        hidden
        type="file"
        accept="application/json,.json"
        @change="handleCountryJsonImport"
      />
      <input
        ref="worldJsonInput"
        hidden
        type="file"
        accept="application/json,.json"
        @change="handleWorldJsonImport"
      />
      <p v-if="countryJsonError" class="error-text">{{ countryJsonError }}</p>
      <p v-if="worldJsonError" class="error-text">{{ worldJsonError }}</p>

      <div class="country-export-row">
        <button type="button" @click="triggerSingleCountryJsonImport">导入单个国家 JSON</button>
        <button type="button" @click="downloadCountryJson(currentCountry)">
          导出单个国家 JSON
        </button>
      </div>

      <div class="country-list">
        <div class="country-pagination-controls">
          <button
            type="button"
            class="submit-button"
            @click="prevCountry"
            :disabled="!worldData.countries.length"
          >
            上一国
          </button>
          <span v-if="worldData.countries.length" class="pagination-indicator"
            >{{ currentCountryIndex + 1 }} / {{ worldData.countries.length }}</span
          >
          <button
            type="button"
            class="submit-button"
            @click="nextCountry"
            :disabled="!worldData.countries.length"
          >
            下一国
          </button>
        </div>

        <article v-if="worldData.countries.length" :key="currentCountryIndex" class="country-card">
          <div class="country-header">
            <div class="country-title-block">
              <label class="field-label" :for="`country-name-${currentCountryIndex}`"
                >国家名称</label
              >
              <input
                :id="`country-name-${currentCountryIndex}`"
                v-model="currentCountry.国家名称"
                class="field-input"
                type="text"
                placeholder="请输入国家名称"
              />
            </div>
            <div class="country-actions">
              <button type="button" @click="removeCountry(currentCountryIndex)">删除</button>
            </div>
          </div>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>人口</h3>
            </div>
            <div class="field-grid indent-1">
              <div class="field-block">
                <label class="field-label" :for="`country-population-${currentCountryIndex}`"
                  >总数</label
                >
                <input
                  :id="`country-population-${currentCountryIndex}`"
                  v-model.number="currentCountry.人口.总数"
                  class="field-input"
                  type="number"
                />
              </div>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>种族比例</h4>
                <button
                  type="button"
                  @click="addRecordItem(currentCountry.人口.种族比例, '新种族')"
                >
                  添加项
                </button>
              </div>
              <div
                v-if="!Object.keys(currentCountry.人口.种族比例).length"
                class="empty-hint indent-2"
              >
                暂无种族比例
              </div>
              <div
                v-for="(ratioValue, ratioKey) in currentCountry.人口.种族比例"
                :key="ratioKey"
                class="json-record-row indent-2"
              >
                <input
                  :value="ratioKey"
                  class="field-input json-key-input"
                  type="text"
                  @change="renameRecordKey(currentCountry.人口.种族比例, ratioKey, $event)"
                />
                <input
                  :value="ratioValue"
                  class="field-input"
                  type="text"
                  @input="setRecordValue(currentCountry.人口.种族比例, ratioKey, $event)"
                />
                <button
                  type="button"
                  @click="removeRecordItem(currentCountry.人口.种族比例, ratioKey)"
                >
                  删除
                </button>
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <h3>基本信息</h3>
            <div class="field-grid">
              <div class="field-block">
                <label class="field-label">政治制度</label>
                <input v-model="currentCountry.政治制度" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">经济状况</label>
                <textarea
                  v-model="currentCountry.经济状况"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">国歌</label>
                <input v-model="currentCountry.国歌" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">货币</label>
                <input v-model="currentCountry.货币" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">武装力量法</label>
                <textarea
                  v-model="currentCountry.武装力量法"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">宗教信仰</label>
                <textarea
                  v-model="currentCountry.宗教信仰"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <h3>武装力量</h3>
            <div class="field-grid indent-1">
              <div class="field-block">
                <label class="field-label">名称</label>
                <input v-model="currentCountry.武装力量.名称" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">规模</label>
                <input v-model="currentCountry.武装力量.规模" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">兵役制度</label>
                <input v-model="currentCountry.武装力量.兵役制度" class="field-input" type="text" />
              </div>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>军种</h4>
                <button type="button" @click="addStringItem(currentCountry.武装力量.军种)">
                  添加军种
                </button>
              </div>
              <div v-if="!currentCountry.武装力量.军种.length" class="empty-hint indent-2">
                暂无军种
              </div>
              <div
                v-for="(branch, branchIndex) in currentCountry.武装力量.军种"
                :key="branchIndex"
                class="json-array-row indent-2"
              >
                <input
                  v-model="currentCountry.武装力量.军种[branchIndex]"
                  class="field-input"
                  type="text"
                />
                <button
                  type="button"
                  @click="removeStringItem(currentCountry.武装力量.军种, branchIndex)"
                >
                  删除
                </button>
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>城市</h3>
              <button type="button" @click="addCity(currentCountry)">添加城市</button>
            </div>
            <div v-if="!currentCountry.城市.length" class="empty-hint indent-1">暂无城市</div>

            <article
              v-for="(city, cityIndex) in currentCountry.城市"
              :key="cityIndex"
              class="json-object-card indent-1"
            >
              <div class="json-object-card-header">
                <strong>城市 {{ cityIndex + 1 }}</strong>
                <button type="button" @click="removeCity(currentCountry, cityIndex)">删除</button>
              </div>
              <div class="field-grid indent-1">
                <div class="field-block">
                  <label class="field-label">名称</label>
                  <input v-model="city.名称" class="field-input" type="text" />
                </div>
                <div class="field-block">
                  <label class="field-label">简介</label>
                  <textarea v-model="city.简介" class="field-input field-textarea" rows="3" />
                </div>
                <div class="field-block">
                  <label class="field-label">经济状况</label>
                  <textarea v-model="city.经济状况" class="field-input field-textarea" rows="3" />
                </div>
                <div class="field-block">
                  <label class="field-label">政治状况</label>
                  <textarea v-model="city.政治状况" class="field-input field-textarea" rows="3" />
                </div>
              </div>

              <div class="json-section indent-1">
                <div class="json-section-header">
                  <h4>人口比例</h4>
                  <button type="button" @click="addRecordItem(city.人口比例, '新种族')">
                    添加项
                  </button>
                </div>
                <div v-if="!Object.keys(city.人口比例).length" class="empty-hint indent-2">
                  暂无人口比例
                </div>
                <div
                  v-for="(value, key) in city.人口比例"
                  :key="key"
                  class="json-record-row indent-2"
                >
                  <input
                    :value="key"
                    class="field-input json-key-input"
                    type="text"
                    @change="renameRecordKey(city.人口比例, key, $event)"
                  />
                  <input
                    :value="value"
                    class="field-input"
                    type="text"
                    @input="setRecordValue(city.人口比例, key, $event)"
                  />
                  <button type="button" @click="removeRecordItem(city.人口比例, key)">删除</button>
                </div>
              </div>
            </article>
          </section>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>名词定义</h3>
              <button type="button" @click="addDefinition(currentCountry)">添加定义</button>
            </div>
            <div v-if="!currentCountry.名词定义.length" class="empty-hint indent-1">
              暂无名词定义
            </div>
            <article
              v-for="(definition, definitionIndex) in currentCountry.名词定义"
              :key="definitionIndex"
              class="json-object-card indent-1"
            >
              <div class="json-object-card-header">
                <strong>定义 {{ definitionIndex + 1 }}</strong>
                <button type="button" @click="removeDefinition(currentCountry, definitionIndex)">
                  删除
                </button>
              </div>
              <div class="field-grid indent-1">
                <div class="field-block">
                  <label class="field-label">术语</label>
                  <input v-model="definition.术语" class="field-input" type="text" />
                </div>
                <div class="field-block">
                  <label class="field-label">定义</label>
                  <textarea v-model="definition.定义" class="field-input field-textarea" rows="3" />
                </div>
              </div>
            </article>
          </section>

          <section class="json-section indent-1">
            <h3>政治</h3>
            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>政党</h4>
                <button type="button" @click="addParty(currentCountry.政治.政党)">添加政党</button>
              </div>
              <div v-if="!currentCountry.政治.政党.length" class="empty-hint indent-2">
                暂无政党
              </div>
              <article
                v-for="(party, partyIndex) in currentCountry.政治.政党"
                :key="partyIndex"
                class="json-object-card indent-2"
              >
                <div class="json-object-card-header">
                  <strong>政党 {{ partyIndex + 1 }}</strong>
                  <button type="button" @click="removeParty(currentCountry.政治.政党, partyIndex)">
                    删除
                  </button>
                </div>
                <div class="field-grid indent-1">
                  <div class="field-block">
                    <label class="field-label">名称</label>
                    <input v-model="party.名称" class="field-input" type="text" />
                  </div>
                  <div class="field-block">
                    <label class="field-label">简介</label>
                    <textarea v-model="party.简介" class="field-input field-textarea" rows="3" />
                  </div>
                </div>
                <div class="json-section indent-1">
                  <div class="json-section-header">
                    <h5>主要人物</h5>
                    <button type="button" @click="addRecordItem(party.主要人物, '新人物')">
                      添加项
                    </button>
                  </div>
                  <div v-if="!Object.keys(party.主要人物).length" class="empty-hint indent-2">
                    暂无主要人物
                  </div>
                  <div
                    v-for="(personEthnicity, personName) in party.主要人物"
                    :key="personName"
                    class="json-record-row indent-2"
                  >
                    <input
                      :value="personName"
                      class="field-input json-key-input"
                      type="text"
                      @change="renameRecordKey(party.主要人物, personName, $event)"
                    />
                    <input
                      :value="personEthnicity"
                      class="field-input"
                      type="text"
                      @input="setRecordValue(party.主要人物, personName, $event)"
                    />
                    <button type="button" @click="removeRecordItem(party.主要人物, personName)">
                      删除
                    </button>
                  </div>
                </div>
              </article>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>联盟</h4>
                <button type="button" @click="addAlliance(currentCountry)">添加联盟</button>
              </div>
              <div v-if="!currentCountry.政治.联盟.length" class="empty-hint indent-2">
                暂无联盟
              </div>
              <article
                v-for="(alliance, allianceIndex) in currentCountry.政治.联盟"
                :key="allianceIndex"
                class="json-object-card indent-2"
              >
                <div class="json-object-card-header">
                  <strong>联盟 {{ allianceIndex + 1 }}</strong>
                  <button type="button" @click="removeAlliance(currentCountry, allianceIndex)">
                    删除
                  </button>
                </div>
                <div class="field-grid indent-1">
                  <div class="field-block">
                    <label class="field-label">联盟名称</label>
                    <input v-model="alliance.联盟名称" class="field-input" type="text" />
                  </div>
                </div>
                <div class="json-section indent-1">
                  <div class="json-section-header">
                    <h5>政党</h5>
                    <button type="button" @click="addParty(alliance.政党)">添加政党</button>
                  </div>
                  <div v-if="!alliance.政党.length" class="empty-hint indent-2">暂无政党</div>
                  <article
                    v-for="(party, partyIndex) in alliance.政党"
                    :key="partyIndex"
                    class="json-object-card indent-2"
                  >
                    <div class="json-object-card-header">
                      <strong>政党 {{ partyIndex + 1 }}</strong>
                      <button type="button" @click="removeParty(alliance.政党, partyIndex)">
                        删除
                      </button>
                    </div>
                    <div class="field-grid indent-1">
                      <div class="field-block">
                        <label class="field-label">名称</label>
                        <input v-model="party.名称" class="field-input" type="text" />
                      </div>
                      <div class="field-block">
                        <label class="field-label">简介</label>
                        <textarea
                          v-model="party.简介"
                          class="field-input field-textarea"
                          rows="3"
                        />
                      </div>
                    </div>
                    <div class="json-section indent-1">
                      <div class="json-section-header">
                        <h5>主要人物</h5>
                        <button type="button" @click="addRecordItem(party.主要人物, '新人物')">
                          添加项
                        </button>
                      </div>
                      <div v-if="!Object.keys(party.主要人物).length" class="empty-hint indent-2">
                        暂无主要人物
                      </div>
                      <div
                        v-for="(personEthnicity, personName) in party.主要人物"
                        :key="personName"
                        class="json-record-row indent-2"
                      >
                        <input
                          :value="personName"
                          class="field-input json-key-input"
                          type="text"
                          @change="renameRecordKey(party.主要人物, personName, $event)"
                        />
                        <input
                          :value="personEthnicity"
                          class="field-input"
                          type="text"
                          @input="setRecordValue(party.主要人物, personName, $event)"
                        />
                        <button type="button" @click="removeRecordItem(party.主要人物, personName)">
                          删除
                        </button>
                      </div>
                    </div>
                  </article>
                </div>
              </article>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>政治状况</h4>
                <button
                  type="button"
                  @click="addRecordItem(currentCountry.政治.政治状况, '新状态')"
                >
                  添加项
                </button>
              </div>
              <div
                v-if="!Object.keys(currentCountry.政治.政治状况).length"
                class="empty-hint indent-2"
              >
                暂无政治状况
              </div>
              <div
                v-for="(statusValue, statusKey) in currentCountry.政治.政治状况"
                :key="statusKey"
                class="json-record-row indent-2"
              >
                <input
                  :value="statusKey"
                  class="field-input json-key-input"
                  type="text"
                  @change="renameRecordKey(currentCountry.政治.政治状况, statusKey, $event)"
                />
                <input
                  :value="statusValue"
                  class="field-input"
                  type="text"
                  @input="setRecordValue(currentCountry.政治.政治状况, statusKey, $event)"
                />
                <button
                  type="button"
                  @click="removeRecordItem(currentCountry.政治.政治状况, statusKey)"
                >
                  删除
                </button>
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <h3>科技</h3>
            <div class="field-grid">
              <div class="field-block">
                <label class="field-label">重工业</label>
                <textarea
                  v-model="currentCountry.科技.重工业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">轻工业</label>
                <textarea
                  v-model="currentCountry.科技.轻工业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">第三产业</label>
                <textarea
                  v-model="currentCountry.科技.第三产业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">航天工业</label>
                <textarea
                  v-model="currentCountry.科技.航天工业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">信息产业</label>
                <textarea
                  v-model="currentCountry.科技.信息产业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">农业</label>
                <textarea
                  v-model="currentCountry.科技.农业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>种族</h3>
              <button type="button" @click="addEthnicGroup(currentCountry)">添加种族</button>
            </div>
            <div v-if="!currentCountry.种族.length" class="empty-hint indent-1">暂无种族</div>
            <article
              v-for="(ethnicGroup, ethnicIndex) in currentCountry.种族"
              :key="ethnicIndex"
              class="json-object-card indent-1"
            >
              <div class="json-object-card-header">
                <strong>种族 {{ ethnicIndex + 1 }}</strong>
                <button type="button" @click="removeEthnicGroup(currentCountry, ethnicIndex)">
                  删除
                </button>
              </div>
              <div class="field-grid indent-1">
                <div class="field-block">
                  <label class="field-label">名称</label>
                  <input v-model="ethnicGroup.名称" class="field-input" type="text" />
                </div>
                <div class="field-block">
                  <label class="field-label">简介</label>
                  <textarea
                    v-model="ethnicGroup.简介"
                    class="field-input field-textarea"
                    rows="3"
                  />
                </div>
                <div class="field-block">
                  <label class="field-label">文化</label>
                  <textarea
                    v-model="ethnicGroup.文化"
                    class="field-input field-textarea"
                    rows="3"
                  />
                </div>
                <div class="field-block">
                  <label class="field-label">宗教</label>
                  <textarea
                    v-model="ethnicGroup.宗教"
                    class="field-input field-textarea"
                    rows="3"
                  />
                </div>
              </div>
            </article>
          </section>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  padding: 24px;
}

.page-title-row,
.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.title-actions,
.country-actions,
.country-export-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.panel {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.country-list {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.country-card {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.country-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.country-title-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.country-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.json-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}

.json-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.field-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.field-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 14px;
  color: var(--color-text);
}

.field-input {
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
}

.field-textarea {
  min-height: 96px;
  resize: vertical;
}

.json-object-card {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
}

.json-object-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.json-array-row,
.json-record-row {
  display: grid;
  gap: 8px;
  align-items: center;
  grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) auto;
  margin-top: 8px;
}

.json-key-input {
  font-weight: 600;
}

.empty-hint {
  margin-top: 8px;
  font-size: 14px;
  color: var(--color-text);
  opacity: 0.65;
}

.map-preview {
  margin-top: 8px;
}

.globe-canvas {
  max-width: 100%;
  display: block;
  width: 100%;
  max-width: 720px;
  height: auto;
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle at 30% 30%, rgba(118, 160, 230, 0.22), transparent 32%),
    radial-gradient(circle at center, rgba(8, 15, 30, 0.98), rgba(3, 8, 18, 1));
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.24),
    inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.globe-empty-hint {
  margin-top: 8px;
}

.indent-1 {
  padding-left: 16px;
}

.indent-2 {
  padding-left: 32px;
}

.indent-3 {
  padding-left: 48px;
}
</style>
