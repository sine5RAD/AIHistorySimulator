/**
 * 次级行政区（省级/市级/县级）分块加载器。
 *
 * 全球行政区数据有几十 MB，不可能整包塞进浏览器，所以按国家拆成
 * `public/geo/admin2/<ISO>.geojson` 分块，视图里出现了哪个国家才加载哪个。
 * 本地没有的国家可以退回 geoBoundaries 官方接口（默认开启，失败就静默跳过）。
 */
import {
  isRawFeatureCollection,
  normalizeWorldFeatures,
  type GeoFeatureBounds,
  type RawFeatureCollection,
  type WorldMapFeature,
} from '@/types/geo'

export type Admin2LoadState = 'idle' | 'loading' | 'ready' | 'missing'

export interface Admin2IndexEntry {
  units: number
  bytes?: number
  source?: string
  level?: string
  canonical?: string | null
  bounds?: [number, number, number, number] | null
}

export interface Admin2Index {
  countries?: Record<string, Admin2IndexEntry>
  generatedAt?: string
  attribution?: Record<string, string>
}

export interface Admin2Chunk {
  iso: string
  features: WorldMapFeature[]
  bounds: GeoFeatureBounds
  source: 'local' | 'remote'
  /** 该层级的官方名称，例如 Department / Prefecture / 区县 */
  label: string
}

export interface Admin2StoreOptions {
  /** `public/geo/` 的地址前缀，通常是 import.meta.env.BASE_URL */
  baseUrl: string
  /** 分块目录；本地文件存在与否以它为准 */
  index: Admin2Index | null
  /** 本地文件缺失时是否回退到 geoBoundaries 官方接口 */
  enableRemote?: boolean
  /** 内存里最多保留几个国家的分块 */
  maxCountries?: number
  /** 状态变化时通知调用方重绘 */
  onChange: () => void
  /** 加载失败时的提示 */
  onNotice?: (message: string) => void
}

/** geoBoundaries 官方元数据接口 */
const GEOBOUNDARIES_API = 'https://www.geoboundaries.org/api/current/gbOpen'
/** 国内直连 GitHub 经常超时，失败后套一层反代再试 */
const GEOBOUNDARIES_PROXIES: ((url: string) => string)[] = [
  (url) => url,
  (url) => `https://ghfast.top/${url}`,
]

const META_TIMEOUT = 15_000
const REMOTE_TIMEOUT = 30_000
/** 并发下载数：分块都很小，4 路足够把一屏国家快速拉齐 */
const MAX_CONCURRENT = 4

function withTimeout(timeout: number): AbortSignal {
  return AbortSignal.timeout(timeout)
}

async function fetchJson(url: string, timeout: number): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      signal: withTimeout(timeout),
      headers: { accept: 'application/json,application/geo+json,*/*' },
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/**
 * geoBoundaries 元数据里给的是 `github.com/<owner>/<repo>/raw/<ref>/<path>`，
 * 这个地址跨域重定向后 CORS 头是空的，浏览器会直接拒绝。
 * 换成 `raw.githubusercontent.com` 直链（带 `Access-Control-Allow-Origin: *`）。
 */
export function toCorsSafeUrl(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/.exec(url)
  if (!match) {
    return url
  }
  const [, owner, repo, ref, path] = match
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
}

/** 依次尝试原始地址和反代，返回第一个能解析成 GeoJSON 的结果 */
async function fetchGeoJsonWithMirrors(urls: string[], timeout: number): Promise<unknown | null> {
  for (const url of urls) {
    const safeUrl = toCorsSafeUrl(url)
    for (const wrap of GEOBOUNDARIES_PROXIES) {
      const payload = await fetchJson(wrap(safeUrl), timeout)
      if (isRawFeatureCollection(payload)) {
        return payload
      }
    }
  }
  return null
}

/** 从 geoBoundaries 拉一个国家的下级行政区 */
async function fetchRemoteAdm2(iso: string): Promise<RawFeatureCollection | null> {
  const meta = await fetchJson(`${GEOBOUNDARIES_API}/${iso}/ADM2/`, META_TIMEOUT)
  if (typeof meta !== 'object' || meta === null) {
    return null
  }
  const record = meta as Record<string, unknown>
  const urls = [record.simplifiedGeometryGeoJSON, record.gjDownloadURL].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  if (urls.length === 0) {
    return null
  }
  const payload = await fetchGeoJsonWithMirrors(urls, REMOTE_TIMEOUT)
  return isRawFeatureCollection(payload) ? payload : null
}

export class Admin2Store {
  private readonly options: Admin2StoreOptions
  private readonly chunks = new Map<string, Admin2Chunk>()
  private readonly states = new Map<string, Admin2LoadState>()
  private readonly queue: string[] = []
  private active = 0
  private disposed = false

  constructor(options: Admin2StoreOptions) {
    this.options = options
  }

  get indexed(): boolean {
    return Boolean(this.options.index?.countries)
  }

  /** 该国家是否在本地分块目录里 */
  hasLocal(iso: string): boolean {
    return Boolean(this.options.index?.countries?.[iso])
  }

  state(iso: string): Admin2LoadState {
    return this.states.get(iso) ?? 'idle'
  }

  chunk(iso: string): Admin2Chunk | null {
    const chunk = this.chunks.get(iso)
    if (chunk) {
      // 命中即刷新 LRU 顺序
      this.chunks.delete(iso)
      this.chunks.set(iso, chunk)
    }
    return chunk ?? null
  }

