import { onBeforeUnmount, onMounted, ref } from 'vue'

import clickSoundUrl from '@/assets/sounds/click.mp3'
import scannerSoundUrl from '@/assets/sounds/scanner.m4a'
import { Admin2Store, type Admin2Index } from '@/lib/map/admin2-store'
import { boundsIntersect, expandBounds, pointInFeature } from '@/lib/map/geometry'
import { FeaturePathCache } from '@/lib/map/paths'
import {
  deviceTransform,
  lineWidthFor,
  screenToWorld,
  viewBounds,
  worldToScreen,
  type Camera,
} from '@/lib/map/projection'
import {
  isRawFeatureCollection,
  normalizeWorldFeatures,
  type GeoFeatureBounds,
  type WorldMapFeature,
} from '@/types/geo'

/**
 * 本地地图数据（推荐）：把 world.geojson 放到 public/geo/ 下即可离线运行。
 * 文件不存在时会自动退回到远端的公益数据源。
 */
const LOCAL_GEOJSON_URL = `${import.meta.env.BASE_URL}geo/world.geojson`
/** 远端兜底：Natural Earth 50m 国界，与本地脚本生成的数据同源 */
const REMOTE_GEOJSON_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson'
/** 次级行政区目录，由 scripts/build-map-data.mjs 生成 */
const ADMIN2_INDEX_URL = `${import.meta.env.BASE_URL}geo/admin2/index.json`

/** 经度方向画三份副本，地图左右滚动时不会出现空白 */
const LONGITUDE_SHIFTS = [-360, 0, 360] as const

const MIN_ZOOM = 1
const MAX_ZOOM = 20
const ZOOM_STEP = 1.12
/** 放大到该倍数才开始绘制市级行政区（1 = 全球刚好铺满宽度） */
const CITY_ZOOM = 2.4
/** 单个视口最多同时请求几个国家的下级行政区 */
const MAX_VISIBLE_ADM2 = 6
/** 内存里最多保留几个国家的下级行政区 */
const MAX_LOADED_ADM2 = 8

/** 按下与抬起的位移小于该值才算“点击”，否则算拖动 */
const CLICK_TOLERANCE_PX = 6
/** 信息面板相对点击位置的偏移 */
const PANEL_OFFSET_X = 60
const PANEL_OFFSET_Y = 40
const FALLBACK_PANEL_HEIGHT = 58
/** 扫描线每秒移动的屏幕高度比例 */
const SCAN_SPEED = 0.08
const FLASH_INTERVAL_MS = 150
/** 闪烁到这个相位后停在白色常亮状态 */
const FLASH_FINAL_PHASE = 7

const COLOR_BACKGROUND = '#0a0e14'
const COLOR_GRID_LATITUDE = 'rgba(148, 163, 184, 0.3)'
const COLOR_GRID_LONGITUDE = 'rgba(148, 163, 184, 0.2)'
const COLOR_GRID_LABEL = 'rgba(148, 163, 184, 0.7)'
const COLOR_HOVER_FILL = 'rgba(59, 130, 246, 0.18)'
const COLOR_HOVER_STROKE = '#93c5fd'
const COLOR_FLASH_BLUE_FILL = 'rgba(59, 130, 246, 0.3)'
const COLOR_FLASH_WHITE_FILL = 'rgba(255, 255, 255, 0.35)'
const COLOR_SELECTED_BLUE_STROKE = 'rgba(147, 197, 253, 0.8)'
const COLOR_SELECTED_WHITE_STROKE = 'rgba(255, 255, 255, 0.7)'
const COLOR_OUTLINE_GLOW = '#3b82f6'
const COLOR_OUTLINE_INNER = '#93c5fd'
/** 市级行政区：只描边，保持和国界一致的线框风格 */
const COLOR_ADM2_STROKE = 'rgba(96, 165, 250, 0.42)'

export type WorldMapLoadState = 'loading' | 'ready' | 'error'

export type MapFeatureKind = 'country' | 'adm2'

export interface WorldMapOptions {
  /** 信息面板的真实高度，用于摆放连接线终点；不传则按 58px 估算 */
  getPanelHeight?: () => number
}

interface ClickAnchor {
  lng: number
  lat: number
  /** 点击发生在哪一份经度副本上 */
  shift: number
}

interface FeatureHit {
  feature: WorldMapFeature
  kind: MapFeatureKind
  lng: number
  lat: number
  shift: number
}

interface Selection {
  feature: WorldMapFeature
  kind: MapFeatureKind
}

interface CameraSnapshot {
  width: number
  height: number
  dpr: number
  zoom: number
  offsetX: number
  offsetY: number
}

