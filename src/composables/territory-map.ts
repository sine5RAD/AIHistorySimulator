import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

import { Admin2Store, type Admin2Index } from '@/lib/map/admin2-store'
import { boundsIntersect, expandBounds, pointInFeature } from '@/lib/map/geometry'
import { FeaturePathCache } from '@/lib/map/paths'
import {
  deviceTransform,
  fitScale,
  lineWidthFor,
  screenToWorld,
  viewBounds,
  type Camera,
} from '@/lib/map/projection'
import {
  getFeatureTerritoryCode,
  getFeatureTerritoryKey,
  normalizeTerritoryCode,
} from '@/lib/map/territory-code'
import {
  isRawFeatureCollection,
  normalizeWorldFeatures,
  type GeoFeatureBounds,
  type WorldMapFeature,
} from '@/types/geo'
import type { Area } from '@/types/land'
import { toColorInputValue } from '@/utils/scenario-data'

/** 与「世界地图」页面共用同一份本地数据；缺失时退回 Natural Earth 50m。 */
const LOCAL_GEOJSON_URL = `${import.meta.env.BASE_URL}geo/world.geojson`
const REMOTE_GEOJSON_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson'
/** 下级行政区目录，与世界地图页共用。 */
const ADMIN2_INDEX_URL = `${import.meta.env.BASE_URL}geo/admin2/index.json`

/** 经度方向画三份副本，横向拖动时不会露出空白。 */
const LONGITUDE_SHIFTS = [-360, 0, 360] as const

const MIN_ZOOM = 1
/** 小块地区（摩纳哥、港澳、小岛等）需要很高的倍率才能点中 */
const MAX_ZOOM = 200
const ZOOM_STEP = 1.15
const ZOOM_BUTTON_STEP = 1.5
const CLICK_TOLERANCE_PX = 5
/** 放大到该倍数后进入地区模式，与世界地图页加载下级行政区的阈值一致 */
const REGION_ZOOM = 2.4
const MAX_LOADED_ADM2 = 96

const COLOR_BACKGROUND = '#070b12'
const COLOR_GRID = 'rgba(59, 130, 246, 0.12)'
const COLOR_GRID_MAJOR = 'rgba(59, 130, 246, 0.22)'
const COLOR_GRID_LABEL = 'rgba(148, 163, 184, 0.5)'
const COLOR_LAND_FILL = 'rgba(30, 41, 59, 0.55)'
const COLOR_LAND_STROKE = 'rgba(148, 163, 184, 0.28)'
const COLOR_ADM2_STROKE = 'rgba(96, 165, 250, 0.38)'
const COLOR_HOVER_FILL = 'rgba(255, 255, 255, 0.08)'
const COLOR_HOVER_STROKE = '#f8fafc'

export type TerritoryMapLoadState = 'loading' | 'ready' | 'error'

export interface TerritoryAssignment {
  key?: string
  code: string
  name: string
  color: string
  level?: string
  countryCode?: string
}

export interface TerritoryAreaGroup {
  color: string
  areas: Area[]
}

export interface TerritoryMapOptions {
  /** 地区/国家编号 -> 政权颜色，用于给已分配的领土上色 */
  assignments: Ref<Record<string, TerritoryAssignment>>
  /** 自定义多边形领土（经纬度），来自世界生成的手绘国土 */
  areaGroups: Ref<TerritoryAreaGroup[]>
  /** 当前政权拥有的领土唯一键（代码 + 国家），用白色描边突出显示 */
  selectedKeys: Ref<string[]>
  /** 当前政权的代表色，供页面展示与未来扩展 */
  currentColor: Ref<string>
  /**
   * 点击某个地区时触发；由页面决定加入、移出或转交。
   * 只有当下级行政区没有数据时，才会把国家要素传出来，供页面提示。
   */
  onToggle: (feature: WorldMapFeature) => void
}

/**
 * 剧本编辑里的领土选择地图。
 *
 * 低倍率只显示国界；放大到 `REGION_ZOOM` 后加载并显示下级行政区，
 * 只有地区可以被选中，命中优先级与「世界地图」页面一致：先地区、后国家。
 */
