#!/usr/bin/env node
/**
 * 生成 world-map 页面使用的地图数据。
 *
 * 输出（全部放在 public/geo/ 下，页面按需加载）：
 *   world.geojson          全球国界（Natural Earth 50m，公有领域）
 *   admin2/CHN.geojson     中国地级市（阿里云 DataV）
 *   admin2/HKG.geojson     香港各区（阿里云 DataV）
 *   admin2/MAC.geojson     澳门各区（阿里云 DataV）
 *   admin2/<ISO>.geojson   其他国家二级行政区（geoBoundaries ADM2，CC BY 4.0）
 *   admin2/index.json      次级行政区目录，运行时按国家懒加载
 *
 * 用法：
 *   node scripts/build-map-data.mjs --world --china          # 底图 + 中国市级（推荐先跑这个）
 *   node scripts/build-map-data.mjs --adm2=JPN,KOR,DEU       # 指定国家
 *   node scripts/build-map-data.mjs --adm2=all               # 全部国家（很慢，可中断重跑）
 *   node scripts/build-map-data.mjs --all                    # world + china + adm2=all
 *
 * 已经存在的文件默认跳过，加 --force 重新生成。所有下载失败的国家会被跳过，
 * index.json 只收录真正生成成功的国家，页面不会去请求不存在的文件。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const GEO_DIR = join(ROOT_DIR, 'public', 'geo')
const ADM2_DIR = join(GEO_DIR, 'admin2')
const WORLD_FILE = join(GEO_DIR, 'world.geojson')
const INDEX_FILE = join(ADM2_DIR, 'index.json')
const GRANULARITY_FILE = join(SCRIPT_DIR, 'map-granularity.json')

const USER_AGENT = 'aihistorysimulator-map-builder/1.0 (+https://github.com/)'
const FETCH_TIMEOUT = 180_000

/** 全球国界：Natural Earth 50m（公有领域），jsDelivr 在国内比 GitHub 直连稳 */
const WORLD_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson',
  'https://fastly.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson',
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
]

/** 阿里云 DataV 行政区划边界（免费、无需 key、带 CORS） */
const DATAV_BOUND = 'https://geo.datav.aliyun.com/areas_v3/bound'

/** geoBoundaries 元数据接口与下载镜像（原始地址太慢时套一层反代） */
const GEOBOUNDARIES_API = 'https://www.geoboundaries.org/api/current/gbOpen'
const GEOBOUNDARIES_PROXIES = [
  (url) => url,
  (url) => `https://ghfast.top/${url}`,
  (url) => `https://gh-proxy.com/${url}`,
]

/** DataV 里直接当“一个市级单元”处理的省级行政区：直辖市与港澳 */
const AS_SINGLE_UNIT = new Set(['110000', '120000', '310000', '500000'])
/** 独立成包的中国特别行政区 */
const SEPARATE_ISO = {
  810000: 'HKG',
  820000: 'MAC',
}
/** 台湾由全球底图（Natural Earth）表示，DataV 没有下级数据 */
const SKIP_PROVINCES = new Set(['710000'])

/** 简化容差（度）。0.003° 约 330 米，在地图最大缩放下不到 1 像素 */
const DEFAULT_TOLERANCE = 0.003
/** 坐标保留 4 位小数（约 11 米），进一步压缩体积 */
const DECIMALS = 4
/** 面积小于该值（平方度）的碎屑环直接丢弃，约 0.12 平方公里 */
const MIN_RING_AREA = 1e-8

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    world: false,
    china: false,
    chinaLevel: 'city',
    adm2: null,
    all: false,
    force: false,
    indexOnly: false,
    granularity: false,
    tolerance: DEFAULT_TOLERANCE,
    concurrency: 3,
    maxTotalMb: 200,
  }

  for (const arg of argv) {
    if (arg === '--all') options.all = true
    else if (arg === '--world') options.world = true
    else if (arg === '--china') options.china = true
    else if (arg === '--force') options.force = true
    else if (arg === '--index-only') options.indexOnly = true
    else if (arg === '--granularity') options.granularity = true
    else if (arg.startsWith('--china-level='))
      options.chinaLevel = arg.slice('--china-level='.length)
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length)
    else if (arg.startsWith('--adm2=')) options.adm2 = arg.slice('--adm2='.length)
    else if (arg.startsWith('--tolerance='))
      options.tolerance = Number(arg.slice('--tolerance='.length))
    else if (arg.startsWith('--concurrency='))
      options.concurrency = Number(arg.slice('--concurrency='.length))
    else if (arg.startsWith('--max-total-mb='))
      options.maxTotalMb = Number(arg.slice('--max-total-mb='.length))
    else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`未知参数：${arg}`)
      printUsage()
      process.exit(1)
    }
  }

  if (!Number.isFinite(options.tolerance) || options.tolerance <= 0) {
    options.tolerance = DEFAULT_TOLERANCE
  }
  options.concurrency = clamp(Math.trunc(options.concurrency) || 3, 1, 8)

  if (
    !options.world &&
    !options.china &&
    !options.adm2 &&
    !options.all &&
    !options.indexOnly &&
    !options.granularity
  ) {
    options.world = true
    options.china = true
  }
  if (options.all) {
    options.world = true
    options.china = true
    options.adm2 = 'all'
  }
  return options
}