interface PathStyle {
  fill?: string
  stroke?: string
  /** 线宽，单位 CSS 像素 */
  width?: number
  shadowBlur?: number
  shadowColor?: string
  alpha?: number
}

/**
 * 世界地图主页的全部交互逻辑：等距圆柱投影绘制、拖拽平移、滚轮缩放、
 * 悬停高亮、点击闪烁、扫描线动画与音效；放大到市级时按国家懒加载次级行政区。
 *
 * 页面只需要绑定 `containerRef` / `canvasRef` 并把返回的状态交给模板。
 */
export function useWorldMap(options: WorldMapOptions = {}) {
  const containerRef = ref<HTMLDivElement | null>(null)
  const canvasRef = ref<HTMLCanvasElement | null>(null)

  const infoVisible = ref(false)
  const infoName = ref('')
  const infoCode = ref('')
  const infoDetail = ref('')
  /** 当前选中的是国家级还是市级，页面据此决定要不要播过场动画 */
  const selectionKind = ref<MapFeatureKind>('country')
  const infoX = ref(0)
  const infoY = ref(0)

  const loadState = ref<WorldMapLoadState>('loading')
  const loadError = ref('')
  /** 市级行政区是否正在加载，页面用它显示一行小提示 */
  const cityLoading = ref(false)
  /** 是否已经放大到市级层级，页面用它切换底部提示文案 */
  const cityMode = ref(false)

  let countryFeatures: WorldMapFeature[] = []
  let adm2Store: Admin2Store | null = null

  const pathCache = new FeaturePathCache()

  let hovered: Selection | null = null
  let selected: Selection | null = null
  let anchor: ClickAnchor | null = null
  let flashPhase = 0
  let flashTimer: number | null = null

  let offsetX = 0
  let offsetY = 0
  let zoom = 1

  let dragStartX = 0
  let dragStartY = 0
  let dragStartOffsetX = 0
  let dragStartOffsetY = 0
  let isDragging = false
  let pointerDownAt = { x: 0, y: 0 }
  /** 最近一次鼠标位置，数据加载完后用它重算悬停 */
  let lastPointer: { clientX: number; clientY: number } | null = null

  let dpr = 1
  let width = 0
  let height = 0
  let scale = 0
  let cx = 0
  let cy = 0

  let cacheCanvas: HTMLCanvasElement | null = null
  let cacheCamera: CameraSnapshot | null = null
  let cacheDirty = true
  let ensureTimer: number | null = null
  let lastEnsureKey = ''

  let scanLinePos = 0
  let rafId = 0
  let lastFrameTime = 0
  let resizeObserver: ResizeObserver | null = null

  let scannerAudio: HTMLAudioElement | null = null
  let audioStarted = false

  /* ---------- 尺寸与相机 ---------- */

  /** 读取容器尺寸；返回 true 表示尺寸有变化 */
  function measure(): boolean {
    const container = containerRef.value
    if (!container) {
      return false
    }
    const rect = container.getBoundingClientRect()
    const nextWidth = Math.max(1, Math.round(rect.width))
    const nextHeight = Math.max(1, Math.round(rect.height))
    const nextDpr = window.devicePixelRatio || 1

    const changed = nextWidth !== width || nextHeight !== height || nextDpr !== dpr
    width = nextWidth
    height = nextHeight
    dpr = nextDpr
    scale = width / 360
    cx = width / 2
    cy = height / 2
    return changed
  }

  function camera(): Camera {
    return { width, height, cx, cy, scale, zoom, offsetX, offsetY }
  }

  /** 限制南北方向，避免拖出地球 */
  function clampOffsetY(): void {
    if (scale <= 0) {
      return
    }
    const halfRange = height / 2 / (scale * zoom)
    const minOffset = halfRange - 90
    const maxOffset = 90 - halfRange
    if (minOffset > maxOffset) {
      // 视口比整张地图还高（极窄窗口），直接居中
      offsetY = 0
      return
    }
    offsetY = Math.min(Math.max(offsetY, minOffset), maxOffset)
  }

  function setZoomAround(nextZoom: number, px: number, py: number): void {
    const current = camera()
    const before = screenToWorld(current, px, py)
    zoom = nextZoom
    const next = camera()
    const moved = screenToWorld(next, px, py)
    offsetX += moved.lng - before.lng
    offsetY += moved.lat - before.lat
    clampOffsetY()
    cityMode.value = zoom >= CITY_ZOOM
  }

  /* ---------- 绘制工具 ---------- */

  function markDirty(): void {
    cacheDirty = true
  }

  function applyCameraTransform(ctx: CanvasRenderingContext2D, shift: number): void {
    const transform = deviceTransform(camera(), dpr, shift)
    ctx.setTransform(transform.a, 0, 0, transform.a, transform.e, transform.f)
  }

  /** 视口包围盒（含余量），用于剔除看不见的要素 */
  function cullBounds(shift: number): GeoFeatureBounds {
    return expandBounds(viewBounds(camera(), shift), 1)
  }

  function drawFeatures(
    ctx: CanvasRenderingContext2D,
    features: WorldMapFeature[],
    style: PathStyle,
  ): void {
    const current = camera()
    const lineWidth = lineWidthFor(current, style.width ?? 1)

    ctx.save()
    if (style.shadowBlur && style.shadowColor) {
      ctx.shadowBlur = style.shadowBlur
      ctx.shadowColor = style.shadowColor
    } else {
      ctx.shadowBlur = 0
    }
    if (typeof style.alpha === 'number') {
      ctx.globalAlpha = style.alpha
    }
    if (style.fill) {
      ctx.fillStyle = style.fill
    }
    if (style.stroke) {
      ctx.strokeStyle = style.stroke
      ctx.lineWidth = lineWidth
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const shift of LONGITUDE_SHIFTS) {
      const view = cullBounds(shift)
      applyCameraTransform(ctx, shift)
      for (const feature of features) {
        if (!boundsIntersect(feature.bounds, view)) {
          continue
        }
        const path = pathCache.get(feature)
        if (!path) {
          continue
        }
        if (style.fill) {
          ctx.fill(path, 'evenodd')
        }
        if (style.stroke) {
          ctx.stroke(path)
        }
      }
    }

    ctx.restore()
  }

  /** 经纬度网格：缩放越大，网格越密 */
  function drawGrid(ctx: CanvasRenderingContext2D): void {
    const step = zoom <= 1 ? 30 : zoom < 3 ? 15 : zoom < 6 ? 10 : 5

    ctx.save()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1
    ctx.textBaseline = 'top'

    // 纬线（水平）
    ctx.strokeStyle = COLOR_GRID_LATITUDE
    const firstLat = Math.ceil((-90 - offsetY) / step) * step
    const lastLat = Math.floor((90 - offsetY) / step) * step
    for (let lat = firstLat; lat <= lastLat; lat += step) {
      if (lat < -90 || lat > 90) {
        continue
      }
      const y = cy - (lat + offsetY) * scale * zoom
      if (y < 0 || y > height) {
        continue
      }
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()

      ctx.fillStyle = COLOR_GRID_LABEL
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'left'
      const label = lat === 0 ? '0°' : lat > 0 ? `${lat}°N` : `${-lat}°S`
      ctx.fillText(label, 6, y + 3)
    }

    // 经线（竖直）
    ctx.strokeStyle = COLOR_GRID_LONGITUDE
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    for (const shift of LONGITUDE_SHIFTS) {
      const view = viewBounds(camera(), shift)
      const startLng = Math.ceil(view.minLng / step) * step
      const endLng = Math.floor(view.maxLng / step) * step
      for (let lng = startLng; lng <= endLng; lng += step) {
        if (lng < -180 || lng > 180) {
          continue
        }
        const x = cx + (lng + offsetX + shift) * scale * zoom
        if (x < 0 || x > width) {
          continue
        }
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()

        ctx.fillStyle = COLOR_GRID_LABEL
        if (lng === 0) {
          ctx.fillText('0°', x, 3)
        } else if (lng === 180 || lng === -180) {
          ctx.fillText('180°', x, 3)
        } else if (lng > 0) {
          ctx.fillText(`${lng}°E`, x, 3)
        } else {
          ctx.fillText(`${-lng}°W`, x, 3)
        }
      }
    }

    ctx.restore()
  }

  /** 市级行政区：只在放大到 CITY_ZOOM 之后绘制已加载的国家 */
  function drawAdmin2(ctx: CanvasRenderingContext2D): void {
    if (zoom < CITY_ZOOM || !adm2Store) {
      return
    }
    const chunks = adm2Store.list()
    if (chunks.length === 0) {
      return
    }

    const current = camera()
    const view = expandBounds(viewBounds(current), 1)
    const features: WorldMapFeature[] = []
    for (const chunk of chunks) {
      if (!boundsIntersect(chunk.bounds, view)) {
        continue
      }
      for (const feature of chunk.features) {
        if (boundsIntersect(feature.bounds, view)) {
          features.push(feature)
        }
      }
    }
    if (features.length === 0) {
      return
    }

    drawFeatures(ctx, features, { stroke: COLOR_ADM2_STROKE, width: 1 })
  }

  /** 把静态内容画进离屏画布，扫描线动画每帧只做一次 drawImage */
  function rebuildCache(): void {
    const canvas = cacheCanvas ?? (cacheCanvas = document.createElement('canvas'))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    measure()
    clampOffsetY()

    const cacheWidth = Math.max(1, Math.round(width * dpr))
    const cacheHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== cacheWidth || canvas.height !== cacheHeight) {
      canvas.width = cacheWidth
      canvas.height = cacheHeight
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = COLOR_BACKGROUND
    ctx.fillRect(0, 0, width, height)

    drawGrid(ctx)

    if (countryFeatures.length > 0) {
      // 1. 市级行政区（先画，让国界压在它上面）
      drawAdmin2(ctx)

      // 2. 外层发光描边
      drawFeatures(ctx, countryFeatures, {
        stroke: COLOR_OUTLINE_GLOW,
        width: 2.5,
        shadowBlur: 6,
        shadowColor: COLOR_OUTLINE_GLOW,
        alpha: 0.9,
      })

      // 3. 内层亮线
      drawFeatures(ctx, countryFeatures, {
        stroke: COLOR_OUTLINE_INNER,
        width: 1,
        alpha: 0.6,
      })
    }

    cacheCamera = { width, height, dpr, zoom, offsetX, offsetY }
    cacheDirty = false
    // 视角变化后看看当前视口里有哪些国家需要市级数据
    scheduleAdmin2(180)
  }

  /** 悬停 / 选中高亮：画在动画层，不触发静态缓存重建 */
  function drawFeatureOverlay(
    ctx: CanvasRenderingContext2D,
    feature: WorldMapFeature,
    fill: string,
    stroke: string,
    lineWidth: number,
    alpha: number,
  ): void {
    const path = pathCache.get(feature)
    if (!path) {
      return
    }
    const current = camera()
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.lineWidth = lineWidthFor(current, lineWidth)
    ctx.lineJoin = 'round'
    ctx.shadowBlur = 0
    for (const shift of LONGITUDE_SHIFTS) {
      applyCameraTransform(ctx, shift)
      ctx.fill(path, 'evenodd')
      ctx.stroke(path)
    }
    ctx.restore()
  }

  function drawHighlights(ctx: CanvasRenderingContext2D): void {
    if (hovered) {
      drawFeatureOverlay(ctx, hovered.feature, COLOR_HOVER_FILL, COLOR_HOVER_STROKE, 3, 0.85)
    }
    if (selected && flashPhase > 0) {
      const isWhite = flashPhase % 2 === 0 || flashPhase >= FLASH_FINAL_PHASE
      drawFeatureOverlay(
        ctx,
        selected.feature,
        isWhite ? COLOR_FLASH_WHITE_FILL : COLOR_FLASH_BLUE_FILL,
        isWhite ? COLOR_SELECTED_WHITE_STROKE : COLOR_SELECTED_BLUE_STROKE,
        3,
        0.9,
      )
    }
  }

  /** 自下往上的扫描线 */
  function drawScanline(ctx: CanvasRenderingContext2D): void {
    const scanY = scanLinePos * height
    const glowHeight = height * 0.06

    const gradient = ctx.createRadialGradient(width / 2, scanY, 0, width / 2, scanY, glowHeight * 2)
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.35)')
    gradient.addColorStop(0.3, 'rgba(59, 130, 246, 0.12)')
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, scanY - glowHeight * 2, width, glowHeight * 4)

    ctx.strokeStyle = 'rgba(147, 197, 253, 0.7)'
    ctx.lineWidth = 1.5
    ctx.shadowBlur = 8
    ctx.shadowColor = 'rgba(59, 130, 246, 0.6)'
    ctx.beginPath()
    ctx.moveTo(0, scanY)
    ctx.lineTo(width, scanY)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
  }

  function panelHeight(): number {
    const measured = options.getPanelHeight?.()
    return typeof measured === 'number' && Number.isFinite(measured)
      ? measured
      : FALLBACK_PANEL_HEIGHT
  }

  /** 信息面板跟着地图移动：每帧根据地理坐标重算位置 */
  function updatePanelPosition(screen: { x: number; y: number }): number {
    const nextX = screen.x + PANEL_OFFSET_X
    const nextY = screen.y - panelHeight() - PANEL_OFFSET_Y
    if (nextX !== infoX.value) {
      infoX.value = nextX
    }
    if (nextY !== infoY.value) {
      infoY.value = nextY
    }
    return panelHeight()
  }

  function anchorToScreen(): { x: number; y: number } | null {
    if (!anchor) {
      return null
    }
    return worldToScreen(camera(), anchor.lng, anchor.lat, anchor.shift)
  }

  /** 点击位置到信息面板的连接线 */
  function drawConnector(ctx: CanvasRenderingContext2D): void {
    if (!infoVisible.value) {
      return
    }
    const screen = anchorToScreen()
    if (!screen) {
      return
    }

    const panelH = updatePanelPosition(screen)
    const startX = screen.x
    const startY = screen.y
    const targetX = infoX.value
    const targetY = infoY.value + panelH / 2
    const middleX = startX + Math.min((targetX - startX) / 2, 80)

    ctx.strokeStyle = 'rgba(147, 197, 253, 0.6)'
    ctx.lineWidth = 2
    ctx.shadowBlur = 6
    ctx.shadowColor = 'rgba(59, 130, 246, 0.5)'
    ctx.beginPath()
    ctx.moveTo(startX, startY)
    ctx.lineTo(middleX, startY)
    ctx.lineTo(targetX, targetY)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
    ctx.lineWidth = 1
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
    ctx.beginPath()
    ctx.moveTo(startX, startY)
    ctx.lineTo(middleX, startY)
    ctx.lineTo(targetX, targetY)
    ctx.stroke()
  }

  function drawFrame(): void {
    const canvas = canvasRef.value
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    const resized = measure()
    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      markDirty()
    }
    if (resized) {
      markDirty()
    }

    // 拖动过程中不重建静态层：直接用旧图按位移贴图，保证拖拽跟手
    if (cacheDirty && (!isDragging || !cacheCamera)) {
      rebuildCache()
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = COLOR_BACKGROUND
    ctx.fillRect(0, 0, pixelWidth, pixelHeight)

    if (cacheCanvas && cacheCamera) {
      let shiftX = 0
      let shiftY = 0
      if (cacheCamera.zoom === zoom) {
        const unit = scale * zoom * dpr
        shiftX = (offsetX - cacheCamera.offsetX) * unit
        shiftY = -(offsetY - cacheCamera.offsetY) * unit
      }
      ctx.drawImage(cacheCanvas, Math.round(shiftX), Math.round(shiftY))
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawHighlights(ctx)
    drawScanline(ctx)
    drawConnector(ctx)
  }

  function startAnimation(): void {
    if (rafId !== 0) {
      return
    }
    lastFrameTime = performance.now()
    const frame = (now: number): void => {
      // 切到后台再回来时 delta 会很大，截断一下避免扫描线瞬移
      const delta = Math.min((now - lastFrameTime) / 1000, 0.1)
      lastFrameTime = now
      scanLinePos += delta * SCAN_SPEED
      if (scanLinePos > 1) {
        scanLinePos -= 1
      }
      drawFrame()
      rafId = window.requestAnimationFrame(frame)
    }
    rafId = window.requestAnimationFrame(frame)
  }

  function stopAnimation(): void {
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  /* ---------- 市级数据调度 ---------- */

  function syncCityLoading(): void {
    cityLoading.value = Boolean(adm2Store && adm2Store.pending > 0)
  }

  /** 视口里出现了哪些国家、按屏幕面积排序，取前几个去加载 */
  function ensureAdmin2ForView(): void {
    if (!adm2Store) {
      return
    }
    syncCityLoading()
    if (zoom < CITY_ZOOM) {
      return
    }

    const view = expandBounds(viewBounds(camera()), 4)
    const center = screenToWorld(camera(), width / 2, height / 2)
    const visible = new Set<string>()
    const candidates: { iso: string; area: number; containsCenter: number }[] = []

    for (const feature of countryFeatures) {
      const iso = feature.iso
      if (!iso || !boundsIntersect(feature.bounds, view)) {
        continue
      }
      // 所有可见国家都保留在内存里；但只有本地有分块的国家才自动加载
      visible.add(iso)
      if (!adm2Store.hasLocal(iso)) {
        continue
      }
      // 按「在视口内实际占多少面积」排序，而不是按国土总面积：
      // 否则俄罗斯这种超大国家会一直挤掉屏幕中央的小国
      const { minLng, maxLng, minLat, maxLat } = feature.bounds
      const overlapLng = Math.min(maxLng, view.maxLng) - Math.max(minLng, view.minLng)
      const overlapLat = Math.min(maxLat, view.maxLat) - Math.max(minLat, view.minLat)
      const area = Math.max(0, overlapLng) * Math.max(0, overlapLat)
      const containsCenter = pointInFeature(center.lng, center.lat, feature) ? 1 : 0
      candidates.push({ iso, area, containsCenter })
    }

    const key = candidates
      .map((item) => item.iso)
      .sort()
      .join(',')
    if (key !== lastEnsureKey) {
      lastEnsureKey = key
      // 鼠标/视口正盯着的国家最优先，其次才按可见面积
      candidates.sort((a, b) => b.containsCenter - a.containsCenter || b.area - a.area)
      for (const candidate of candidates.slice(0, MAX_VISIBLE_ADM2)) {
        adm2Store.ensure(candidate.iso)
      }
    }

    adm2Store.retain(visible)
    syncCityLoading()
  }

  function scheduleAdmin2(delay = 240): void {
    if (ensureTimer !== null) {
      return
    }
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null
      ensureAdmin2ForView()
    }, delay)
  }

  /* ---------- 命中测试 ---------- */

  function pointInBounds(lng: number, lat: number, bounds: GeoFeatureBounds): boolean {
    return (
      lng >= bounds.minLng && lng <= bounds.maxLng && lat >= bounds.minLat && lat <= bounds.maxLat
    )
  }

  /** 放大后优先命中市级行政区，否则命中整个国家 */
  function hitTest(clientX: number, clientY: number): FeatureHit | null {
    const canvas = canvasRef.value
    if (!canvas || countryFeatures.length === 0) {
      return null
    }
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const current = camera()

    const chunks = zoom >= CITY_ZOOM && adm2Store ? adm2Store.list() : []

    for (const shift of LONGITUDE_SHIFTS) {
      const { lng, lat } = screenToWorld(current, x, y, shift)

      for (const chunk of chunks) {
        if (!pointInBounds(lng, lat, chunk.bounds)) {
          continue
        }
        for (const feature of chunk.features) {
          if (pointInFeature(lng, lat, feature)) {
            return { feature, kind: 'adm2', lng, lat, shift }
          }
        }
      }

      for (const feature of countryFeatures) {
        if (pointInFeature(lng, lat, feature)) {
          return { feature, kind: 'country', lng, lat, shift }
        }
      }
    }
    return null
  }

  /** 放大/数据加载会改变光标下的要素，但鼠标不一定移动，这里主动重算一次 */
  function refreshHover(): void {
    if (!lastPointer || isDragging) {
      return
    }
    const hit = hitTest(lastPointer.clientX, lastPointer.clientY)
    const next = hit ? { feature: hit.feature, kind: hit.kind } : null
    if (next?.feature !== hovered?.feature || next?.kind !== hovered?.kind) {
      hovered = next
      updateCursor(Boolean(next))
    }
  }

  function updateCursor(hasHover: boolean): void {
    const canvas = canvasRef.value
    if (canvas) {
      canvas.style.cursor = hasHover ? 'pointer' : 'grab'
    }
  }

  /* ---------- 音效 ---------- */

  function initAudio(): void {
    if (audioStarted) {
      return
    }
    audioStarted = true
    try {
      const audio = new Audio(scannerSoundUrl)
      audio.loop = true
      audio.volume = 0.3
      scannerAudio = audio
      // 自动播放策略可能直接拒绝，静默忽略即可
      void audio.play().catch(() => {})
    } catch {
      // 浏览器不支持 Audio 时保持静音
    }
  }

  function playClickSound(): void {
    try {
      const audio = new Audio(clickSoundUrl)
      audio.volume = 0.5
      void audio.play().catch(() => {})
    } catch {
      // 忽略音效播放失败
    }
  }

  function stopAudio(): void {
    if (scannerAudio) {
      scannerAudio.pause()
      scannerAudio.currentTime = 0
      scannerAudio = null
    }
    audioStarted = false
  }

  /* ---------- 信息面板 ---------- */

  /** geoBoundaries 的 parent 是 ISO 代码，换成国家名更好看 */
  function parentName(feature: WorldMapFeature): string {
    if (!/^[A-Z]{3}$/.test(feature.parent)) {
      return feature.parent
    }
    const country = countryFeatures.find((item) => item.iso === feature.parent)
    return country?.name ?? feature.parent
  }

  function describeSelection(selection: Selection): string {
    const { feature, kind } = selection
    if (kind === 'adm2') {
      // 各国层级含义不同（Department / Prefecture / 区县…），优先显示数据里带的层级名
      const label = adm2Store?.chunk(feature.iso)?.label ?? '次级行政区'
      return [parentName(feature), label].filter(Boolean).join(' · ')
    }
    return feature.nameEn && feature.nameEn !== feature.name ? feature.nameEn : '国家 / 地区'
  }

  function showInfoWindow(selection: Selection): void {
    const screen = anchorToScreen()
    if (!screen) {
      return
    }
    infoName.value = selection.feature.name
    infoCode.value = selection.feature.code
    infoDetail.value = describeSelection(selection)
    selectionKind.value = selection.kind
    updatePanelPosition(screen)
    infoVisible.value = true
  }

  function hideInfoWindow(): void {
    infoVisible.value = false
    selected = null
    anchor = null
    flashPhase = 0
    if (flashTimer !== null) {
      window.clearInterval(flashTimer)
      flashTimer = null
    }
  }

  function selectFeature(hit: FeatureHit): void {
    if (flashTimer !== null) {
      window.clearInterval(flashTimer)
      flashTimer = null
    }

    selected = { feature: hit.feature, kind: hit.kind }
    anchor = { lng: hit.lng, lat: hit.lat, shift: hit.shift }
    flashPhase = 1

    // 闪烁 3 次（6 个相位），第 7 个相位停在白色常亮
    flashTimer = window.setInterval(() => {
      flashPhase += 1
      if (flashPhase >= FLASH_FINAL_PHASE) {
        flashPhase = FLASH_FINAL_PHASE
        if (flashTimer !== null) {
          window.clearInterval(flashTimer)
          flashTimer = null
        }
      }
    }, FLASH_INTERVAL_MS)

    showInfoWindow({ feature: hit.feature, kind: hit.kind })
  }

  /* ---------- 指针事件 ---------- */

  function onPointerDown(event: PointerEvent): void {
    // 首次交互时启动扫描线环境音（浏览器要求必须有用户手势）
    initAudio()

    const canvas = canvasRef.value
    if (!canvas) {
      return
    }
    isDragging = true
    dragStartX = event.clientX
    dragStartY = event.clientY
    dragStartOffsetX = offsetX
    dragStartOffsetY = offsetY
    pointerDownAt = { x: event.clientX, y: event.clientY }
    canvas.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (isDragging) {
      const denominator = scale * zoom
      if (denominator > 0) {
        offsetX = dragStartOffsetX + (event.clientX - dragStartX) / denominator
        offsetY = dragStartOffsetY - (event.clientY - dragStartY) / denominator
        clampOffsetY()
      }
      return
    }

    const hit = hitTest(event.clientX, event.clientY)
    lastPointer = { clientX: event.clientX, clientY: event.clientY }
    const nextHovered = hit ? { feature: hit.feature, kind: hit.kind } : null
    const changed = nextHovered?.feature !== hovered?.feature || nextHovered?.kind !== hovered?.kind
    if (changed) {
      hovered = nextHovered
      updateCursor(Boolean(nextHovered))
    }

    // 鼠标停在一个国家上时，提前把它放大后要用的市级数据拉下来
    if (hit?.kind === 'country' && zoom >= CITY_ZOOM && hit.feature.iso) {
      adm2Store?.ensure(hit.feature.iso)
    }
  }

  function onPointerUp(event: PointerEvent): void {
    const canvas = canvasRef.value
    if (isDragging && canvas && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    isDragging = false

    // 拖动结束后把经度偏移规整回 [-180, 180)，避免数值无限增长
    const normalizedOffsetX = ((((offsetX + 180) % 360) + 360) % 360) - 180
    if (normalizedOffsetX !== offsetX) {
      offsetX = normalizedOffsetX
    }
    // 拖拽期间冻结的静态层需要按最终位置重画一次
    markDirty()

    const dx = event.clientX - pointerDownAt.x
    const dy = event.clientY - pointerDownAt.y
    if (Math.hypot(dx, dy) >= CLICK_TOLERANCE_PX) {
      scheduleAdmin2(60)
      return
    }

    const hit = hitTest(event.clientX, event.clientY)
    if (!hit) {
      if (infoVisible.value) {
        hideInfoWindow()
      }
      return
    }
    playClickSound()
    selectFeature(hit)
  }

  function onPointerCancel(): void {
    isDragging = false
    markDirty()
  }

  function onPointerLeave(): void {
    lastPointer = null
    if (hovered) {
      hovered = null
      updateCursor(false)
    }
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    const canvas = canvasRef.value
    if (!canvas || countryFeatures.length === 0) {
      return
    }

    const rect = canvas.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top

    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const nextZoom = Math.min(Math.max(zoom * factor, MIN_ZOOM), MAX_ZOOM)
    if (nextZoom === zoom) {
      return
    }

    setZoomAround(nextZoom, px, py)
    lastPointer = { clientX: event.clientX, clientY: event.clientY }
    refreshHover()
    markDirty()
    scheduleAdmin2(120)
  }

  function onWindowResize(): void {
    markDirty()
  }

  /* ---------- 数据加载 ---------- */

  async function fetchWorldFeatures(): Promise<WorldMapFeature[]> {
    const failures: string[] = []

    for (const url of [LOCAL_GEOJSON_URL, REMOTE_GEOJSON_URL]) {
      try {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        // 静态托管的 SPA 常用 index.html 兜底不存在的路径，先挡掉这种“200 但不是 JSON”
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('json')) {
          throw new Error(`内容类型不是 JSON（${contentType || '未知'}）`)
        }
        const payload: unknown = await response.json()
        if (!isRawFeatureCollection(payload)) {
          throw new Error('不是有效的 GeoJSON FeatureCollection')
        }
        const next = normalizeWorldFeatures(payload)
        if (next.length === 0) {
          throw new Error('数据里没有可绘制的多边形')
        }
        return next
      } catch (error) {
        failures.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    throw new Error(failures.join('；'))
  }

  /** 市级分块目录；没有这个文件就说明还没跑构建脚本，退回在线加载 */
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

  function createStore(index: Admin2Index | null): void {
    adm2Store?.dispose()
    adm2Store = new Admin2Store({
      baseUrl: import.meta.env.BASE_URL,
      index,
      enableRemote: true,
      maxCountries: MAX_LOADED_ADM2,
      onChange: () => {
        markDirty()
        syncCityLoading()
        refreshHover()
      },
    })
    lastEnsureKey = ''
  }

  async function load(): Promise<void> {
    loadState.value = 'loading'
    loadError.value = ''
    try {
      const [world, index] = await Promise.all([fetchWorldFeatures(), fetchAdmin2Index()])
      countryFeatures = world
      hovered = null
      selected = null
      pathCache.clear()
      createStore(index)
      loadState.value = 'ready'
      markDirty()
      scheduleAdmin2(60)
    } catch (error) {
      countryFeatures = []
      selected = null
      loadState.value = 'error'
      loadError.value = error instanceof Error ? error.message : String(error)
      markDirty()
    }
  }

  /* ---------- 生命周期 ---------- */

  onMounted(() => {
    const canvas = canvasRef.value
    if (canvas) {
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerCancel)
      canvas.addEventListener('pointerleave', onPointerLeave)
      canvas.addEventListener('wheel', onWheel, { passive: false })
    }

    const container = containerRef.value
    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        markDirty()
      })
      resizeObserver.observe(container)
    }

    window.addEventListener('resize', onWindowResize)

    measure()
    markDirty()
    startAnimation()
    void load()

    // 开发环境下暴露相机状态和聚焦方法，方便用 Playwright 之类的外部脚本做验收
    if (import.meta.env.DEV) {
      const debugWindow = window as unknown as {
        __worldMapCamera?: () => unknown
        __worldMapFocus?: (lng: number, lat: number, nextZoom?: number) => void
      }
      debugWindow.__worldMapCamera = () => ({ ...camera(), offsetX, offsetY, zoom })
      debugWindow.__worldMapFocus = (lng: number, lat: number, nextZoom?: number) => {
        if (typeof nextZoom === 'number' && Number.isFinite(nextZoom)) {
          zoom = Math.min(Math.max(nextZoom, MIN_ZOOM), MAX_ZOOM)
        }
        offsetX = -lng
        offsetY = -lat
        clampOffsetY()
        cityMode.value = zoom >= CITY_ZOOM
        refreshHover()
        markDirty()
        scheduleAdmin2(0)
      }
    }
  })

  onBeforeUnmount(() => {
    stopAnimation()
    stopAudio()

    if (ensureTimer !== null) {
      window.clearTimeout(ensureTimer)
      ensureTimer = null
    }
    adm2Store?.dispose()
    adm2Store = null

    const canvas = canvasRef.value
    if (canvas) {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
    }

    resizeObserver?.disconnect()
    resizeObserver = null
    window.removeEventListener('resize', onWindowResize)

    if (flashTimer !== null) {
      window.clearInterval(flashTimer)
      flashTimer = null
    }
  })

  return {
    containerRef,
    canvasRef,
    infoVisible,
    infoName,
    infoCode,
    infoDetail,
    infoX,
    infoY,
    selectionKind,
    cityMode,
    loadState,
    loadError,
    cityLoading,
    retry: load,
  }
}