  /** 当前已加载的所有分块（按 LRU 顺序，最久未用的在前） */
  list(): Admin2Chunk[] {
    return [...this.chunks.values()]
  }

  get loadedCountries(): number {
    return this.chunks.size
  }

  /** 还在排队或正在下载的国家数，用于界面上显示加载提示 */
  get pending(): number {
    return this.queue.length + this.active
  }

  /** 请求加载某个国家；重复调用是安全的 */
  ensure(iso: string): void {
    if (!iso || this.disposed) {
      return
    }
    if (this.states.get(iso) === 'ready' || this.states.get(iso) === 'loading') {
      return
    }
    if (this.states.get(iso) === 'missing') {
      return
    }
    if (!this.hasLocal(iso) && this.options.enableRemote === false) {
      return
    }
    this.states.set(iso, 'loading')
    this.queue.push(iso)
    this.options.onChange()
    this.pump()
  }

  /** 只保留当前视图相关的分块，超出上限时按 LRU 淘汰 */
  retain(visible: Set<string>): void {
    const max = this.options.maxCountries ?? 8
    if (this.chunks.size <= max) {
      return
    }
    for (const iso of this.chunks.keys()) {
      if (this.chunks.size <= max) {
        return
      }
      if (!visible.has(iso)) {
        this.chunks.delete(iso)
        // 淘汰后可再次加载
        this.states.delete(iso)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.queue.length = 0
    this.chunks.clear()
    this.states.clear()
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const iso = this.queue.shift()
      if (!iso) {
        return
      }
      this.active += 1
      void this.load(iso)
    }
  }

  private async load(iso: string): Promise<void> {
    try {
      const local = this.hasLocal(iso) ? await this.loadLocal(iso) : null
      const chunk = local ?? (await this.loadRemote(iso))
      if (!chunk) {
        this.states.set(iso, 'missing')
        return
      }
      this.chunks.set(iso, chunk)
      this.states.set(iso, 'ready')
    } catch {
      this.states.set(iso, 'missing')
    } finally {
      this.active -= 1
      this.pump()
      if (!this.disposed) {
        this.options.onChange()
        this.logFailures(iso)
      }
    }
  }

  private logFailures(iso: string): void {
    if (this.states.get(iso) === 'missing' && this.options.onNotice) {
      this.options.onNotice(iso)
    }
  }

  private async loadLocal(iso: string): Promise<Admin2Chunk | null> {
    const url = `${this.options.baseUrl}geo/admin2/${iso}.geojson`
    let response: Response
    try {
      response = await fetch(url, { signal: withTimeout(20_000) })
    } catch {
      return null
    }
    if (!response.ok) {
      return null
    }
    // 静态托管常用 index.html 兜底不存在的路径，先挡掉这种「200 但不是 JSON」
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('html')) {
      return null
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return null
    }
    if (!isRawFeatureCollection(payload)) {
      return null
    }
    const features = normalizeWorldFeatures(payload, 'adm2')
    return makeChunk(iso, features, 'local', readLabel(payload))
  }

  private async loadRemote(iso: string): Promise<Admin2Chunk | null> {
    if (this.options.enableRemote === false) {
      return null
    }
    const payload = await fetchRemoteAdm2(iso)
    if (!payload) {
      return null
    }
    const features = normalizeWorldFeatures(payload, 'adm2')
    return makeChunk(iso, features, 'remote', readLabel(payload))
  }
}

/** 从分块文件里读取层级名称，例如 Department / Prefecture / 区县 */
function readLabel(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    const canonical = record.canonical
    if (typeof canonical === 'string') {
      const label = canonical.trim()
      // geoBoundaries 对不少国家只给 "Unknown"，这种就别显示了
      if (label.length > 0 && label.toLowerCase() !== 'unknown') {
        return label
      }
    }
    const level = record.level
    if (typeof level === 'string') {
      const suffix = level.trim().toUpperCase()
      if (suffix === 'ADM1') return '一级行政区'
      if (suffix === 'ADM2') return '二级行政区'
      if (suffix === 'ADM3') return '三级行政区'
    }
  }
  return '次级行政区'
}

/** 给分块补上 iso、展示代码与总包围盒，命中测试时可以先整块过滤 */
function makeChunk(
  iso: string,
  features: WorldMapFeature[],
  source: Admin2Chunk['source'],
  label: string,
): Admin2Chunk | null {
  if (features.length === 0) {
    return null
  }
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY

  for (const feature of features) {
    if (!feature.iso) {
      feature.iso = iso
    }
    // geoBoundaries 的哈希 id 对用户没意义，补一个「国家-层级」的展示代码；
    // 中国地级市的 adcode 是纯数字，保留原样。
    if (feature.level !== 'country' && feature.code === feature.id && !/^\d+$/.test(feature.id)) {
      feature.code = `${iso}-${feature.level.toUpperCase()}`
    }
    const { bounds } = feature
    if (bounds.minLng < minLng) minLng = bounds.minLng
    if (bounds.maxLng > maxLng) maxLng = bounds.maxLng
    if (bounds.minLat < minLat) minLat = bounds.minLat
    if (bounds.maxLat > maxLat) maxLat = bounds.maxLat
  }

  return {
    iso,
    features,
    bounds: { minLng, maxLng, minLat, maxLat },
    source,
    label,
  }
}