export function useTerritoryMap(options: TerritoryMapOptions) {
  const containerRef = ref<HTMLDivElement | null>(null)
  const canvasRef = ref<HTMLCanvasElement | null>(null)

  const loadState = ref<TerritoryMapLoadState>('loading')
  const loadError = ref('')
  const hoverName = ref('')
  const featureCount = ref(0)
  const adminFeatureCount = ref(0)
  const regionMode = ref(false)
  const regionLoading = ref(false)
  const zoomLevel = ref(1)

  let features: WorldMapFeature[] = []
  const featureByCode = new Map<string, WorldMapFeature>()
  const pathCache = new FeaturePathCache()
  let hovered: WorldMapFeature | null = null
  let adm2Store: Admin2Store | null = null

  let width = 1
  let height = 1
  let dpr = 1
  let scaleX = 1 / 360
  let scaleY = 1 / 360
  let cx = 0.5
  let cy = 0.5
  let zoom = 1
  let offsetX = 0
  let offsetY = 0

  let isDragging = false
  let activePointerId: number | null = null
  let pointerDownX = 0
  let pointerDownY = 0
  let dragStartOffsetX = 0
  let dragStartOffsetY = 0
  let lastPointer: { clientX: number; clientY: number } | null = null

  let rafId: number | null = null
  let adminEnsureTimer: number | null = null
  let lastEnsureKey = ''
  let attachedCanvas: HTMLCanvasElement | null = null
  let resizeObserver: ResizeObserver | null = null

  function camera(): Camera {
    return {
      width,
      height,
      cx,
      cy,
      scaleX,
      scaleY,
      zoom,
      offsetX,
      offsetY,
    }
  }

  function measure(): boolean {
    const canvas = canvasRef.value
    if (!canvas) {
      return false
    }

    const rect = canvas.getBoundingClientRect()
    const nextWidth = Math.max(1, Math.round(rect.width))
    const nextHeight = Math.max(1, Math.round(rect.height))
    const nextDpr = window.devicePixelRatio || 1
    const changed = nextWidth !== width || nextHeight !== height || nextDpr !== dpr

    width = nextWidth
    height = nextHeight
    dpr = nextDpr

    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }

    const fitted = fitScale(width, height)
    scaleX = fitted.scaleX
    scaleY = fitted.scaleY
    cx = width / 2
    cy = height / 2
    clampOffsetY()
    regionMode.value = zoom >= REGION_ZOOM

    return changed
  }

  function clampOffsetY(): void {
    if (scaleY <= 0) {
      offsetY = 0
      return
    }

    const halfRange = height / 2 / (scaleY * zoom)
    const minOffset = halfRange - 90
    const maxOffset = 90 - halfRange

    if (minOffset > maxOffset) {
      offsetY = 0
      return
    }

    offsetY = Math.min(Math.max(offsetY, minOffset), maxOffset)
  }

  function setZoomAround(nextZoom: number, px: number, py: number): void {
    const before = screenToWorld(camera(), px, py)
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
    const after = screenToWorld(camera(), px, py)
    offsetX += after.lng - before.lng
    offsetY += after.lat - before.lat
    clampOffsetY()
    regionMode.value = zoom >= REGION_ZOOM
    zoomLevel.value = zoom
  }

  function zoomBy(factor: number): void {
    setZoomAround(zoom * factor, width / 2, height / 2)
    scheduleRender()
    scheduleAdmin2(120)
  }

  function zoomIn(): void {
    zoomBy(ZOOM_BUTTON_STEP)
  }

  function zoomOut(): void {
    zoomBy(1 / ZOOM_BUTTON_STEP)
  }

  function resetView(): void {
    zoom = 1
    offsetX = 0
    offsetY = 0
    regionMode.value = false
    zoomLevel.value = 1
    clampOffsetY()
    updateHover(null)
    scheduleRender()
    scheduleAdmin2(0)
  }

  function applyCameraTransform(context: CanvasRenderingContext2D, shift: number): void {
    const transform = deviceTransform(camera(), dpr, shift)
    context.setTransform(transform.a, 0, 0, transform.d, transform.e, transform.f)
  }

  function scheduleRender(): void {
    if (rafId !== null) {
      return
    }

    rafId = window.requestAnimationFrame(() => {
      rafId = null
      render()
    })
  }

  function syncRegionLoading(): void {
    regionLoading.value = Boolean(adm2Store && adm2Store.pending > 0)
    adminFeatureCount.value =
      adm2Store?.list().reduce((total, chunk) => total + chunk.features.length, 0) ?? 0
  }

  function ensureRegionsForCountry(rawIso: string): void {
    if (!adm2Store) {
      return
    }

    const iso = rawIso.trim().toUpperCase()
    if (!iso) {
      return
    }

    if (adm2Store.state(iso) === 'idle') {
      adm2Store.ensure(iso)
      syncRegionLoading()
    }
  }

  function findAdminFeature(rawCode: string, rawIso = ''): WorldMapFeature | null {
    if (!adm2Store) {
      return null
    }

    const code = normalizeTerritoryCode(rawCode)
    const iso = rawIso.trim().toUpperCase()
    let fallback: WorldMapFeature | null = null

    for (const chunk of adm2Store.list()) {
      for (const feature of chunk.features) {
        if (getFeatureTerritoryCode(feature) !== code) {
          continue
        }
        if (iso && (feature.iso || '').trim().toUpperCase() === iso) {
          return feature
        }
        fallback ??= feature
      }
    }

    return fallback
  }

  function pointInBounds(lng: number, lat: number, bounds: GeoFeatureBounds): boolean {
    return (
      lng >= bounds.minLng && lng <= bounds.maxLng && lat >= bounds.minLat && lat <= bounds.maxLat
    )
  }

  async function fetchAdmin2Index(): Promise<Admin2Index | null> {
    try {
      const response = await fetch(ADMIN2_INDEX_URL)
      if (!response.ok) {
        return null
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('json')) {
        return null
      }

      const payload: unknown = await response.json()
      if (typeof payload === 'object' && payload !== null) {
        return payload as Admin2Index
      }

      return null
    } catch {
      return null
    }
  }

  function createAdmin2Store(index: Admin2Index | null): void {
    adm2Store?.dispose()
    adm2Store = new Admin2Store({
      baseUrl: import.meta.env.BASE_URL,
      index,
      enableRemote: true,
      maxCountries: MAX_LOADED_ADM2,
      onChange: () => {
        syncRegionLoading()
        scheduleRender()
        refreshHover()
      },
    })

    lastEnsureKey = ''
    syncRegionLoading()
  }

  function ensureAdmin2ForView(): void {
    if (!adm2Store) {
      return
    }

    syncRegionLoading()
    if (zoom < REGION_ZOOM) {
      return
    }

    const current = camera()
    const views = LONGITUDE_SHIFTS.map((shift) => expandBounds(viewBounds(current, shift), 4))
    const center = screenToWorld(current, width / 2, height / 2)
    const candidates: { iso: string; area: number; containsCenter: number }[] = []
    const visible = new Set<string>()

    for (const feature of features) {
      const iso = (feature.iso || feature.code || '').trim().toUpperCase()
      if (!iso) {
        continue
      }

      let area = 0
      for (const view of views) {
        if (!boundsIntersect(feature.bounds, view)) {
          continue
        }
        const overlapLng =
          Math.min(feature.bounds.maxLng, view.maxLng) -
          Math.max(feature.bounds.minLng, view.minLng)
        const overlapLat =
          Math.min(feature.bounds.maxLat, view.maxLat) -
          Math.max(feature.bounds.minLat, view.minLat)
        area = Math.max(area, Math.max(0, overlapLng) * Math.max(0, overlapLat))
      }

      if (area <= 0) {
        continue
      }

      visible.add(iso)
      // 本地没有分块的国家先不批量请求，悬停/点击时再按需在线加载。
      if (!adm2Store.hasLocal(iso)) {
        continue
      }

      candidates.push({
        iso,
        area,
        containsCenter: pointInFeature(center.lng, center.lat, feature) ? 1 : 0,
      })
    }

    const centerCandidate =
      candidates.find((candidate) => candidate.containsCenter === 1) ??
      [...candidates].sort((a, b) => b.area - a.area)[0]

    // 只自动加载视口中心的国家；邻国在悬停/点击时按需加载，避免一次拉几十个分块。
    const toEnsure = new Set<string>()
    if (centerCandidate) {
      toEnsure.add(centerCandidate.iso)
    }
    for (const assignment of Object.values(options.assignments.value)) {
      if (assignment.level === 'country') {
        continue
      }
      const iso = (assignment.countryCode || '').trim().toUpperCase()
      if (iso && visible.has(iso)) {
        toEnsure.add(iso)
      }
    }

    const key = [...toEnsure].sort().join(',')
    if (key !== lastEnsureKey) {
      lastEnsureKey = key
      for (const iso of toEnsure) {
        adm2Store.ensure(iso)
      }
    }

    adm2Store.retain(visible)
    syncRegionLoading()
  }

  function scheduleAdmin2(delay = 220): void {
    if (adminEnsureTimer !== null) {
      return
    }

    adminEnsureTimer = window.setTimeout(() => {
      adminEnsureTimer = null
      ensureAdmin2ForView()
    }, delay)
  }

  function refreshHover(): void {
    if (!lastPointer || isDragging) {
      return
    }

    updateHover(hitTest(lastPointer.clientX, lastPointer.clientY))
  }

  function focusFeature(feature: WorldMapFeature, ensureRegion = false): void {
    const spanLng = Math.max(0.02, feature.bounds.maxLng - feature.bounds.minLng)
    const spanLat = Math.max(0.02, feature.bounds.maxLat - feature.bounds.minLat)
    const fitZoom = Math.min(160 / spanLng, 80 / spanLat)
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom))

    let centerLng = (feature.bounds.minLng + feature.bounds.maxLng) / 2
    centerLng = ((((centerLng + 180) % 360) + 360) % 360) - 180
    const centerLat = Math.max(
      -80,
      Math.min(80, (feature.bounds.minLat + feature.bounds.maxLat) / 2),
    )

    if (feature.level !== 'country' || ensureRegion) {
      zoom = Math.max(zoom, REGION_ZOOM)
    }

    const iso = (feature.iso || (feature.level === 'country' ? feature.code : ''))
      .trim()
      .toUpperCase()
    if (iso) {
      ensureRegionsForCountry(iso)
    }

    offsetX = -centerLng
    offsetY = -centerLat
    clampOffsetY()
    regionMode.value = zoom >= REGION_ZOOM
    zoomLevel.value = zoom
    updateHover(null)
    scheduleRender()
    scheduleAdmin2(0)
  }

  function drawGrid(context: CanvasRenderingContext2D): void {
    const unitX = scaleX * zoom
    const unitY = scaleY * zoom
    const step =
      zoom < 2 ? 30 : zoom < 5 ? 15 : zoom < 10 ? 5 : zoom < 30 ? 1 : zoom < 100 ? 0.5 : 0.2

    context.save()
    context.setLineDash([3, 5])
    context.lineWidth = 1
    context.strokeStyle = COLOR_GRID

    for (let longitude = -180; longitude <= 180; longitude += step) {
      const x = cx + (longitude + offsetX) * unitX
      if (x < 0 || x > width) continue
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, height)
      context.stroke()
    }

    for (let latitude = -90; latitude <= 90; latitude += step) {
      const y = cy - (latitude + offsetY) * unitY
      if (y < 0 || y > height) continue
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
    }

    context.setLineDash([])
    context.strokeStyle = COLOR_GRID_MAJOR
    context.beginPath()
    const equatorY = cy - (0 + offsetY) * unitY
    if (equatorY >= 0 && equatorY <= height) {
      context.moveTo(0, equatorY)
      context.lineTo(width, equatorY)
    }
    const primeX = cx + (0 + offsetX) * unitX
    if (primeX >= 0 && primeX <= width) {
      context.moveTo(primeX, 0)
      context.lineTo(primeX, height)
    }
    context.stroke()

    context.fillStyle = COLOR_GRID_LABEL
    context.font = '10px sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'top'
    for (let longitude = -180; longitude <= 180; longitude += 60) {
      const x = cx + (longitude + offsetX) * unitX
      if (x < 18 || x > width - 18) continue
      const label = longitude === 0 ? '0°' : longitude > 0 ? `${longitude}°E` : `${-longitude}°W`
      context.fillText(label, x, 5)
    }

    context.textAlign = 'left'
    context.textBaseline = 'middle'
    for (let latitude = -60; latitude <= 60; latitude += 30) {
      const y = cy - (latitude + offsetY) * unitY
      if (y < 14 || y > height - 14) continue
      const label = latitude === 0 ? '0°' : latitude > 0 ? `${latitude}°N` : `${-latitude}°S`
      context.fillText(label, 6, y)
    }

    context.restore()
  }

  function drawBaseFeatures(context: CanvasRenderingContext2D): void {
    const current = camera()
    context.lineJoin = 'round'
    context.lineCap = 'round'

    for (const shift of LONGITUDE_SHIFTS) {
      const view = expandBounds(viewBounds(current, shift), 1)
      applyCameraTransform(context, shift)
      context.fillStyle = COLOR_LAND_FILL
      context.strokeStyle = COLOR_LAND_STROKE
      context.lineWidth = lineWidthFor(current, 0.6)

      for (const feature of features) {
        if (!boundsIntersect(feature.bounds, view)) {
          continue
        }
        const path = pathCache.get(feature)
        if (!path) {
          continue
        }
        context.fill(path, 'evenodd')
        context.stroke(path)
      }
    }
  }

  function drawAreaGroups(context: CanvasRenderingContext2D): void {
    const current = camera()
    const groups = options.areaGroups.value

    if (!groups.length) {
      return
    }

    for (const shift of LONGITUDE_SHIFTS) {
      applyCameraTransform(context, shift)
      context.lineJoin = 'round'
      context.lineWidth = lineWidthFor(current, 1)

      for (const group of groups) {
        const color = toColorInputValue(group.color)
        context.fillStyle = color
        context.strokeStyle = color
        context.globalAlpha = 0.42

        for (const area of group.areas) {
          const first = area.vertices[0]
          if (!first) {
            continue
          }

          context.beginPath()
          context.moveTo(first[0], -first[1])
          for (let index = 1; index < area.vertices.length; index += 1) {
            const point = area.vertices[index]
            if (!point) {
              continue
            }
            context.lineTo(point[0], -point[1])
          }
          context.closePath()
          context.fill()
          context.globalAlpha = 0.85
          context.stroke()
          context.globalAlpha = 0.42
        }
      }
    }

    context.globalAlpha = 1
  }

  type AssignmentEntry = { key: string; assignment: TerritoryAssignment }

  interface AssignmentLookup {
    byKey: Map<string, AssignmentEntry>
    byCode: Map<string, AssignmentEntry[]>
  }

  function buildAssignmentLookup(): AssignmentLookup {
    const byKey = new Map<string, AssignmentEntry>()
    const byCode = new Map<string, AssignmentEntry[]>()

    for (const [key, assignment] of Object.entries(options.assignments.value)) {
      const entry = { key, assignment }
      byKey.set(key, entry)

      const code = normalizeTerritoryCode(assignment.code)
      const entries = byCode.get(code) ?? []
      entries.push(entry)
      byCode.set(code, entries)
    }

    return { byKey, byCode }
  }

  /**
   * 优先按「代码 + 国家」唯一键匹配；
   * 旧数据没有国家代码时，如果该代码只有一个候选，退回按代码匹配。
   */
  function resolveAssignment(
    feature: WorldMapFeature,
    lookup: AssignmentLookup,
  ): AssignmentEntry | null {
    const key = getFeatureTerritoryKey(feature)
    const exact = lookup.byKey.get(key)
    if (exact) {
      return exact
    }

    const code = normalizeTerritoryCode(getFeatureTerritoryCode(feature))
    const candidates = lookup.byCode.get(code) ?? []
    return candidates.length === 1 ? (candidates[0] ?? null) : null
  }

  function drawAssignments(context: CanvasRenderingContext2D, lookup: AssignmentLookup): void {
    if (!lookup.byKey.size) {
      return
    }

    const selected = new Set(options.selectedKeys.value)
    const current = camera()

    for (const shift of LONGITUDE_SHIFTS) {
      const view = expandBounds(viewBounds(current, shift), 1)
      applyCameraTransform(context, shift)

      for (const feature of features) {
        if (!boundsIntersect(feature.bounds, view)) {
          continue
        }

        const resolved = resolveAssignment(feature, lookup)
        if (!resolved) {
          continue
        }

        const assignment = resolved.assignment
        if (assignment.level && assignment.level !== 'country') {
          continue
        }

        const path = pathCache.get(feature)
        if (!path) {
          continue
        }

        const isCurrent = selected.has(resolved.key)
        context.fillStyle = toColorInputValue(assignment.color)
        context.globalAlpha = isCurrent ? 0.72 : 0.46
        context.fill(path, 'evenodd')

        context.strokeStyle = isCurrent ? '#f8fafc' : toColorInputValue(assignment.color)
        context.globalAlpha = isCurrent ? 1 : 0.78
        context.lineWidth = lineWidthFor(current, isCurrent ? 1.8 : 1)
        context.stroke(path)
      }
    }

    context.globalAlpha = 1
  }

  /** 地区模式下的下级行政区底图：只描边，叠在国界与整国填色之上。 */
  function drawAdmin2Base(context: CanvasRenderingContext2D): void {
    if (!regionMode.value || !adm2Store) {
      return
    }

    const chunks = adm2Store.list()
    if (!chunks.length) {
      return
    }

    const current = camera()
    context.lineJoin = 'round'
    for (const shift of LONGITUDE_SHIFTS) {
      const view = expandBounds(viewBounds(current, shift), 1)
      applyCameraTransform(context, shift)
      context.strokeStyle = COLOR_ADM2_STROKE
      context.lineWidth = lineWidthFor(current, 0.55)

      for (const chunk of chunks) {
        if (!boundsIntersect(chunk.bounds, view)) {
          continue
        }
        for (const feature of chunk.features) {
          if (!boundsIntersect(feature.bounds, view)) {
            continue
          }
          const path = pathCache.get(feature)
          if (path) {
            context.stroke(path)
          }
        }
      }
    }
  }

  /** 已分配的行政区：按政权颜色填充。 */
  function drawRegionAssignments(
    context: CanvasRenderingContext2D,
    lookup: AssignmentLookup,
  ): void {
    if (!regionMode.value || !adm2Store || !lookup.byKey.size) {
      return
    }

    const selected = new Set(options.selectedKeys.value)
    const current = camera()

    for (const shift of LONGITUDE_SHIFTS) {
      const view = expandBounds(viewBounds(current, shift), 1)
      applyCameraTransform(context, shift)

      for (const chunk of adm2Store.list()) {
        if (!boundsIntersect(chunk.bounds, view)) {
          continue
        }

        for (const feature of chunk.features) {
          if (!boundsIntersect(feature.bounds, view)) {
            continue
          }

          const resolved = resolveAssignment(feature, lookup)
          if (!resolved) {
            continue
          }

          const assignment = resolved.assignment
          if (assignment.level === 'country') {
            continue
          }

          const path = pathCache.get(feature)
          if (!path) {
            continue
          }

          const isCurrent = selected.has(resolved.key)
          context.fillStyle = toColorInputValue(assignment.color)
          context.globalAlpha = isCurrent ? 0.72 : 0.46
          context.fill(path, 'evenodd')

          context.strokeStyle = isCurrent ? '#f8fafc' : toColorInputValue(assignment.color)
          context.globalAlpha = isCurrent ? 1 : 0.82
          context.lineWidth = lineWidthFor(current, isCurrent ? 1.7 : 0.9)
          context.stroke(path)
        }
      }
    }

    context.globalAlpha = 1
  }

  function drawHover(context: CanvasRenderingContext2D): void {
    if (!hovered) {
      return
    }

    const path = pathCache.get(hovered)
    if (!path) {
      return
    }

    const current = camera()
    for (const shift of LONGITUDE_SHIFTS) {
      applyCameraTransform(context, shift)
      context.globalAlpha = 0.9
      context.fillStyle = COLOR_HOVER_FILL
      context.fill(path, 'evenodd')
      context.strokeStyle = COLOR_HOVER_STROKE
      context.lineWidth = lineWidthFor(current, 2)
      context.stroke(path)
    }

    context.globalAlpha = 1
  }

  function render(): void {
    const canvas = canvasRef.value
    if (!canvas) {
      return
    }

    measure()
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = COLOR_BACKGROUND
    context.fillRect(0, 0, canvas.width, canvas.height)

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawGrid(context)

    if (!features.length) {
      return
    }

    const assignmentLookup = buildAssignmentLookup()
    drawBaseFeatures(context)
    drawAssignments(context, assignmentLookup)
    drawAdmin2Base(context)
    drawRegionAssignments(context, assignmentLookup)
    drawAreaGroups(context)
    drawHover(context)

    if (regionMode.value) {
      scheduleAdmin2()
    }
  }

  function pointInCanvas(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = canvasRef.value
    if (!canvas) {
      return null
    }
    const rect = canvas.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  function hitTest(clientX: number, clientY: number): WorldMapFeature | null {
    const point = pointInCanvas(clientX, clientY)
    if (!point || !features.length) {
      return null
    }

    const current = camera()

    // 先命中下级行政区；跨 180° 的国家在三份经度副本里都要尝试。
    if (regionMode.value && adm2Store) {
      const chunks = adm2Store.list()
      for (const shift of LONGITUDE_SHIFTS) {
        const { lng, lat } = screenToWorld(current, point.x, point.y, shift)
        for (const chunk of chunks) {
          if (!pointInBounds(lng, lat, chunk.bounds)) {
            continue
          }
          for (const feature of chunk.features) {
            if (pointInFeature(lng, lat, feature)) {
              return feature
            }
          }
        }
      }
    }

    for (const shift of LONGITUDE_SHIFTS) {
      const { lng, lat } = screenToWorld(current, point.x, point.y, shift)
      for (const feature of features) {
        if (!pointInFeature(lng, lat, feature)) {
          continue
        }

        if (!regionMode.value || !adm2Store) {
          return feature
        }

        const iso = (feature.iso || feature.code || '').trim().toUpperCase()
        if (!iso) {
          return feature
        }

        const state = adm2Store.state(iso)
        if (state === 'ready') {
          // 地区已加载但点击位置不在任何地区内（湖面/边界），不做选择
          return null
        }
        if (state === 'missing') {
          return feature
        }

        ensureRegionsForCountry(iso)
        return null
      }
    }

    return null
  }

  function updateHover(feature: WorldMapFeature | null): void {
    if (feature && regionMode.value && feature.level === 'country' && feature.iso) {
      // 悬停到还没有地区数据的国家时，提前把该国的行政区拉下来
      ensureRegionsForCountry(feature.iso)
    }

    if (feature === hovered) {
      return
    }
    hovered = feature
    hoverName.value = feature?.name ?? ''
    const canvas = canvasRef.value
    if (canvas) {
      canvas.style.cursor = feature ? 'pointer' : 'grab'
    }
    scheduleRender()
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return
    }

    const canvas = canvasRef.value
    if (!canvas) {
      return
    }

    lastPointer = { clientX: event.clientX, clientY: event.clientY }
    isDragging = true
    activePointerId = event.pointerId
    pointerDownX = event.clientX
    pointerDownY = event.clientY
    dragStartOffsetX = offsetX
    dragStartOffsetY = offsetY
    canvas.style.cursor = 'grabbing'

    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // 某些浏览器在指针已释放时会抛错，忽略即可
    }
  }

  function onPointerMove(event: PointerEvent): void {
    lastPointer = { clientX: event.clientX, clientY: event.clientY }

    if (isDragging && event.pointerId === activePointerId) {
      const unitX = scaleX * zoom
      const unitY = scaleY * zoom

      if (unitX > 0 && unitY > 0) {
        offsetX = dragStartOffsetX + (event.clientX - pointerDownX) / unitX
        offsetY = dragStartOffsetY - (event.clientY - pointerDownY) / unitY
        clampOffsetY()
      }

      scheduleRender()
      return
    }

    updateHover(hitTest(event.clientX, event.clientY))
  }

  function onPointerUp(event: PointerEvent): void {
    const canvas = canvasRef.value
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }

    if (!isDragging) {
      return
    }

    isDragging = false
    activePointerId = null
    lastPointer = { clientX: event.clientX, clientY: event.clientY }
    if (canvas) {
      canvas.style.cursor = hovered ? 'pointer' : 'grab'
    }

    // 把经度偏移规整回 [-180, 180)，避免数值无限增长；三份经度副本保证画面不跳。
    offsetX = ((((offsetX + 180) % 360) + 360) % 360) - 180
    scheduleRender()
    scheduleAdmin2(80)

    const dx = event.clientX - pointerDownX
    const dy = event.clientY - pointerDownY
    if (Math.hypot(dx, dy) >= CLICK_TOLERANCE_PX) {
      return
    }

    const hit = hitTest(event.clientX, event.clientY)
    if (hit) {
      options.onToggle(hit)
    }
  }

  function onPointerCancel(): void {
    isDragging = false
    activePointerId = null
  }

  function onPointerLeave(): void {
    lastPointer = null
    if (!isDragging) {
      updateHover(null)
    }
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault()

    const point = pointInCanvas(event.clientX, event.clientY)
    if (!point || !features.length) {
      return
    }

    lastPointer = { clientX: event.clientX, clientY: event.clientY }
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    setZoomAround(zoom * factor, point.x, point.y)
    updateHover(hitTest(event.clientX, event.clientY))
    scheduleRender()
    scheduleAdmin2(120)
  }

  function onWindowResize(): void {
    scheduleRender()
  }

  async function fetchFeatures(): Promise<WorldMapFeature[]> {
    const failures: string[] = []

    for (const url of [LOCAL_GEOJSON_URL, REMOTE_GEOJSON_URL]) {
      try {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('json')) {
          throw new Error(`内容类型不是 JSON（${contentType || '未知'}）`)
        }

        const payload: unknown = await response.json()
        if (!isRawFeatureCollection(payload)) {
          throw new Error('不是有效的 GeoJSON FeatureCollection')
        }

        const next = normalizeWorldFeatures(payload)
        if (!next.length) {
          throw new Error('数据里没有可绘制的多边形')
        }

        return next
      } catch (error) {
        failures.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    throw new Error(failures.join('；'))
  }

  async function load(): Promise<void> {
    loadState.value = 'loading'
    loadError.value = ''

    try {
      const [nextFeatures, index] = await Promise.all([fetchFeatures(), fetchAdmin2Index()])
      features = nextFeatures
      featureByCode.clear()

      for (const feature of features) {
        const code = normalizeTerritoryCode(getFeatureTerritoryCode(feature))
        if (code) {
          featureByCode.set(code, feature)
        }
      }

      createAdmin2Store(index)
      featureCount.value = features.length
      pathCache.clear()
      hovered = null
      hoverName.value = ''
      regionMode.value = zoom >= REGION_ZOOM
      loadState.value = 'ready'
      scheduleRender()
      scheduleAdmin2(60)
    } catch (error) {
      features = []
      featureByCode.clear()
      featureCount.value = 0
      adm2Store?.dispose()
      adm2Store = null
      regionLoading.value = false
      loadState.value = 'error'
      loadError.value = error instanceof Error ? error.message : String(error)
      scheduleRender()
    }
  }

  /** 按国家 ISO3 定位；保留旧接口，供只存国家代码的领土使用。 */
  function focusOnCode(rawCode: string, ensureRegion = false): boolean {
    const feature = featureByCode.get(normalizeTerritoryCode(rawCode))
    if (!feature) {
      return false
    }

    focusFeature(feature, ensureRegion)
    return true
  }

  /**
   * 按国家 / 地区编号定位。
   * 地区尚未加载时，会先触发对应国家的行政区加载，并返回 false。
   */
  function focusOnTerritory(rawCode: string, rawCountryCode = ''): boolean {
    if (focusOnCode(rawCode)) {
      return true
    }

    const adminFeature = findAdminFeature(rawCode, rawCountryCode)
    if (adminFeature) {
      focusFeature(adminFeature)
      return true
    }

    const iso = rawCountryCode.trim().toUpperCase()
    if (iso) {
      ensureRegionsForCountry(iso)
    }

    return false
  }

  function attachCanvas(canvas: HTMLCanvasElement | null): void {
    detachCanvas()
    if (!canvas) {
      return
    }

    attachedCanvas = canvas
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
  }

  function detachCanvas(): void {
    if (!attachedCanvas) {
      return
    }

    attachedCanvas.removeEventListener('pointerdown', onPointerDown)
    attachedCanvas.removeEventListener('pointermove', onPointerMove)
    attachedCanvas.removeEventListener('pointerup', onPointerUp)
    attachedCanvas.removeEventListener('pointercancel', onPointerCancel)
    attachedCanvas.removeEventListener('pointerleave', onPointerLeave)
    attachedCanvas.removeEventListener('wheel', onWheel)
    attachedCanvas = null
  }

  watch(
    canvasRef,
    (canvas) => {
      attachCanvas(canvas)
      scheduleRender()
    },
    { immediate: true },
  )

  watch(
    containerRef,
    (container) => {
      resizeObserver?.disconnect()
      resizeObserver = null

      if (container && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => scheduleRender())
        resizeObserver.observe(container)
      }

      scheduleRender()
    },
    { immediate: true },
  )

  watch(
    [options.assignments, options.areaGroups, options.selectedKeys, options.currentColor],
    () => scheduleRender(),
    { deep: true },
  )

  onMounted(() => {
    window.addEventListener('resize', onWindowResize)
    void load()

    // 开发环境下暴露少量接口，便于 Playwright 验证「地区选择」；生产构建不会包含。
    if (import.meta.env.DEV) {
      const debugWindow = window as unknown as {
        __territoryMapDebug?: {
          state: () => unknown
          setZoom: (value: number) => void
          focusOnCode: (code: string) => boolean
          focusOnTerritory: (code: string, countryCode?: string) => boolean
          listAdminFeatures: () => Array<{
            name: string
            code: string
            iso: string
            level: string
          }>
          selectFeature: (code: string) => boolean
        }
      }

      debugWindow.__territoryMapDebug = {
        state: () => ({
          zoom,
          regionMode: regionMode.value,
          regionLoading: regionLoading.value,
          featureCount: features.length,
          adminChunks: adm2Store?.loadedCountries ?? 0,
          adminPending: adm2Store?.pending ?? 0,
        }),
        setZoom: (value: number) => {
          zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))
          regionMode.value = zoom >= REGION_ZOOM
          zoomLevel.value = zoom
          clampOffsetY()
          updateHover(null)
          scheduleRender()
          scheduleAdmin2(0)
        },
        focusOnCode,
        focusOnTerritory,
        listAdminFeatures: () =>
          adm2Store?.list().flatMap((chunk) =>
            chunk.features.map((feature) => ({
              name: feature.name,
              code: getFeatureTerritoryCode(feature),
              iso: feature.iso,
              level: feature.level,
            })),
          ) ?? [],
        selectFeature: (rawCode: string) => {
          const code = normalizeTerritoryCode(rawCode)
          const feature = featureByCode.get(code) ?? findAdminFeature(code)
          if (!feature) {
            return false
          }
          options.onToggle(feature)
          return true
        },
      }
    }
  })

  onBeforeUnmount(() => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }

    if (adminEnsureTimer !== null) {
      window.clearTimeout(adminEnsureTimer)
      adminEnsureTimer = null
    }

    adm2Store?.dispose()
    adm2Store = null
    detachCanvas()
    resizeObserver?.disconnect()
    resizeObserver = null
    window.removeEventListener('resize', onWindowResize)
  })

  return {
    containerRef,
    canvasRef,
    loadState,
    loadError,
    hoverName,
    featureCount,
    adminFeatureCount,
    regionMode,
    regionLoading,
    zoomLevel,
    zoomIn,
    zoomOut,
    resetView,
    focusOnCode,
    focusOnTerritory,
    retry: load,
  }
}
