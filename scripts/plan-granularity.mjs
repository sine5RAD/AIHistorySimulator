#!/usr/bin/env node
/**
 * 生成「每个国家用哪一级行政区」的规划表。
 *
 * geoBoundaries 的 ADM2 在不同国家含义差异极大：荷兰是市镇（120 km²），
 * 德国是行政专区（9,380 km²），加拿大是普查区（129,000 km²）。
 * 为了让地图上的细分密度大致统一，这里以德国/法国的平均单元面积为基准，
 * 为每个国家挑选平均单元面积最接近基准的 ADM 层级（ADM1/2/3/4）。
 *
 * 输出 scripts/map-granularity.json，供 build-map-data.mjs 使用：
 *   node scripts/build-map-data.mjs --granularity
 *
 * 用法：
 *   node scripts/plan-granularity.mjs [--target=7300] [--band=1.8] [--concurrency=5]
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const ADM2_DIR = join(ROOT_DIR, 'public', 'geo', 'admin2')
const OUTPUT = join(SCRIPT_DIR, 'map-granularity.json')
/** 手动指定层级的覆盖表：{"CHN": 2, "RUS": 1}，优先级高于自动规划 */
const PINS_FILE = join(SCRIPT_DIR, 'map-granularity-pins.json')
const CACHE_DIR = join(SCRIPT_DIR, '.cache')
const CACHE_FILE = join(CACHE_DIR, 'granularity-meta.json')

const API = 'https://www.geoboundaries.org/api/current/gbOpen'
const USER_AGENT = 'aihistorysimulator-granularity-planner/1.0'
const LEVELS = [1, 2, 3, 4]

/**
 * 基准：约等于中国地级市的平均面积（9.5M km² / 367 个地级市 ≈ 26,000 km²），
 * 也就是「一个省切成几块」的密度。德国会落到 16 州、法国落到 13 大区。
 */
const DEFAULT_TARGET = 26000
const DEFAULT_BAND = 1.8
/** 候选窗口：细的一侧放宽一些（顺应「更精细」的诉求），粗的一侧收紧，避免跳到过粗的层级 */
const DEFAULT_WINDOW_LOW = 5
const DEFAULT_WINDOW_HIGH = 4.2
/** 小于该面积（km²）的国家直接用最粗一级，不再按面积匹配 */
const DEFAULT_SMALL_AREA = 100_000

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    band: DEFAULT_BAND,
    windowLow: DEFAULT_WINDOW_LOW,
    windowHigh: DEFAULT_WINDOW_HIGH,
    smallAreaKm2: DEFAULT_SMALL_AREA,
    maxDensityRatio: 2,
    concurrency: 5,
  }
  for (const arg of argv) {
    if (arg.startsWith('--target=')) options.target = Number(arg.slice(9))
    else if (arg.startsWith('--band=')) options.band = Number(arg.slice(7))
    else if (arg.startsWith('--window-low=')) options.windowLow = Number(arg.slice(13))
    else if (arg.startsWith('--window-high=')) options.windowHigh = Number(arg.slice(14))
    else if (arg.startsWith('--small-area=')) options.smallAreaKm2 = Number(arg.slice(13))
    else if (arg.startsWith('--max-density=')) options.maxDensityRatio = Number(arg.slice(14))
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice(14))
  }
  if (!Number.isFinite(options.target) || options.target <= 0) options.target = DEFAULT_TARGET
  if (!Number.isFinite(options.band) || options.band <= 1) options.band = DEFAULT_BAND
  if (!Number.isFinite(options.windowLow) || options.windowLow <= 1) {
    options.windowLow = DEFAULT_WINDOW_LOW
  }
  if (!Number.isFinite(options.windowHigh) || options.windowHigh <= 1) {
    options.windowHigh = DEFAULT_WINDOW_HIGH
  }
  if (!Number.isFinite(options.smallAreaKm2) || options.smallAreaKm2 <= 0) {
    options.smallAreaKm2 = DEFAULT_SMALL_AREA
  }
  if (!Number.isFinite(options.maxDensityRatio) || options.maxDensityRatio <= 1) {
    options.maxDensityRatio = 2
  }
  options.concurrency = clamp(Math.trunc(options.concurrency) || 5, 1, 8)
  return options
}