function printUsage() {
  console.log(`用法：node scripts/build-map-data.mjs [选项]

  --world                生成 public/geo/world.geojson（Natural Earth 50m）
  --china                生成 public/geo/admin2/CHN.geojson 等（阿里云 DataV）
  --china-level=county   中国使用县级（区县）而不是地级市
  --adm2=all|JPN,KOR     生成指定国家的 geoBoundaries ADM2 分块
  --all                  等价于 --world --china --adm2=all
  --granularity          按 scripts/map-granularity.json 重建各国家的 ADM 层级
  --index-only           只扫描 admin2/ 目录重建 index.json
  --force                覆盖已存在的文件
  --tolerance=0.003      简化容差（度），越大文件越小、越粗糙
  --concurrency=3        并发下载数
  --max-total-mb=200     ADM2 总输出上限，超出后停止下载
不传参数时默认执行 --world --china。`)
}

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

async function fetchWithMirrors(url, mirrors) {
  const errors = []
  for (const candidate of mirrors) {
    try {
      const response = await fetch(candidate, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json,application/geo+json,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return await response.text()
    } catch (error) {
      errors.push(`${candidate} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { error: errors.join('；') }
}

/** 返回 { text } 或 { error }，不抛异常 */
async function fetchText(url, proxies = [(target) => target]) {
  const mirrors = proxies.map((wrap) => wrap(url))
  const result = await fetchWithMirrors(url, mirrors)
  return typeof result === 'string' ? { text: result } : { error: result.error }
}

async function fetchJson(url, proxies = [(target) => target]) {
  const result = await fetchText(url, proxies)
  if (!result.text) {
    return result
  }
  try {
    return { json: JSON.parse(result.text), text: result.text }
  } catch (error) {
    return {
      error: `${url} 返回的不是合法 JSON：${error instanceof Error ? error.message : error}`,
    }
  }
}

/* ------------------------------------------------------------------ */
/* 几何处理                                                            */
/* ------------------------------------------------------------------ */

/** 点到线段所在直线的距离（经纬度平面近似） */
function pointToSegment(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) {
    return Math.hypot(p[0] - a[0], p[1] - a[1])
  }
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Douglas-Peucker 简化，输入不闭合的折线 */
function simplifyLine(points, tolerance) {
  if (points.length <= 2) {
    return points.slice()
  }

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [start, end] = stack.pop()
    const a = points[start]
    const b = points[end]
    let farthest = -1
    let farthestIndex = -1

    for (let index = start + 1; index < end; index += 1) {
      const distance = pointToSegment(points[index], a, b)
      if (distance > farthest) {
        farthest = distance
        farthestIndex = index
      }
    }

    if (farthest > tolerance) {
      keep[farthestIndex] = 1
      stack.push([start, farthestIndex], [farthestIndex, end])
    }
  }

  return points.filter((_, index) => keep[index] === 1)
}

function isClosed(ring) {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return Boolean(first && last && first[0] === last[0] && first[1] === last[1])
}

/** 环面积（绝对值），用于剔除碎屑 */
function ringArea(ring) {
  let sum = 0
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    sum += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1]
  }
  return Math.abs(sum / 2)
}

/** 坐标量化 + 合并相邻重复点，返回 null 表示这个环没救了 */
function quantizeRing(ring) {
  const factor = 10 ** DECIMALS
  const result = []
  for (const point of ring) {
    const x = Math.round(point[0] * factor) / factor
    const y = Math.round(point[1] * factor) / factor
    const previous = result[result.length - 1]
    if (previous && previous[0] === x && previous[1] === y) {
      continue
    }
    result.push([x, y])
  }
  if (result.length >= 2) {
    const first = result[0]
    const last = result[result.length - 1]
    if (first[0] === last[0] && first[1] === last[1]) {
      result.pop()
    }
  }
  return result.length >= 3 ? result : null
}

/**
 * 简化一个环：闭合环先拆成开折线，简化后再闭合。
 * 简化后点数太少说明这块区域太小，返回 null 让调用方丢弃。
 */
function simplifyRing(ring, tolerance) {
  if (ring.length < 4) {
    return quantizeRing(ring)
  }
  const closed = isClosed(ring)
  const open = closed ? ring.slice(0, -1) : ring
  let simplified = simplifyLine(open, tolerance)
  if (simplified.length < 3) {
    simplified = open
  }
  const quantized = quantizeRing(simplified)
  return quantized
}

/** 处理 Polygon / MultiPolygon，返回多边形数组；不支持的几何类型返回 null */
function simplifyGeometry(geometry, tolerance) {
  if (!geometry || typeof geometry !== 'object') {
    return null
  }
  if (geometry.type === 'Polygon') {
    const polygon = simplifyPolygon(geometry.coordinates, tolerance)
    return polygon ? [polygon] : null
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = []
    for (const rawPolygon of geometry.coordinates ?? []) {
      const polygon = simplifyPolygon(rawPolygon, tolerance)
      if (polygon) {
        polygons.push(polygon)
      }
    }
    return polygons.length > 0 ? polygons : null
  }
  if (geometry.type === 'GeometryCollection') {
    const polygons = []
    for (const child of geometry.geometries ?? []) {
      const childPolygons = simplifyGeometry(child, tolerance)
      if (childPolygons) {
        polygons.push(...childPolygons)
      }
    }
    return polygons.length > 0 ? polygons : null
  }
  return null
}

function simplifyPolygon(rings, tolerance) {
  if (!Array.isArray(rings) || rings.length === 0) {
    return null
  }
  const processed = []
  rings.forEach((ring, index) => {
    if (!Array.isArray(ring) || ring.length < 3) {
      return
    }
    // 外环太小的整块丢掉；内环（洞）太小则忽略这个洞
    if (ringArea(ring) < MIN_RING_AREA) {
      return
    }
    const simplified = simplifyRing(ring, tolerance)
    if (!simplified) {
      return
    }
    // 内环简化后如果点数塌缩得太厉害就丢掉，避免画出错误的洞
    if (index > 0 && simplified.length < 4) {
      return
    }
    if (index === 0) {
      processed.push(simplified)
    } else if (processed.length > 0) {
      processed.push(simplified)
    }
  })
  return processed.length > 0 ? processed : null
}

/** 统计多边形顶点数，用于日志 */
function countVertices(polygons) {
  let total = 0
  for (const polygon of polygons) {
    for (const ring of polygon) {
      total += ring.length
    }
  }
  return total
}

/* ------------------------------------------------------------------ */
/* 面积与覆盖率校验                                                    */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371.0088

/** 球面多边形环的有向面积（km²） */
function ringAreaKm2(ring) {
  let sum = 0
  for (let index = 0; index < ring.length; index += 1) {
    const [lng1, lat1] = ring[index]
    const [lng2, lat2] = ring[(index + 1) % ring.length]
    const rad = Math.PI / 180
    sum += (lng2 - lng1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad))
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2)
}

function polygonsAreaKm2(polygons) {
  let total = 0
  for (const polygon of polygons) {
    let area = 0
    polygon.forEach((ring, index) => {
      area += (index === 0 ? 1 : -1) * ringAreaKm2(ring)
    })
    total += Math.abs(area)
  }
  return total
}

/** 读取 world.geojson，算出每个国家的面积，用来校验分块覆盖率 */
async function loadCountryAreas() {
  const areas = new Map()
  if (!existsSync(WORLD_FILE)) {
    return areas
  }
  const payload = JSON.parse(await readFile(WORLD_FILE, 'utf8'))
  for (const feature of payload.features ?? []) {
    const iso = String(feature.id ?? '')
    if (!/^[A-Z]{3}$/.test(iso)) continue
    const geometry = feature.geometry
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : []
    let area = 0
    for (const polygon of polygons) {
      let polygonArea = 0
      polygon.forEach((ring, index) => {
        polygonArea += (index === 0 ? 1 : -1) * ringAreaKm2(ring)
      })
      area += Math.abs(polygonArea)
    }
    areas.set(iso, area)
  }
  return areas
}

/** 把多个多边形折成一个 MultiPolygon（只有一个时用 Polygon） */
function toGeometry(polygons) {
  if (polygons.length === 1) {
    return { type: 'Polygon', coordinates: polygons[0] }
  }
  return { type: 'MultiPolygon', coordinates: polygons }
}

/* ------------------------------------------------------------------ */
/* 生成 FeatureCollection                                              */
/* ------------------------------------------------------------------ */

function makeFeature(id, properties, polygons) {
  return {
    type: 'Feature',
    id,
    properties,
    geometry: toGeometry(polygons),
  }
}

function collection(features, metadata) {
  return {
    type: 'FeatureCollection',
    ...metadata,
    features,
  }
}

async function writeCollection(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const text = JSON.stringify(value)
  await writeFile(file, text, 'utf8')
  return Buffer.byteLength(text, 'utf8')
}

/* ------------------------------------------------------------------ */
/* 世界底图                                                            */
/* ------------------------------------------------------------------ */

function pickIso(properties) {
  const iso = String(properties.ISO_A3 ?? '')
  if (/^[A-Z]{3}$/.test(iso)) {
    return iso
  }
  const fallback = String(properties.ADM0_A3 ?? '')
  return /^[A-Z]{3}$/.test(fallback) ? fallback : ''
}

function pickName(properties) {
  const zh = typeof properties.NAME_ZH === 'string' ? properties.NAME_ZH.trim() : ''
  const en = typeof properties.NAME_EN === 'string' ? properties.NAME_EN.trim() : ''
  const name = typeof properties.NAME === 'string' ? properties.NAME.trim() : ''
  return { name: zh || en || name, nameEn: en || name }
}

async function buildWorld(options) {
  if (!options.force && existsSync(WORLD_FILE)) {
    const info = await stat(WORLD_FILE)
    console.log(`= world.geojson 已存在（${(info.size / 1024 / 1024).toFixed(2)} MB），跳过`)
    return { skipped: true }
  }

  process.stdout.write('> 下载 Natural Earth 50m 国界 … ')
  let result = await fetchJson(WORLD_MIRRORS[0])
  if (!result.json) {
    // 第一个镜像失败时逐个重试，避免单点故障
    for (const mirror of WORLD_MIRRORS.slice(1)) {
      result = await fetchJson(mirror)
      if (result.json) {
        break
      }
    }
  }
  const worldPayload = result.json
  if (!worldPayload || !Array.isArray(worldPayload.features)) {
    console.log('失败')
    throw new Error(`无法获取 Natural Earth 国界数据：${result.error ?? '响应格式异常'}`)
  }
  console.log(`成功（${worldPayload.features.length} 个要素）`)

  const features = []
  let vertices = 0
  let dropped = 0

  for (const raw of worldPayload.features) {
    const properties = raw?.properties ?? {}
    const iso = pickIso(properties)
    if (!iso) {
      dropped += 1
      continue
    }
    const polygons = simplifyGeometry(raw.geometry, options.tolerance)
    if (!polygons) {
      dropped += 1
      continue
    }
    const { name, nameEn } = pickName(properties)
    vertices += countVertices(polygons)
    features.push(
      makeFeature(
        iso,
        {
          name,
          name_en: nameEn,
          iso,
        },
        polygons,
      ),
    )
  }

  const bytes = await writeCollection(
    WORLD_FILE,
    collection(features, {
      source: 'Natural Earth 50m admin_0 (public domain)',
      simplifiedTolerance: options.tolerance,
    }),
  )

  console.log(
    `  写入 world.geojson：${features.length} 个国家，${vertices.toLocaleString()} 个顶点，` +
      `${(bytes / 1024 / 1024).toFixed(2)} MB（丢弃 ${dropped} 个要素）`,
  )
  return { skipped: false, features: features.length, bytes }
}

/* ------------------------------------------------------------------ */
/* 中国市级（阿里云 DataV）                                            */
/* ------------------------------------------------------------------ */

async function fetchDatav(adcode) {
  const url = `${DATAV_BOUND}/${adcode}_full.json`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await fetchJson(url)
    if (result.json) {
      return result.json
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500 * (attempt + 1)))
  }
  return null
}

/** 取一个 DataV 要素的几何并简化 */
function datavPolygons(feature, tolerance) {
  return simplifyGeometry(feature?.geometry, tolerance)
}

async function buildChina(options) {
  const targets = [
    { country: 'CHN', label: '中国地级市' },
    { country: 'HKG', label: '香港各区' },
    { country: 'MAC', label: '澳门各区' },
  ].filter(({ country }) => options.force || !existsSync(join(ADM2_DIR, `${country}.geojson`)))

  if (targets.length === 0) {
    console.log('= 中国/香港/澳门数据已存在，跳过')
    return { skipped: true }
  }

  process.stdout.write('> 下载 DataV 全国省级边界 … ')
  const countryPayload = await fetchDatav('100000')
  if (!countryPayload || !Array.isArray(countryPayload.features)) {
    console.log('失败')
    throw new Error('无法获取 DataV 全国边界（100000_full.json）')
  }
  console.log(`成功（${countryPayload.features.length} 个省级要素）`)

  const provinces = countryPayload.features.filter((feature) => {
    const adcode = String(feature?.properties?.adcode ?? '')
    return /^\d{6}$/.test(adcode)
  })

  const byCountry = { CHN: [], HKG: [], MAC: [] }
  let vertices = 0

  for (const province of provinces) {
    const adcode = String(province.properties.adcode)
    if (SKIP_PROVINCES.has(adcode)) {
      continue
    }

    const provinceName = String(province.properties.name ?? adcode)

    // 独立成包的特别行政区：直接取下级
    const separateIso = SEPARATE_ISO[adcode]
    if (separateIso) {
      const payload = await fetchDatav(adcode)
      const children = (payload?.features ?? []).filter((feature) =>
        String(feature?.properties?.adcode ?? '').startsWith(adcode.slice(0, 2)),
      )
      if (children.length === 0) {
        continue
      }
      for (const child of children) {
        const polygons = datavPolygons(child, options.tolerance)
        if (!polygons) continue
        vertices += countVertices(polygons)
        byCountry[separateIso].push(
          makeFeature(
            String(child.properties.adcode),
            {
              name: String(child.properties.name ?? ''),
              parent: provinceName,
              level: 'district',
              source: 'datav',
            },
            polygons,
          ),
        )
      }
      continue
    }

    // 直辖市：整个市就是一个“市级单元”
    if (AS_SINGLE_UNIT.has(adcode)) {
      const polygons = datavPolygons(province, options.tolerance)
      if (!polygons) continue
      vertices += countVertices(polygons)
      byCountry.CHN.push(
        makeFeature(
          adcode,
          {
            name: provinceName,
            parent: '中国',
            level: 'municipality',
            source: 'datav',
          },
          polygons,
        ),
      )
      continue
    }

    // 普通省份：逐省拿地级市
    process.stdout.write(`  · ${provinceName} … `)
    const payload = await fetchDatav(adcode)
    const children = (payload?.features ?? []).filter((feature) => {
      const code = String(feature?.properties?.adcode ?? '')
      return code.startsWith(adcode.slice(0, 2)) && code !== adcode
    })
    if (children.length === 0) {
      console.log('无下级数据，跳过')
      continue
    }
    for (const child of children) {
      const polygons = datavPolygons(child, options.tolerance)
      if (!polygons) continue
      vertices += countVertices(polygons)
      byCountry.CHN.push(
        makeFeature(
          String(child.properties.adcode),
          {
            name: String(child.properties.name ?? ''),
            parent: provinceName,
            level: 'city',
            source: 'datav',
          },
          polygons,
        ),
      )
    }

    console.log(`${children.length} 个`)
  }

  console.log(`\n  中国地级市合计 ${byCountry.CHN.length} 个单元`)
  const results = []
  for (const { country, label } of targets) {
    const features = byCountry[country]
    if (!features || features.length === 0) {
      console.log(`  跳过 ${country}（${label}）：没有拿到数据`)
      continue
    }
    const bytes = await writeCollection(
      join(ADM2_DIR, `${country}.geojson`),
      collection(features, {
        country,
        level: 'adm2',
        source: '阿里云 DataV areas_v3',
        canonical: CANONICAL_OVERRIDES[country] ?? null,
      }),
    )
    results.push({ country, units: features.length, bytes })
    console.log(
      `  写入 ${country}.geojson：${features.length} 个单元，${(bytes / 1024).toFixed(0)} KB`,
    )
  }

  return { skipped: false, results, vertices }
}

/* ------------------------------------------------------------------ */
/* geoBoundaries ADM2                                                 */
/* ------------------------------------------------------------------ */

async function fetchAdm2Meta(iso, level = 2) {
  const result = await fetchJson(`${GEOBOUNDARIES_API}/${iso}/ADM${level}/`)
  if (result.json) {
    return result.json
  }
  return null
}

async function fetchAdm2Payload(meta) {
  const candidates = [meta.simplifiedGeometryGeoJSON, meta.gjDownloadURL].filter(
    (url) => typeof url === 'string' && url.length > 0,
  )
  for (const url of candidates) {
    const result = await fetchJson(url, GEOBOUNDARIES_PROXIES)
    if (result.json && Array.isArray(result.json.features)) {
      return result.json
    }
  }
  return null
}

function readAdm2Name(properties) {
  const candidates = [properties.shapeName, properties.name, properties.NAME, properties.shapeISO]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return ''
}

/** 少数地区 geoBoundaries 给的层级名不适合展示，这里覆盖一下 */
const CANONICAL_OVERRIDES = {
  CHN: '地级市',
  TWN: '县市',
  HKG: '区',
  MAC: '堂区',
}

async function buildOneAdm2(iso, options, level = 2) {
  const meta = await fetchAdm2Meta(iso, level)
  if (!meta) {
    return { iso, error: `ADM${level} 元数据请求失败` }
  }
  const payload = await fetchAdm2Payload(meta)
  if (!payload) {
    return { iso, error: `ADM${level} 边界文件下载失败` }
  }

  const features = []
  let vertices = 0
  let dropped = 0
  let areaKm2 = 0

  for (const [index, raw] of payload.features.entries()) {
    const polygons = simplifyGeometry(raw?.geometry, options.tolerance)
    if (!polygons) {
      dropped += 1
      continue
    }
    const properties = raw?.properties ?? {}
    const id = String(properties.shapeID ?? raw?.id ?? `${iso}-${index}`)
    const name = readAdm2Name(properties) || id
    vertices += countVertices(polygons)
    areaKm2 += polygonsAreaKm2(polygons)
    features.push(
      makeFeature(
        id,
        {
          name,
          code: String(properties.shapeISO ?? '').trim(),
          parent: String(properties.shapeGroup ?? iso),
          level: `adm${level}`,
          source: 'geoboundaries',
        },
        polygons,
      ),
    )
  }

  if (features.length === 0) {
    return { iso, error: '没有可绘制的多边形' }
  }

  // 有些国家的某级数据只覆盖局部（例如漏掉海外岛屿），覆盖率太低就不采用；
  // 反过来，面积明显超出国土说明有重叠或把海域算进来了，也不采用
  const countryArea = options.countryAreas?.get(iso) ?? 0
  const coverage = countryArea > 0 ? areaKm2 / countryArea : 1
  if (coverage < 0.8) {
    return {
      iso,
      error: `ADM${level} 只覆盖 ${(coverage * 100).toFixed(0)}% 国土，保留原层级`,
    }
  }
  if (coverage > 1.5 && countryArea > 5000) {
    return {
      iso,
      error: `ADM${level} 面积是国土的 ${(coverage * 100).toFixed(0)}%（可能有重叠），保留原层级`,
    }
  }

  const bytes = await writeCollection(
    join(ADM2_DIR, `${iso}.geojson`),
    collection(features, {
      country: iso,
      level: `adm${level}`,
      source: `geoBoundaries gbOpen ADM${level}`,
      license: meta.boundaryLicense,
      canonical: CANONICAL_OVERRIDES[iso] ?? meta.boundaryCanonical,
      year: meta.boundaryYearRepresented,
    }),
  )

  return {
    iso,
    level,
    units: features.length,
    vertices,
    bytes,
    dropped,
    canonical: meta.boundaryCanonical,
    coverage,
  }
}

/** geoBoundaries 接口不可用时的兜底国家列表（都是小体量国家，下载快） */
const FALLBACK_ISO_LIST = [
  'LUX',
  'SGP',
  'MLT',
  'BHS',
  'BRB',
  'BLZ',
  'DJI',
  'GMB',
  'GNB',
  'KWT',
  'QAT',
  'BHR',
  'TTO',
  'CYP',
]

async function resolveAdm2List(spec) {
  if (spec !== 'all') {
    return spec
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter((value) => /^[A-Z]{3}$/.test(value))
  }

  process.stdout.write('> 获取 geoBoundaries 国家列表 … ')
  const result = await fetchJson(`${GEOBOUNDARIES_API}/ALL/ADM2/`)
  const list = Array.isArray(result.json) ? result.json : result.json?.boundaries
  if (!Array.isArray(list)) {
    console.log('失败，退回内置国家列表')
    return FALLBACK_ISO_LIST
  }
  const codes = [...new Set(list.map((item) => String(item.boundaryISO ?? '').toUpperCase()))]
    .filter((value) => /^[A-Z]{3}$/.test(value))
    .sort()
  console.log(`成功（${codes.length} 个国家）`)
  return codes
}

async function buildAdm2List(options, isos) {
  const pending = isos.filter(
    ({ iso }) => options.force || !existsSync(join(ADM2_DIR, `${iso}.geojson`)),
  )
  if (pending.length === 0) {
    console.log('= 所有 ADM2 分块都已存在，跳过')
    return { skipped: true }
  }

  console.log(`> 生成 ${pending.length} 个国家的 ADM2 分块（并发 ${options.concurrency}）`)

  const successes = []
  const failures = []
  let totalBytes = 0
  let cursor = 0
  let stopped = false

  async function worker() {
    while (!stopped) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) {
        return
      }
      const { iso } = pending[index]
      const startedAt = Date.now()
      process.stdout.write(`  · ${iso} … `)
      try {
        const result = await buildOneAdm2(iso, options)
        if (result.error) {
          failures.push({ iso, error: result.error })
          console.log(`失败：${result.error}`)
          continue
        }
        totalBytes += result.bytes
        successes.push(result)
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(0)
        console.log(`${result.units} 个单元，${(result.bytes / 1024).toFixed(0)} KB，${seconds}s`)
        if (totalBytes > options.maxTotalMb * 1024 * 1024) {
          stopped = true
          console.log(`  ! 已达到 --max-total-mb=${options.maxTotalMb} 上限，停止后续下载`)
        }
      } catch (error) {
        failures.push({ iso, error: error instanceof Error ? error.message : String(error) })
        console.log(`异常：${error instanceof Error ? error.message : error}`)
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()))

  if (failures.length > 0) {
    console.log(`\n  ${failures.length} 个国家失败（可重跑脚本续传）：`)
    for (const failure of failures.slice(0, 20)) {
      console.log(`    ${failure.iso}：${failure.error}`)
    }
  }
  return { skipped: false, successes, failures, totalBytes }
}

/* ------------------------------------------------------------------ */
/* 统一粒度：按规划表重建                                              */
/* ------------------------------------------------------------------ */

/** 读取现有索引里的层级，用来跳过已经重建过的国家 */
async function readIndexLevels() {
  try {
    const payload = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
    const levels = {}
    for (const [iso, item] of Object.entries(payload.countries ?? {})) {
      levels[iso] = item?.level ?? 'adm2'
    }
    return levels
  } catch {
    return {}
  }
}

/** 中国县级（区县）：直辖市用市辖区，普通省份逐级下钻到区县 */
async function buildChinaCounty(options) {
  const countryAreas = options.countryAreas ?? (await loadCountryAreas())
  const tolerance = options.chinaTolerance ?? 0.004

  process.stdout.write('> 下载 DataV 全国省级边界 … ')
  const countryPayload = await fetchDatav('100000')
  if (!countryPayload || !Array.isArray(countryPayload.features)) {
    console.log('失败')
    throw new Error('无法获取 DataV 全国边界（100000_full.json）')
  }
  const provinces = countryPayload.features.filter((feature) =>
    /^\d{6}$/.test(String(feature?.properties?.adcode ?? '')),
  )
  console.log(`成功（${provinces.length} 个省级要素）`)

  const features = []
  let vertices = 0
  let areaKm2 = 0
  let cities = 0

  const pushUnit = (source, code, name, parent) => {
    const polygons = datavPolygons(source, tolerance)
    if (!polygons) return
    vertices += countVertices(polygons)
    areaKm2 += polygonsAreaKm2(polygons)
    features.push(makeFeature(code, { name, parent, level: 'adm3', source: 'datav' }, polygons))
  }

  for (const province of provinces) {
    const adcode = String(province.properties.adcode)
    // 台湾没有下级数据；港澳单独成包，不能混进 CHN，否则会和 HKG/MAC 重复绘制
    if (SKIP_PROVINCES.has(adcode) || SEPARATE_ISO[adcode]) {
      continue
    }
    const provinceName = String(province.properties.name ?? adcode)

    // 直辖市：下一级就是区县
    if (AS_SINGLE_UNIT.has(adcode)) {
      const payload = await fetchDatav(adcode)
      for (const child of payload?.features ?? []) {
        const code = String(child?.properties?.adcode ?? '')
        if (!code.startsWith(adcode.slice(0, 2)) || code === adcode) continue
        pushUnit(child, code, String(child.properties.name ?? ''), provinceName)
      }
      continue
    }

    process.stdout.write(`  · ${provinceName} … `)
    const cityPayload = await fetchDatav(adcode)
    const provinceCities = (cityPayload?.features ?? []).filter((feature) => {
      const code = String(feature?.properties?.adcode ?? '')
      return code.startsWith(adcode.slice(0, 2)) && code !== adcode
    })

    let count = 0
    for (const city of provinceCities) {
      const cityCode = String(city.properties.adcode)
      const cityName = String(city.properties.name ?? cityCode)
      const countyPayload = await fetchDatav(cityCode)
      const counties = (countyPayload?.features ?? []).filter((feature) => {
        const code = String(feature?.properties?.adcode ?? '')
        return code.startsWith(cityCode.slice(0, 4)) && code !== cityCode
      })

      if (counties.length === 0) {
        // 省直辖县级市之类没有下级，城市本身就是一个县
        pushUnit(city, cityCode, cityName, provinceName)
        count += 1
      } else {
        for (const county of counties) {
          const code = String(county.properties.adcode)
          pushUnit(county, code, String(county.properties.name ?? ''), cityName)
          count += 1
        }
      }
      cities += 1
    }
    console.log(`${count} 个区县`)
  }

  if (features.length === 0) {
    throw new Error('中国县级数据为空')
  }

  const countryArea = countryAreas.get('CHN') ?? 0
  const coverage = countryArea > 0 ? areaKm2 / countryArea : 1

  const bytes = await writeCollection(
    join(ADM2_DIR, 'CHN.geojson'),
    collection(features, {
      country: 'CHN',
      level: 'adm3',
      source: '阿里云 DataV areas_v3',
      canonical: '区县',
      tolerance,
    }),
  )

  console.log(
    `  写入 CHN.geojson：${features.length} 个县级单元（来自 ${cities} 个地级市），` +
      `${(bytes / 1024 / 1024).toFixed(2)} MB，覆盖率 ${(coverage * 100).toFixed(0)}%`,
  )

  return { iso: 'CHN', level: 3, units: features.length, bytes, coverage, vertices }
}

/** 港澳：城市级特别行政区，区/堂区单独成包 */
async function buildSeparateRegions(options) {
  const targets = [
    { iso: 'HKG', adcode: '810000', name: '香港特别行政区' },
    { iso: 'MAC', adcode: '820000', name: '澳门特别行政区' },
  ]

  for (const { iso, adcode, name: regionName } of targets) {
    const payload = await fetchDatav(adcode)
    if (!payload || !Array.isArray(payload.features)) {
      console.log(`  跳过 ${iso}：无法获取 DataV ${adcode}`)
      continue
    }
    const features = []
    let vertices = 0

    for (const child of payload.features) {
      const code = String(child?.properties?.adcode ?? '')
      if (!code.startsWith(adcode.slice(0, 2)) || code === adcode) {
        continue
      }
      const polygons = datavPolygons(child, options.tolerance)
      if (!polygons) continue
      vertices += countVertices(polygons)
      features.push(
        makeFeature(
          code,
          {
            name: String(child.properties.name ?? ''),
            code,
            parent: regionName,
            level: 'adm2',
            source: 'datav',
          },
          polygons,
        ),
      )
    }

    if (features.length === 0) {
      console.log(`  跳过 ${iso}：没有下级数据`)
      continue
    }

    const bytes = await writeCollection(
      join(ADM2_DIR, `${iso}.geojson`),
      collection(features, {
        country: iso,
        level: 'adm2',
        source: '阿里云 DataV areas_v3',
        canonical: CANONICAL_OVERRIDES[iso] ?? null,
      }),
    )
    console.log(
      `  写入 ${iso}.geojson：${features.length} 个单元，${vertices} 个顶点，${(bytes / 1024).toFixed(0)} KB`,
    )
  }
}

/** 统一粒度模式下把中国重建为地级市（约 367 个单元） */
async function buildChinaCityForGranularity(options) {
  const result = await buildChina({ ...options, force: true })
  const china = result.results?.find((item) => item.country === 'CHN')
  if (!china) {
    return { iso: 'CHN', error: '没有生成 CHN 数据' }
  }
  return { iso: 'CHN', level: 2, units: china.units, bytes: china.bytes, coverage: 1 }
}

async function buildGranularity(options) {
  if (!existsSync(GRANULARITY_FILE)) {
    throw new Error(
      `找不到 ${GRANULARITY_FILE}，先执行 node scripts/plan-granularity.mjs 生成规划表`,
    )
  }
  const plan = JSON.parse(await readFile(GRANULARITY_FILE, 'utf8'))
  const countryAreas = await loadCountryAreas()
  const currentLevels = await readIndexLevels()

  const pending = Object.entries(plan.countries ?? {}).filter(([iso, item]) => {
    if (options.only) {
      const only = new Set(options.only.split(',').map((value) => value.trim().toUpperCase()))
      if (!only.has(iso)) return false
    }
    if (iso === 'CHN') {
      return options.force || currentLevels.CHN !== `adm${item?.level ?? 3}`
    }
    if (!item || !item.level) {
      return false
    }
    return options.force || currentLevels[iso] !== `adm${item.level}`
  })

  if (pending.length === 0) {
    console.log('= 所有国家都已经在规划表指定的层级上，跳过')
    return { skipped: true }
  }

  console.log(
    `> 按统一粒度重建 ${pending.length} 个国家（基准 ${plan.targetAreaKm2} km²/单元，并发 ${options.concurrency}）`,
  )

  const successes = []
  const failures = []
  let cursor = 0

  async function worker() {
    while (cursor < pending.length) {
      const index = cursor
      cursor += 1
      const [iso, item] = pending[index]
      const startedAt = Date.now()
      process.stdout.write(`  · ${iso} ADM${item.level} … `)
      try {
        const result =
          iso === 'CHN'
            ? item.level === 3
              ? await buildChinaCounty({ ...options, countryAreas })
              : await buildChinaCityForGranularity(options)
            : await buildOneAdm2(iso, { ...options, countryAreas }, item.level)
        if (result.error) {
          failures.push({ iso, error: result.error })
          console.log(`失败：${result.error}`)
          continue
        }
        successes.push(result)
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(0)
        console.log(
          `${result.units} 个单元，${(result.bytes / 1024).toFixed(0)} KB，` +
            `覆盖率 ${(result.coverage * 100).toFixed(0)}%，${seconds}s`,
        )
      } catch (error) {
        failures.push({ iso, error: error instanceof Error ? error.message : String(error) })
        console.log(`异常：${error instanceof Error ? error.message : error}`)
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()))

  if (failures.length > 0) {
    console.log(`\n  ${failures.length} 个国家失败（保留原层级，可重跑）：`)
    for (const failure of failures) {
      console.log(`    ${failure.iso}：${failure.error}`)
    }
  }

  console.log(`\n  成功 ${successes.length} 个，失败 ${failures.length} 个`)
  return { skipped: false, successes, failures }
}

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

async function listAdm2Files() {
  if (!existsSync(ADM2_DIR)) {
    return []
  }
  const entries = await readdir(ADM2_DIR)
  return entries.filter((entry) => entry.endsWith('.geojson'))
}

async function writeIndex() {
  const files = await listAdm2Files()
  const countries = {}

  for (const file of files.sort()) {
    const iso = file.replace(/\.geojson$/, '')
    if (!/^[A-Z]{3}$/.test(iso)) {
      continue
    }
    try {
      const text = await readFile(join(ADM2_DIR, file), 'utf8')
      const payload = JSON.parse(text)
      const features = Array.isArray(payload.features) ? payload.features : []
      if (features.length === 0) {
        continue
      }
      let minLng = Number.POSITIVE_INFINITY
      let maxLng = Number.NEGATIVE_INFINITY
      let minLat = Number.POSITIVE_INFINITY
      let maxLat = Number.NEGATIVE_INFINITY
      for (const feature of features) {
        const polygons =
          feature?.geometry?.type === 'Polygon'
            ? [feature.geometry.coordinates]
            : (feature?.geometry?.coordinates ?? [])
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
      }
      countries[iso] = {
        units: features.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        source: payload.source ?? 'unknown',
        level: payload.level ?? 'adm2',
        canonical: payload.canonical ?? null,
        bounds: Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null,
      }
    } catch {
      // 损坏的文件不收录，运行时会退回远端
    }
  }

  const index = {
    type: 'Adm2Index',
    generatedAt: new Date().toISOString(),
    tolerance: DEFAULT_TOLERANCE,
    attribution: {
      world: 'Natural Earth 50m admin_0 countries（公有领域）',
      china: '阿里云 DataV areas_v3 行政区划边界',
      adm2: 'geoBoundaries gbOpen ADM2（CC BY 4.0，需署名）',
    },
    countries,
  }

  await mkdir(ADM2_DIR, { recursive: true })
  await writeFile(INDEX_FILE, JSON.stringify(index), 'utf8')

  const totalUnits = Object.values(countries).reduce((sum, item) => sum + item.units, 0)
  const totalBytes = Object.values(countries).reduce((sum, item) => sum + item.bytes, 0)
  console.log(
    `\n= 索引 ${INDEX_FILE.replace(ROOT_DIR + '\\', '')}：${Object.keys(countries).length} 个国家，` +
      `${totalUnits.toLocaleString()} 个次级单元，${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
  )
  return countries
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()

  await mkdir(ADM2_DIR, { recursive: true })

  console.log(`容差 ${options.tolerance}°（约 ${(options.tolerance * 111_000).toFixed(0)} 米）\n`)

  if (options.indexOnly) {
    await writeIndex()
    console.log(`\n完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    return
  }

  if (options.world) {
    await buildWorld(options)
  }
  if (options.china) {
    if (options.chinaLevel === 'county') {
      await buildChinaCounty(options)
      await buildSeparateRegions(options)
    } else {
      await buildChina(options)
    }
  }
  if (options.adm2) {
    const isos = await resolveAdm2List(options.adm2)
    const countryAreas = await loadCountryAreas()
    await buildAdm2List(
      { ...options, countryAreas },
      isos.map((iso) => ({ iso })),
    )
  }
  if (options.granularity) {
    await buildGranularity(options)
  }

  await writeIndex()

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n完成，用时 ${seconds}s。数据目录：${GEO_DIR.replace(ROOT_DIR + '\\', '')}`)
}

main().catch((error) => {
  console.error(`\n构建失败：${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
