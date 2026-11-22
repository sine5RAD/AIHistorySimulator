import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import clickSoundUrl from '@/assets/sounds/click.mp3'
import scannerSoundUrl from '@/assets/sounds/scanner.m4a'
import { Admin2Store, type Admin2Index } from '@/lib/map/admin2-store'
import { boundsIntersect, expandBounds, pointInFeature } from '@/lib/map/geometry'
import { FeaturePathCache } from '@/lib/map/paths'
import {
  deviceTransform,
  fitScale,
  lineWidthFor,
  screenToWorld,
  viewBounds,
  worldToScreen,
  type Camera,
} from '@/lib/map/projection'
import { getFeatureTerritoryCode } from '@/lib/map/territory-code'
import {
  EVENT_DRIVE_SAVE_STORAGE_KEYS,
  buildEventDriveSaveMap,
  readActiveEventDriveSave,
  resolveSaveTerritory,
  type EventDriveSaveMap,
  type SaveAreaGroup,
  type SaveTerritoryUnit,
} from '@/utils/event-drive-save'
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
/** 视口里最多同时请求几个国家的下级行政区：不设上限，同屏国家全部加载 */
/** 内存里保留的分块上限，够覆盖一整屏国家即可 */
const MAX_LOADED_ADM2 = 96

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
/** 存档模式下未被任何政权占用的陆地：只铺一层中性底色，不再描现代国界 */
const COLOR_SAVE_LAND_FILL = 'rgba(30, 41, 59, 0.55)'
/** 存档领地的填色透明度；描边比填色更实，边界更清楚 */
const SAVE_FILL_ALPHA = 0.6
const SAVE_STROKE_ALPHA = 0.92
const SAVE_STROKE_WIDTH = 0.8
/** 存档模式下要同时保留整份世界的分块，不能再按「一屏国家」淘汰 */
const SAVE_MAX_LOADED_ADM2 = 256
/** 低于这个屏幕面积的地区不画，避免在低倍率下把上万个小区块都送进 canvas */
const SAVE_MIN_FEATURE_AREA_PX = 0.45
/**
 * 低倍率下的政治地图预先烘焙成一张世界纹理：
 * 整份存档有 4,000 多个行政区，逐块矢量化每次缩放要重画上千条路径；
 * 烘焙后世界视图和拖拽只需要一次 drawImage，放大到该倍率以上再切回矢量。
 */
const SAVE_TEXTURE_WIDTH = 4096
const SAVE_TEXTURE_HEIGHT = 2048
const SAVE_TEXTURE_MAX_ZOOM = 3
const SAVE_TEXTURE_BUILD_DELAY_MS = 180

export type WorldMapLoadState = 'loading' | 'ready' | 'error'