/* ------------------------------------------------------------------ */
/* 读取本地 ADM2 的平均单元面积                                        */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371.0088

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

function geometryAreaKm2(geometry) {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.reduce(
      (sum, ring, index) => sum + (index === 0 ? 1 : -1) * ringAreaKm2(ring),
      0,
    )
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (sum, polygon) => sum + geometryAreaKm2({ type: 'Polygon', coordinates: polygon }),
      0,
    )
  }
  return 0
}

async function readLocalStats() {
  const files = (await readdir(ADM2_DIR)).filter((file) => /^[A-Z]{3}\.geojson$/.test(file))
  const stats = new Map()
  for (const file of files) {
    const iso = file.slice(0, 3)
    const payload = JSON.parse(await readFile(join(ADM2_DIR, file), 'utf8'))
    if (!Array.isArray(payload.features) || payload.features.length === 0) continue
    let area = 0
    for (const feature of payload.features) area += geometryAreaKm2(feature.geometry)
    const units = payload.features.length
    stats.set(iso, {
      units,
      areaKm2: Math.round(area),
      meanAreaKm2: Math.round(area / units),
      canonical: payload.canonical ?? null,
      source: payload.source ?? 'unknown',
      level: payload.level ?? 'adm2',
      partialCoverage: payload.partialCoverage === true,
    })
  }
  return stats
}

/* ------------------------------------------------------------------ */
/* geoBoundaries 元数据                                                */
/* ------------------------------------------------------------------ */

async function fetchMeta(iso, level) {
  const url = `${API}/${iso}/ADM${level}/`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const units = Number(json.admUnitCount)
      const mean = Number(json.meanAreaSqKM)
      if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(mean) || mean <= 0) {
        return null
      }
      return {
        units,
        meanAreaKm2: mean,
        canonical: json.boundaryCanonical ?? null,
        license: json.boundaryLicense ?? null,
        year: json.boundaryYearRepresented ?? null,
      }
    } catch {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 400 * (attempt + 1)))
    }
  }
  return null
}

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function saveCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8')
}

/* ------------------------------------------------------------------ */
/* 选级                                                                */
/* ------------------------------------------------------------------ */

/**
 * 选级策略：
 * 1. 只看平均单元面积落在目标窗口 [target/window, target*window] 内的层级；
 * 2. 当前 ADM2 已经在窗口内、且不比最优层级差太多 → 不动（避免无意义的重建）；
 * 3. 否则选窗口内最接近目标的层级；窗口内没有候选时保持现状并标记 outOfBand。
 *
 * 这样既能把荷兰（121 km²）、卢森堡（25 km²）这类过碎的层级换成省级，
 * 也不会让墨西哥（800 km²）为了接近目标而跳到 60,938 km² 的州。
 */