export type MapFeatureKind = 'country' | 'adm2' | 'area'

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
  scaleX: number
  scaleY: number
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

  /** 事件驱动页有存档时，世界地图改用存档里的政权领地着色 */
  const saveMode = ref(false)
  const saveLabel = ref('')
  const saveRegimeCount = ref(0)
  const saveUnitCount = ref(0)
  const saveAreaCount = ref(0)
  const saveAdminTotal = ref(0)
  const saveAdminLoaded = ref(0)
  /** 信息面板的强调色，跟随所点地块的政权代表色 */
  const infoAccent = ref('')

  const saveAdminLoading = computed(
    () =>
      saveMode.value && saveAdminTotal.value > 0 && saveAdminLoaded.value < saveAdminTotal.value,
  )

  let countryFeatures: WorldMapFeature[] = []
  let adm2Store: Admin2Store | null = null

  const pathCache = new FeaturePathCache()
  let saveMap: EventDriveSaveMap | null = null
  let saveAdminIsos: string[] = []
  let lastSaveSignature = ''
  let saveDirtyTimer: number | null = null
  let saveRefreshTimer: number | null = null
  let saveTextureTimer: number | null = null
  let saveTextureCanvas: HTMLCanvasElement | null = null
  let saveTextureKey = ''
  let areaGroupByFeature = new WeakMap<WorldMapFeature, SaveAreaGroup>()

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
  let scaleX = 0
  let scaleY = 0
  let cx = 0
  let cy = 0

  let cacheCanvas: HTMLCanvasElement | null = null
  /** 平移缓存用的交换画布，避免把画布画到自身 */
  let cacheSwapCanvas: HTMLCanvasElement | null = null
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
    // 横向铺满窗口宽度，纵向保证整幅世界地图都放得下；
    // 窗口比 2:1 更扁时纵向比例更小，地图因此被横向拉伸而不是裁掉南北极。
    const fitted = fitScale(width, height)
    scaleX = fitted.scaleX
    scaleY = fitted.scaleY
    cx = width / 2
    cy = height / 2
    return changed
  }

  function camera(): Camera {
    return { width, height, cx, cy, scaleX, scaleY, zoom, offsetX, offsetY }
  }

  /** 限制南北方向，避免拖出地球 */
  function clampOffsetY(): void {
    if (scaleX <= 0 || scaleY <= 0) {
      return
    }
    const halfRange = height / 2 / (scaleY * zoom)
    const minOffset = halfRange - 90
    const maxOffset = 90 - halfRange
    if (minOffset > maxOffset) {
      // 整幅地图比视口还矮，没有可拖动的余量，直接居中
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

  /* ---------- 事件驱动存档 ---------- */

  /** 把当前存档的领土变化压成一个短签名，避免只改聊天记录时重建整张政治地图。 */
  function saveSignature(map: EventDriveSaveMap): string {
    let hash = 2166136261
    const feed = (text: string): void => {
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
    }

    feed(map.save.key)

    for (const unit of map.units) {
      feed(unit.code)
      feed('|')
      feed(unit.countryCode)
      feed('|')
      feed(unit.level)
      feed('|')
      feed(unit.regimeName)
      feed('|')
      feed(unit.color)
      feed('|')
      feed(unit.name)
    }

    for (const group of map.areaGroups) {
      feed(group.regimeName)
      feed(group.color)
      for (const area of group.areas) {
        for (const point of area.vertices) {
          feed(`${point[0]},${point[1]};`)
        }
      }
    }

    return `${map.units.length}:${map.areaGroups.length}:${hash.toString(36)}`
  }

  function clearSaveTexture(): void {
    if (saveTextureTimer !== null) {
      window.clearTimeout(saveTextureTimer)
      saveTextureTimer = null
    }

    saveTextureCanvas = null
    saveTextureKey = ''
  }

  function scheduleSaveTexture(delay = SAVE_TEXTURE_BUILD_DELAY_MS): void {
    if (saveTextureTimer !== null) {
      return
    }

    saveTextureTimer = window.setTimeout(() => {
      saveTextureTimer = null
      buildSaveTexture()
    }, delay)
  }

  /**
   * 把整个存档政治地图烘焙成一张等距圆柱纹理。
   *
   * 构建期间临时切换模块内的相机参数，构建完立刻恢复；
   * 因此调用方必须保证它不在绘制帧内部被调用（通过 setTimeout 调度）。
   */
  function buildSaveTexture(): void {
    if (!saveMode.value || !saveMap || countryFeatures.length === 0) {
      return
    }

    if (saveAdminTotal.value > 0 && saveAdminLoaded.value < saveAdminTotal.value) {
      return
    }

    const key = `${lastSaveSignature}|${saveAdminLoaded.value}`
    if (saveTextureCanvas && saveTextureKey === key) {
      return
    }

    const canvas = saveTextureCanvas ?? document.createElement('canvas')
    const context = canvas.getContext('2d')

    if (!context) {
      return
    }

    if (canvas.width !== SAVE_TEXTURE_WIDTH || canvas.height !== SAVE_TEXTURE_HEIGHT) {
      canvas.width = SAVE_TEXTURE_WIDTH
      canvas.height = SAVE_TEXTURE_HEIGHT
    }

    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, SAVE_TEXTURE_WIDTH, SAVE_TEXTURE_HEIGHT)
    context.lineJoin = 'round'
    context.lineCap = 'round'

    const previous = {
      width,
      height,
      scaleX,
      scaleY,
      cx,
      cy,
      zoom,
      offsetX,
      offsetY,
      dpr,
    }

    try {
      width = SAVE_TEXTURE_WIDTH
      height = SAVE_TEXTURE_HEIGHT
      scaleX = SAVE_TEXTURE_WIDTH / 360
      scaleY = SAVE_TEXTURE_HEIGHT / 180
      cx = SAVE_TEXTURE_WIDTH / 2
      cy = SAVE_TEXTURE_HEIGHT / 2
      zoom = 1
      offsetX = 0
      offsetY = 0
      dpr = 1

      drawSaveLandBase(context)
      drawSaveCountryUnits(context)
      drawSaveAreaGroups(context)
      drawSaveAdminUnits(context)
    } catch (error) {
      // 纹理烘焙失败时退回逐块矢量绘制，不影响政治地图本身。
      saveTextureCanvas = null
      saveTextureKey = ''
      console.warn('Failed to bake save map texture', error)
      return
    } finally {
      width = previous.width
      height = previous.height
      scaleX = previous.scaleX
      scaleY = previous.scaleY
      cx = previous.cx
      cy = previous.cy
      zoom = previous.zoom
      offsetX = previous.offsetX
      offsetY = previous.offsetY
      dpr = previous.dpr
    }

    saveTextureCanvas = canvas
    saveTextureKey = key
    markDirty()
  }

  function drawSaveTexture(ctx: CanvasRenderingContext2D): boolean {
    const texture = saveTextureCanvas

    if (!texture) {
      return false
    }

    const current = camera()
    const unitX = scaleX * zoom
    const unitY = scaleY * zoom
    const drawWidth = 360 * unitX
    const drawHeight = 180 * unitY

    if (drawWidth <= 0 || drawHeight <= 0) {
      return false
    }

    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    for (const shift of LONGITUDE_SHIFTS) {
      const topLeft = worldToScreen(current, -180, 90, shift)

      if (
        topLeft.x > width ||
        topLeft.y > height ||
        topLeft.x + drawWidth < 0 ||
        topLeft.y + drawHeight < 0
      ) {
        continue
      }

      ctx.drawImage(texture, topLeft.x, topLeft.y, drawWidth, drawHeight)
    }

    ctx.restore()
    return true
  }

  function syncSaveAdminProgress(): void {
    if (!saveMode.value || !adm2Store) {
      saveAdminTotal.value = 0
      saveAdminLoaded.value = 0
      return
    }

    saveAdminTotal.value = saveAdminIsos.length
    let loaded = 0

    for (const iso of saveAdminIsos) {
      const state = adm2Store.state(iso)

      if (state === 'ready' || state === 'missing') {
        loaded += 1
      }
    }

    saveAdminLoaded.value = loaded
  }

  function clearSaveDirtyTimer(): void {
    if (saveDirtyTimer !== null) {
      window.clearTimeout(saveDirtyTimer)
      saveDirtyTimer = null
    }
  }

  /** 分块陆续返回时不要每块都重建整张缓存，攒一小段时间再画。 */
  function scheduleSaveDirty(delay = 160): void {
    if (saveDirtyTimer !== null) {
      return
    }

    saveDirtyTimer = window.setTimeout(() => {
      saveDirtyTimer = null
      markDirty()
      refreshHover()
    }, delay)
  }

  /** 有下级行政区编号时，按国家代码只加载相关分块；推导不出国家时全量加载。 */
  function computeSaveAdminCountries(map: EventDriveSaveMap): string[] {
    if (!adm2Store) {
      return []
    }

    const needed = new Map<string, number>()
    let hasUnknownCountry = false

    for (const unit of map.units) {
      if (unit.level === 'country') {
        continue
      }

      if (!unit.countryCode) {
        hasUnknownCountry = true
        continue
      }

      needed.set(unit.countryCode, (needed.get(unit.countryCode) ?? 0) + 1)
    }

    const indexed = adm2Store.indexedCountries()

    if (hasUnknownCountry) {
      return indexed
    }

    return indexed
      .filter((iso) => needed.has(iso))
      .sort((left, right) => (needed.get(right) ?? 0) - (needed.get(left) ?? 0))
  }

  function ensureSaveAdmin2(): void {
    if (!adm2Store || !saveMap) {
      saveAdminIsos = []
      syncSaveAdminProgress()
      return
    }

    saveAdminIsos = computeSaveAdminCountries(saveMap)
    syncSaveAdminProgress()

    for (const iso of saveAdminIsos) {
      adm2Store.ensure(iso)
    }

    syncSaveAdminProgress()
    scheduleSaveTexture()
  }

  function resetSaveState(): void {
    saveMap = null
    saveLabel.value = ''
    saveRegimeCount.value = 0
    saveUnitCount.value = 0
    saveAreaCount.value = 0
    saveAdminIsos = []
    saveAdminTotal.value = 0
    saveAdminLoaded.value = 0
    infoAccent.value = ''
    lastSaveSignature = ''
    areaGroupByFeature = new WeakMap()
    clearSaveTexture()
    adm2Store?.setMaxCountries(MAX_LOADED_ADM2)
  }

  /**
   * 重新读取事件驱动页当前加载的存档。
   *
   * 没有存档、或存档里没有任何能落到地图上的领土时，保持原来的现代国界；
   * 有存档则整张地图改成按政权颜色填充的政治地图。
   */
  function refreshEventDriveSave(): void {
    if (countryFeatures.length === 0) {
      return
    }

    const snapshot = readActiveEventDriveSave()
    const nextSaveMap = snapshot ? buildEventDriveSaveMap(snapshot) : null

    if (!nextSaveMap || (nextSaveMap.units.length === 0 && nextSaveMap.areaGroups.length === 0)) {
      const wasSaveMode = saveMode.value
      resetSaveState()
      saveMode.value = false

      if (wasSaveMode) {
        hideInfoWindow()
        markDirty()
        refreshHover()
      }

      return
    }

    const signature = saveSignature(nextSaveMap)
    const changed = signature !== lastSaveSignature
    const wasSaveMode = saveMode.value

    saveMode.value = true

    if (changed) {
      saveMap = nextSaveMap
      areaGroupByFeature = new WeakMap(
        nextSaveMap.areaGroups.map((group) => [group.feature, group]),
      )
      clearSaveTexture()
    }

    saveLabel.value = nextSaveMap.label
    saveRegimeCount.value = nextSaveMap.regimes.length
    saveUnitCount.value = nextSaveMap.units.length
    saveAreaCount.value = nextSaveMap.areaGroups.reduce(
      (total, group) => total + group.areas.length,
      0,
    )
    lastSaveSignature = signature

    adm2Store?.setMaxCountries(SAVE_MAX_LOADED_ADM2)
    ensureSaveAdmin2()
    scheduleSaveTexture()

    if (changed) {
      if (wasSaveMode) {
        hideInfoWindow()
      }
      refreshHover()
      markDirty()
    }
  }

  function scheduleSaveRefresh(delay = 120): void {
    if (saveRefreshTimer !== null) {
      return
    }

    saveRefreshTimer = window.setTimeout(() => {
      saveRefreshTimer = null

      if (loadState.value === 'ready') {
        refreshEventDriveSave()
      }
    }, delay)
  }

  function saveUnitForFeature(feature: WorldMapFeature): SaveTerritoryUnit | null {
    if (!saveMode.value || !saveMap || areaGroupByFeature.has(feature)) {
      return null
    }

    return resolveSaveTerritory(saveMap, getFeatureTerritoryCode(feature), feature.iso)
  }

  function saveAreaForFeature(feature: WorldMapFeature): SaveAreaGroup | null {
    return saveMode.value ? (areaGroupByFeature.get(feature) ?? null) : null
  }

  /* ---------- 绘制工具 ---------- */

  function markDirty(): void {
    cacheDirty = true
  }

  function applyCameraTransform(ctx: CanvasRenderingContext2D, shift: number): void {
    const transform = deviceTransform(camera(), dpr, shift)
    ctx.setTransform(transform.a, 0, 0, transform.d, transform.e, transform.f)
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

  /** 网格密度：缩放越大，网格越密 */
  function gridStep(): number {
    return zoom <= 1 ? 30 : zoom < 3 ? 15 : zoom < 6 ? 10 : 5
  }

  /** 经纬度网格：缩放越大，网格越密 */
  function drawGrid(ctx: CanvasRenderingContext2D): void {
    const step = gridStep()
    const unitX = scaleX * zoom
    const unitY = scaleY * zoom

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
      const y = cy - (lat + offsetY) * unitY
      if (y < 0 || y > height) {
        continue
      }
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
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
        const x = cx + (lng + offsetX + shift) * unitX
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

  /**
   * 纬线标签固定在画布左边缘，不随地图横向平移；
   * 所以它不烘焙进静态缓存，而是每帧单独画在动画层上。
   */
  function drawLatitudeLabels(ctx: CanvasRenderingContext2D): void {
    const step = gridStep()
    const unitY = scaleY * zoom
    const firstLat = Math.ceil((-90 - offsetY) / step) * step
    const lastLat = Math.floor((90 - offsetY) / step) * step

    ctx.save()
    ctx.fillStyle = COLOR_GRID_LABEL
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.globalAlpha = 0.7
    for (let lat = firstLat; lat <= lastLat; lat += step) {
      if (lat < -90 || lat > 90) {
        continue
      }
      const y = cy - (lat + offsetY) * unitY
      if (y < 0 || y > height) {
        continue
      }
      const label = lat === 0 ? '0°' : lat > 0 ? `${lat}°N` : `${-lat}°S`
      ctx.fillText(label, 6, y + 3)
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

  /** 存档模式：先把整块陆地铺成中性底色，现代国界一条都不画。 */
  function drawSaveLandBase(ctx: CanvasRenderingContext2D): void {
    drawFeatures(ctx, countryFeatures, { fill: COLOR_SAVE_LAND_FILL })
  }

  /** 存档模式：整国归属于某个政权时，用政权代表色填满该国。 */
  function drawSaveCountryUnits(ctx: CanvasRenderingContext2D): void {
    const current = camera()
    const lineWidth = lineWidthFor(current, SAVE_STROKE_WIDTH)

    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    for (const shift of LONGITUDE_SHIFTS) {
      const view = cullBounds(shift)
      applyCameraTransform(ctx, shift)

      for (const feature of countryFeatures) {
        if (!boundsIntersect(feature.bounds, view)) {
          continue
        }

        const unit = saveUnitForFeature(feature)

        if (!unit || unit.level !== 'country') {
          continue
        }

        const path = pathCache.get(feature)

        if (!path) {
          continue
        }

        ctx.fillStyle = unit.color
        ctx.globalAlpha = SAVE_FILL_ALPHA
        ctx.fill(path, 'evenodd')

        ctx.strokeStyle = unit.color
        ctx.globalAlpha = SAVE_STROKE_ALPHA
        ctx.lineWidth = lineWidth
        ctx.stroke(path)
      }
    }

    ctx.restore()
  }

  /** 存档模式：世界生成导出的手绘国土多边形。 */
  function drawSaveAreaGroups(ctx: CanvasRenderingContext2D): void {
    const groups = saveMap?.areaGroups

    if (!groups?.length) {
      return
    }

    const current = camera()
    const lineWidth = lineWidthFor(current, 1.1)

    ctx.save()
    ctx.lineJoin = 'round'

    for (const group of groups) {
      const path = pathCache.get(group.feature)

      if (!path) {
        continue
      }

      for (const shift of LONGITUDE_SHIFTS) {
        if (!boundsIntersect(group.bounds, cullBounds(shift))) {
          continue
        }

        applyCameraTransform(ctx, shift)
        ctx.fillStyle = group.color
        ctx.strokeStyle = group.color
        ctx.globalAlpha = 0.48
        ctx.fill(path, 'evenodd')
        ctx.globalAlpha = 0.9
        ctx.lineWidth = lineWidth
        ctx.stroke(path)
      }
    }

    ctx.restore()
  }

  /**
   * 存档模式：一级 / 二级行政区按政权颜色填充。
   *
   * 只画已经加载、并且确实被存档指派了政权的区块；
   * 未指派的地区保持中性底色，不再画现代行政区界线。
   */
  function drawSaveAdminUnits(ctx: CanvasRenderingContext2D): void {
    if (!adm2Store) {
      return
    }

    const chunks = adm2Store.list()

    if (!chunks.length) {
      return
    }

    const current = camera()
    const unitX = scaleX * zoom
    const unitY = scaleY * zoom
    const lineWidth = lineWidthFor(current, 0.7)

    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    for (const shift of LONGITUDE_SHIFTS) {
      const view = cullBounds(shift)
      applyCameraTransform(ctx, shift)

      for (const chunk of chunks) {
        if (!boundsIntersect(chunk.bounds, view)) {
          continue
        }

        for (const feature of chunk.features) {
          if (!boundsIntersect(feature.bounds, view)) {
            continue
          }

          const spanX = (feature.bounds.maxLng - feature.bounds.minLng) * unitX
          const spanY = (feature.bounds.maxLat - feature.bounds.minLat) * unitY

          // 低倍率下大量小区块只有亚像素大小，画了也看不见，直接跳过。
          if (spanX * spanY < SAVE_MIN_FEATURE_AREA_PX) {
            continue
          }

          const unit = saveUnitForFeature(feature)

          if (!unit || unit.level === 'country') {
            continue
          }

          const path = pathCache.get(feature)

          if (!path) {
            continue
          }

          ctx.fillStyle = unit.color
          ctx.globalAlpha = SAVE_FILL_ALPHA
          ctx.fill(path, 'evenodd')

          ctx.strokeStyle = unit.color
          ctx.globalAlpha = SAVE_STROKE_ALPHA
          ctx.lineWidth = lineWidth
          ctx.stroke(path)
        }
      }
    }

    ctx.restore()
  }

  /** 静态层内容：网格、市级行政区、国界描边；完整重建与平移补绘共用 */
  function paintStatic(ctx: CanvasRenderingContext2D): void {
    drawGrid(ctx)

    if (countryFeatures.length === 0) {
      return
    }

    // 有事件驱动存档时，整张地图换成政权政治地图：
    // 不再绘制 Natural Earth 的现代国界，改用存档里的领土编号与代表色。
    if (saveMode.value && saveMap) {
      // 低倍率用预烘焙纹理，拖拽 / 缩放不再逐块重画 4,000 多条路径。
      if (!(zoom <= SAVE_TEXTURE_MAX_ZOOM && drawSaveTexture(ctx))) {
        drawSaveLandBase(ctx)
        drawSaveCountryUnits(ctx)
        drawSaveAreaGroups(ctx)
        drawSaveAdminUnits(ctx)
      }
      return
    }

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

  /**
   * 把相机偏移吸附到设备像素网格。
   * 这样拖动时缓存只需做整数像素平移，补绘的窄条和旧图不会出现亚像素错位。
   */
  function snapCameraToPixels(): void {
    const unitX = scaleX * zoom * dpr
    const unitY = scaleY * zoom * dpr
    if (unitX > 0) {
      offsetX = Math.round(offsetX * unitX) / unitX
    }
    if (unitY > 0) {
      offsetY = Math.round(offsetY * unitY) / unitY
    }
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
    snapCameraToPixels()

    const cacheWidth = Math.max(1, Math.round(width * dpr))
    const cacheHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== cacheWidth || canvas.height !== cacheHeight) {
      canvas.width = cacheWidth
      canvas.height = cacheHeight
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = COLOR_BACKGROUND
    ctx.fillRect(0, 0, width, height)
    paintStatic(ctx)

    cacheCamera = { width, height, dpr, scaleX, scaleY, zoom, offsetX, offsetY }
    cacheDirty = false
    // 视角变化后看看当前视口里有哪些国家需要市级数据
    scheduleAdmin2(180)
  }

  /**
   * 拖动时的增量更新：把旧缓存按整数像素平移，只对露出来的窄条重绘静态层。
   * 相比整屏重建，补绘面积通常只有几百分之一，拖动时也能实时渲染新区域。
   */
  function panCache(): boolean {
    const previous = cacheCanvas
    const snapshot = cacheCamera
    if (!previous || !snapshot) {
      return false
    }
    if (
      snapshot.width !== width ||
      snapshot.height !== height ||
      snapshot.dpr !== dpr ||
      snapshot.zoom !== zoom ||
      snapshot.scaleX !== scaleX ||
      snapshot.scaleY !== scaleY
    ) {
      return false
    }

    const unitX = scaleX * zoom * dpr
    const unitY = scaleY * zoom * dpr
    if (unitX <= 0 || unitY <= 0) {
      return false
    }
    const shiftX = Math.round((offsetX - snapshot.offsetX) * unitX)
    const shiftY = Math.round(-(offsetY - snapshot.offsetY) * unitY)
    if (shiftX === 0 && shiftY === 0) {
      return true
    }

    const pixelWidth = previous.width
    const pixelHeight = previous.height
    if (Math.abs(shiftX) >= pixelWidth || Math.abs(shiftY) >= pixelHeight) {
      return false
    }

    const canvas = cacheSwapCanvas ?? (cacheSwapCanvas = document.createElement('canvas'))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return false
    }

    // 1. 旧缓存整体平移（设备像素，整数平移不会模糊）
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(previous, shiftX, shiftY)

    // 2. 只补绘新露出的窄条
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.beginPath()
    if (shiftX > 0) {
      ctx.rect(0, 0, shiftX / dpr, height)
    } else if (shiftX < 0) {
      ctx.rect((pixelWidth + shiftX) / dpr, 0, -shiftX / dpr, height)
    }
    if (shiftY > 0) {
      ctx.rect(0, 0, width, shiftY / dpr)
    } else if (shiftY < 0) {
      ctx.rect(0, (pixelHeight + shiftY) / dpr, width, -shiftY / dpr)
    }
    ctx.clip()
    ctx.fillStyle = COLOR_BACKGROUND
    ctx.fillRect(0, 0, width, height)
    paintStatic(ctx)
    ctx.restore()

    // 两块画布交换，旧的留作下一次平移的源
    cacheSwapCanvas = previous
    cacheCanvas = canvas
    cacheCamera = { width, height, dpr, scaleX, scaleY, zoom, offsetX, offsetY }
    cacheDirty = false
    scheduleAdmin2(180)
    return true
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
      const unit = saveUnitForFeature(hovered.feature)
      const area = saveAreaForFeature(hovered.feature)
      const color = unit?.color ?? area?.color
      const highlighted = Boolean(unit || area)

      drawFeatureOverlay(
        ctx,
        hovered.feature,
        color ?? COLOR_HOVER_FILL,
        highlighted ? '#f8fafc' : COLOR_HOVER_STROKE,
        3,
        highlighted ? 0.32 : 0.85,
      )
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

    // 视角变化时优先做增量平移：只补绘新露出的窄条，拖动时也能实时看到新区域。
    // 缩放、尺寸变化或跨度过大时才整屏重建。
    if (cacheDirty || !cacheCamera) {
      rebuildCache()
    } else if (
      cacheCamera.width !== width ||
      cacheCamera.height !== height ||
      cacheCamera.dpr !== dpr ||
      cacheCamera.zoom !== zoom ||
      cacheCamera.scaleX !== scaleX ||
      cacheCamera.scaleY !== scaleY
    ) {
      rebuildCache()
    } else if (cacheCamera.offsetX !== offsetX || cacheCamera.offsetY !== offsetY) {
      if (!panCache()) {
        rebuildCache()
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = COLOR_BACKGROUND
    ctx.fillRect(0, 0, pixelWidth, pixelHeight)

    if (cacheCanvas) {
      ctx.drawImage(cacheCanvas, 0, 0)
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawLatitudeLabels(ctx)
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

    const views = LONGITUDE_SHIFTS.map((shift) => expandBounds(viewBounds(camera(), shift), 4))
    const center = screenToWorld(camera(), width / 2, height / 2)
    const visible = new Set<string>()
    const candidates: { iso: string; area: number; containsCenter: number }[] = []

    for (const feature of countryFeatures) {
      const iso = feature.iso
      if (!iso) {
        continue
      }
      // 跨 180° 经线的国家（美国、俄罗斯等）包围盒会被展开到 182°~294°，
      // 只按 shift 0 判断会永远“不可见”，所以三个经度副本都要参与
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
      // 所有可见国家都保留在内存里；但只有本地有分块的国家才自动加载
      visible.add(iso)
      if (!adm2Store.hasLocal(iso)) {
        continue
      }
      const containsCenter = pointInFeature(center.lng, center.lat, feature) ? 1 : 0
      candidates.push({ iso, area, containsCenter })
    }

    const key = candidates
      .map((item) => item.iso)
      .sort()
      .join(',')
    if (key !== lastEnsureKey) {
      lastEnsureKey = key
      // 鼠标/视口正盯着的国家最优先，其余按可见面积依次加载
      candidates.sort((a, b) => b.containsCenter - a.containsCenter || b.area - a.area)
      for (const candidate of candidates) {
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

    // 存档模式下即便还没放大，也要优先命中存档里的下级行政区；
    // 普通模式仍然只在放大到市级后才查分块。
    const chunks = adm2Store && (saveMode.value || zoom >= CITY_ZOOM) ? adm2Store.list() : []

    // 存档模式下，未指派的行政区只是兜底：先继续找有政权归属的地块，
    // 避免整国已上色、点开某个没单独指派的地区却显示「未归属」。
    let unassignedAdminHit: FeatureHit | null = null
    let unassignedCountryHit: FeatureHit | null = null

    // 先在三个经度副本里找下级行政区，再找国家。
    // 否则跨 180° 的国家（美国、俄罗斯）会在 shift=-360 时先命中整块国家，
    // 导致屏幕上的州/都市区永远选不中。
    for (const shift of LONGITUDE_SHIFTS) {
      const { lng, lat } = screenToWorld(current, x, y, shift)
      for (const chunk of chunks) {
        if (!pointInBounds(lng, lat, chunk.bounds)) {
          continue
        }
        for (const feature of chunk.features) {
          if (!pointInFeature(lng, lat, feature)) {
            continue
          }

          const hit: FeatureHit = { feature, kind: 'adm2', lng, lat, shift }

          if (!saveMode.value || saveUnitForFeature(feature)) {
            return hit
          }

          unassignedAdminHit ??= hit
        }
      }
    }

    // 世界生成的手绘国土没有行政区编号，单独按多边形命中。
    if (saveMode.value && saveMap) {
      for (const shift of LONGITUDE_SHIFTS) {
        const { lng, lat } = screenToWorld(current, x, y, shift)
        for (const group of saveMap.areaGroups) {
          if (!pointInBounds(lng, lat, group.bounds)) {
            continue
          }

          if (pointInFeature(lng, lat, group.feature)) {
            return { feature: group.feature, kind: 'area', lng, lat, shift }
          }
        }
      }
    }

    for (const shift of LONGITUDE_SHIFTS) {
      const { lng, lat } = screenToWorld(current, x, y, shift)
      for (const feature of countryFeatures) {
        if (!pointInFeature(lng, lat, feature)) {
          continue
        }

        const hit: FeatureHit = { feature, kind: 'country', lng, lat, shift }

        if (!saveMode.value || saveUnitForFeature(feature)) {
          return hit
        }

        unassignedCountryHit ??= hit
      }
    }

    return unassignedAdminHit ?? unassignedCountryHit
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
    const unit = saveUnitForFeature(feature)
    const area = saveAreaForFeature(feature)

    if (saveMode.value) {
      if (area) {
        return `${area.areas.length} 块区域 · 世界生成边界`
      }

      if (unit) {
        // 各国层级含义不同（Department / Prefecture / 区县…），优先显示数据里带的层级名
        const label =
          kind === 'adm2' ? (adm2Store?.chunk(feature.iso)?.label ?? '次级行政区') : '政权领地'
        const place = unit.name && unit.name !== unit.code ? unit.name : feature.name
        return [place, label].filter(Boolean).join(' · ')
      }

      return [kind === 'adm2' ? parentName(feature) : '', '存档中未归属该地块']
        .filter(Boolean)
        .join(' · ')
    }

    if (kind === 'adm2') {
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
    const unit = saveUnitForFeature(selection.feature)
    const area = saveAreaForFeature(selection.feature)
    infoName.value = unit?.regimeName ?? area?.regimeName ?? selection.feature.name
    infoCode.value = unit
      ? `政权 · ${selection.feature.code}`
      : area
        ? '手绘国土'
        : selection.feature.code
    infoAccent.value = unit?.color ?? area?.color ?? ''
    infoDetail.value = describeSelection(selection)
    selectionKind.value = selection.kind
    updatePanelPosition(screen)
    infoVisible.value = true
  }

  function hideInfoWindow(): void {
    infoVisible.value = false
    infoAccent.value = ''
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
      const unitX = scaleX * zoom
      const unitY = scaleY * zoom
      if (unitX > 0 && unitY > 0) {
        offsetX = dragStartOffsetX + (event.clientX - dragStartX) / unitX
        offsetY = dragStartOffsetY - (event.clientY - dragStartY) / unitY
        clampOffsetY()
        // 吸附到设备像素后，缓存才能用整数像素平移补绘
        snapCameraToPixels()
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

    // 拖动结束后把经度偏移规整回 [-180, 180)，避免数值无限增长。
    // 同步修正缓存快照的偏移量，画面不变，也不需要为此重建缓存。
    const normalizedOffsetX = ((((offsetX + 180) % 360) + 360) % 360) - 180
    if (normalizedOffsetX !== offsetX) {
      const delta = normalizedOffsetX - offsetX
      offsetX = normalizedOffsetX
      if (cacheCamera) {
        cacheCamera.offsetX += delta
      }
    }

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
      maxCountries: saveMode.value ? SAVE_MAX_LOADED_ADM2 : MAX_LOADED_ADM2,
      onChange: () => {
        syncCityLoading()
        syncSaveAdminProgress()

        if (saveMode.value) {
          // 存档模式一次要加载整份世界，分块批次很多；攒一会儿再重建缓存。
          if (!adm2Store || adm2Store.pending === 0) {
            clearSaveDirtyTimer()
            markDirty()
            refreshHover()
            scheduleSaveTexture()
          } else {
            scheduleSaveDirty()
          }
          return
        }

        markDirty()
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
      clearSaveTexture()
      createStore(index)
      loadState.value = 'ready'
      refreshEventDriveSave()
      markDirty()
      scheduleAdmin2(60)
    } catch (error) {
      countryFeatures = []
      selected = null
      resetSaveState()
      saveMode.value = false
      loadState.value = 'error'
      loadError.value = error instanceof Error ? error.message : String(error)
      markDirty()
    }
  }

  function onStorageChange(event: StorageEvent): void {
    if (event.key && !(EVENT_DRIVE_SAVE_STORAGE_KEYS as readonly string[]).includes(event.key)) {
      return
    }

    scheduleSaveRefresh()
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      scheduleSaveRefresh()
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
    // 另一个标签页里事件驱动页保存后，世界地图不用刷新也能切换
    window.addEventListener('storage', onStorageChange)
    document.addEventListener('visibilitychange', onVisibilityChange)

    measure()
    markDirty()
    startAnimation()
    void load()

    // 开发环境下暴露相机状态和聚焦方法，方便用 Playwright 之类的外部脚本做验收
    if (import.meta.env.DEV) {
      const debugWindow = window as unknown as {
        __worldMapCamera?: () => unknown
        __worldMapFocus?: (lng: number, lat: number, nextZoom?: number) => void
        __worldMapSave?: () => unknown
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
      debugWindow.__worldMapSave = () => ({
        active: saveMode.value,
        label: saveLabel.value,
        regimes: saveRegimeCount.value,
        units: saveUnitCount.value,
        areas: saveAreaCount.value,
        adminLoaded: saveAdminLoaded.value,
        adminTotal: saveAdminTotal.value,
        texture: Boolean(saveTextureCanvas),
      })
    }
  })

  onBeforeUnmount(() => {
    stopAnimation()
    stopAudio()

    if (ensureTimer !== null) {
      window.clearTimeout(ensureTimer)
      ensureTimer = null
    }
    clearSaveDirtyTimer()
    clearSaveTexture()
    if (saveRefreshTimer !== null) {
      window.clearTimeout(saveRefreshTimer)
      saveRefreshTimer = null
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
    window.removeEventListener('storage', onStorageChange)
    document.removeEventListener('visibilitychange', onVisibilityChange)

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
    infoAccent,
    infoX,
    infoY,
    selectionKind,
    cityMode,
    loadState,
    loadError,
    cityLoading,
    saveMode,
    saveLabel,
    saveRegimeCount,
    saveUnitCount,
    saveAreaCount,
    saveAdminLoaded,
    saveAdminTotal,
    saveAdminLoading,
    retry: load,
  }
}