function pickLevel(iso, local, meta, options) {
  const candidates = []
  for (const level of LEVELS) {
    const item = meta[iso]?.[level]
    if (item) {
      candidates.push({
        level,
        ...item,
        deviation: Math.abs(Math.log(item.meanAreaKm2 / options.target)),
      })
    }
  }
  if (candidates.length === 0) {
    return { level: null, reason: '没有可用的行政区数据' }
  }

  const current = candidates.find((candidate) => candidate.level === 2) ?? null

  // 微型国家/地区：整个国家还没目标单元大时，再细分就是碎屑（牙买加 827 个社区、
  // 圣卢西亚 547 个社区），直接用明显更粗、且至少有 4 个单元的层级，哪怕它仍然偏细。
  const coarsest = candidates
    .filter(
      (candidate) =>
        candidate.level === 1 &&
        candidate.units >= 4 &&
        (!current || candidate.meanAreaKm2 > current.meanAreaKm2 * 1.5),
    )
    .sort((a, b) => b.meanAreaKm2 - a.meanAreaKm2)[0]
  if (current && current.meanAreaKm2 < options.target / 20 && coarsest) {
    return { choice: coarsest, inBand: false }
  }

  // 面积不大的国家不必拆太细：只要存在 ADM1，就直接用最粗的一级
  if (local?.areaKm2 && local.areaKm2 < options.smallAreaKm2) {
    const areaCoarsest = candidates
      .filter(
        (candidate) =>
          candidate.level === 1 &&
          candidate.units >= 2 &&
          (!current || candidate.meanAreaKm2 > current.meanAreaKm2 * 1.2),
      )
      .sort((a, b) => a.meanAreaKm2 - b.meanAreaKm2)[0]
    if (areaCoarsest) {
      return { choice: areaCoarsest, inBand: false }
    }
  }

  // 密度上限：任何国家都不允许出现比基准密 N 倍以上的层级。
  // 例如巴西只有 27 个州（315,695 km²）和 5,570 个市镇（1,526 km²）两档，
  // 后者比基准密 17 倍，直接排除，最终落到 27 个州。
  const maxDensity = options.target / options.maxDensityRatio
  const allowed = candidates.filter((candidate) => candidate.meanAreaKm2 >= maxDensity)
  const pool = allowed.length > 0 ? allowed : candidates
  pool.sort((a, b) => a.deviation - b.deviation || a.level - b.level)
  const best = pool[0]

  // 当前层级本来就接近最优时保持不动，避免来回重建
  if (current && pool.includes(current) && current.deviation <= best.deviation * 1.15) {
    return { choice: current, inBand: current.deviation <= Math.log(options.windowHigh) }
  }

  return { choice: best, inBand: best.deviation <= Math.log(options.windowHigh) }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const stats = await readLocalStats()
  const cache = await loadCache()

  console.log(
    `基准 ${options.target} km²/单元，候选窗口 ${(options.target / options.windowLow).toFixed(0)} ~ ` +
      `${(options.target * options.windowHigh).toFixed(0)} km²`,
  )
  console.log(`本地已有 ${stats.size} 个国家的 ADM2 数据\n`)

  const isos = [...stats.keys()].sort()
  const result = {
    targetAreaKm2: options.target,
    band: options.band,
    windowLow: options.windowLow,
    windowHigh: options.windowHigh,
    smallAreaKm2: options.smallAreaKm2,
    generatedAt: new Date().toISOString(),
    source: 'geoBoundaries gbOpen + 阿里云 DataV，按平均单元面积统一粒度',
    countries: {},
  }

  let cursor = 0
  let fetched = 0

  async function worker() {
    while (cursor < isos.length) {
      const index = cursor
      cursor += 1
      const iso = isos[index]
      const local = stats.get(iso)

      // 自定义数据源（例如美国 CBSA）：层级由数据源决定，不参与自动规划
      if (local?.partialCoverage) {
        result.countries[iso] = {
          level: Number(String(local.level).replace('adm', '')) || 2,
          units: local.units,
          meanAreaKm2: local.meanAreaKm2,
          canonical: local.canonical,
          source: local.source,
          note: '自定义数据源，保持现状',
          custom: true,
        }
        continue
      }

      // 中国来自 DataV，单独处理：县级（区县）平均约 3,400 km²，最接近目标
      if (iso === 'CHN') {
        result.countries.CHN = {
          level: 3,
          units: null,
          meanAreaKm2: null,
          canonical: '县级',
          source: 'datav',
          note: 'DataV 县级（区县），构建后约 2,800 个单元',
        }
        continue
      }
      // 港澳是城市级特别行政区，区级划分就是最合适的粒度
      if (iso === 'HKG' || iso === 'MAC') {
        result.countries[iso] = {
          level: 2,
          meanAreaKm2: local.meanAreaKm2,
          units: local.units,
          canonical: local.canonical,
          source: local.source,
          note: '城市级特别行政区，保持区级划分',
        }
        continue
      }

      const meta = (cache[iso] ??= {})
      for (const level of LEVELS) {
        if (level in meta) continue
        meta[level] = await fetchMeta(iso, level)
        fetched += 1
      }

      const picked = pickLevel(iso, local, cache, options)
      if (!picked.choice) {
        result.countries[iso] = {
          level: 2,
          meanAreaKm2: local.meanAreaKm2,
          units: local.units,
          canonical: local.canonical,
          source: 'geoboundaries',
          note: picked.reason,
        }
        continue
      }

      const choice = picked.choice
      result.countries[iso] = {
        level: choice.level,
        units: choice.units,
        meanAreaKm2: Math.round(choice.meanAreaKm2),
        canonical: choice.canonical,
        inBand: Boolean(picked.inBand),
        note: choice.level === 2 ? '保持 ADM2' : `切换到 ADM${choice.level}`,
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()))

  // 手动指定层级优先于自动规划（例如把俄罗斯粗化成联邦主体）
  let pins = {}
  try {
    pins = JSON.parse(await readFile(PINS_FILE, 'utf8'))
  } catch {
    pins = {}
  }
  let pinnedCount = 0
  for (const [iso, level] of Object.entries(pins)) {
    const numeric = Number(level)
    if (!result.countries[iso] || !Number.isFinite(numeric)) {
      continue
    }
    const meta = cache[iso]?.[numeric]
    result.countries[iso] = {
      ...result.countries[iso],
      level: numeric,
      pinned: true,
      note: `手动指定 ADM${numeric}`,
      ...(iso === 'CHN'
        ? {
            units: null,
            meanAreaKm2: null,
            canonical: numeric === 2 ? '地级市' : '区县',
          }
        : meta
          ? {
              units: meta.units,
              meanAreaKm2: Math.round(meta.meanAreaKm2),
              canonical: meta.canonical,
              inBand: false,
            }
          : {}),
    }
    pinnedCount += 1
  }

  await saveCache(cache)
  await writeFile(OUTPUT, JSON.stringify(result, null, 2), 'utf8')

  /* 汇总 */
  const rows = Object.entries(result.countries).map(([iso, item]) => ({
    iso,
    ...item,
    localMean: stats.get(iso)?.meanAreaKm2 ?? 0,
  }))
  rows.sort((a, b) => (a.meanAreaKm2 ?? 0) / options.target - (b.meanAreaKm2 ?? 0) / options.target)

  const switches = rows.filter((row) => row.level !== 2)
  const outOfBand = rows.filter((row) => row.meanAreaKm2 && !row.inBand)
  console.log(`新增元数据请求 ${fetched} 次`)
  console.log(
    `共 ${rows.length} 个国家：保持 ADM2 ${rows.length - switches.length} 个，改层级 ${switches.length} 个` +
      (pinnedCount > 0 ? `（其中手动指定 ${pinnedCount} 个）` : ''),
  )
  console.log(`仍有 ${outOfBand.length} 个国家无法落进目标带（可选层级跨度太大）\n`)

  console.log('改层级的国家：')
  for (const row of switches) {
    if (row.meanAreaKm2 == null) {
      console.log(
        `  ${row.iso}  ADM2 ${String(row.localMean).padStart(6)} → ADM${row.level}（${row.note}）`,
      )
      continue
    }
    console.log(
      `  ${row.iso}  ADM2 ${String(row.localMean).padStart(6)} → ADM${row.level} ` +
        `${String(row.meanAreaKm2).padStart(6)} km²（${row.units} 个单元，${row.canonical ?? '未知层级'}）` +
        (row.pinned ? ' [手动]' : ''),
    )
  }

  console.log('\n仍偏离目标带的国家（前 25 个）：')
  for (const row of outOfBand.slice(0, 25)) {
    console.log(
      `  ${row.iso}  ${String(row.meanAreaKm2).padStart(7)} km²  ADM${row.level}  ` +
        `目标 ${options.target}（${(row.meanAreaKm2 / options.target).toFixed(1)}×）`,
    )
  }

  console.log(`\n已写入 ${OUTPUT.replace(ROOT_DIR + '\\', '')}`)
}

main().catch((error) => {
  console.error(`规划失败：${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
