#!/usr/bin/env node
/**
 * 地图数据体检：检查分块是否完整、层级是否与规划一致、覆盖率与单元面积是否合理。
 *   node scripts/audit-map-data.mjs
 * 有问题时以非零码退出。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const GEO_DIR = join(ROOT_DIR, 'public', 'geo')
const ADM2_DIR = join(GEO_DIR, 'admin2')
const PLAN_FILE = join(SCRIPT_DIR, 'map-granularity.json')

const R = 6371.0088
const LEVELS = { 1: 'adm1', 2: 'adm2', 3: 'adm3' }

function ringArea(ring) {
  let sum = 0
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index]
    const [x2, y2] = ring[(index + 1) % ring.length]
    const rad = Math.PI / 180
    sum += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad))
  }
  return Math.abs((sum * R * R) / 2)
}

function geometryArea(geometry) {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.reduce(
      (sum, ring, index) => sum + (index === 0 ? 1 : -1) * ringArea(ring),
      0,
    )
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (sum, polygon) => sum + geometryArea({ type: 'Polygon', coordinates: polygon }),
      0,
    )
  }
  return 0
}

async function loadWorldAreas() {
  const payload = JSON.parse(await readFile(join(GEO_DIR, 'world.geojson'), 'utf8'))
  const areas = new Map()
  for (const feature of payload.features) {
    areas.set(feature.id, Math.abs(geometryArea(feature.geometry)))
  }
  return areas
}

async function main() {
  if (!existsSync(PLAN_FILE)) {
    console.error('缺少 scripts/map-granularity.json，先执行 pnpm map:plan')
    process.exit(1)
  }
  const plan = JSON.parse(await readFile(PLAN_FILE, 'utf8'))
  const index = JSON.parse(await readFile(join(ADM2_DIR, 'index.json'), 'utf8'))
  const worldAreas = await loadWorldAreas()
  const target = plan.targetAreaKm2

  const files = new Set(
    (await readdir(ADM2_DIR)).filter((file) => /^[A-Z]{3}\.geojson$/.test(file)),
  )
  const problems = []
  const warnings = []
  const rows = []

  for (const [iso, entry] of Object.entries(plan.countries)) {
    const indexEntry = index.countries[iso]
    const plannedLevel = LEVELS[entry.level] ?? 'adm2'

    if (!indexEntry) {
      problems.push(`${iso}：索引里缺失`)
      continue
    }
    if (!files.has(`${iso}.geojson`)) {
      problems.push(`${iso}：文件不存在`)
      continue
    }
    if (indexEntry.level !== plannedLevel) {
      problems.push(`${iso}：规划 ${plannedLevel}，实际 ${indexEntry.level}`)
    }

    let payload
    try {
      payload = JSON.parse(await readFile(join(ADM2_DIR, `${iso}.geojson`), 'utf8'))
    } catch {
      problems.push(`${iso}：文件解析失败`)
      continue
    }
    const features = payload.features ?? []
    if (features.length === 0) {
      problems.push(`${iso}：没有要素`)
      continue
    }

    let area = 0
    for (const feature of features) area += geometryArea(feature.geometry)
    const mean = area / features.length
    const countryArea = worldAreas.get(iso) ?? 0
    const coverage = countryArea > 0 ? area / countryArea : 0
    const deviation = Math.abs(Math.log(mean / target))
    // 自定义数据源（例如美国 CBSA）本来就只覆盖部分国土，不做覆盖率校验
    const partial = payload.partialCoverage === true

    rows.push({ iso, level: indexEntry.level, units: features.length, mean, coverage, deviation })

    if (!partial && coverage < 0.85 && countryArea > 20_000) {
      warnings.push(`${iso}：只覆盖 ${(coverage * 100).toFixed(0)}% 国土（可能是湖泊或海外岛屿）`)
    }
    if (!partial && coverage > 1.35 && countryArea > 20_000) {
      warnings.push(
        `${iso}：面积是国土的 ${(coverage * 100).toFixed(0)}%（可能含海域或争议区重叠）`,
      )
    }
    if (entry.units && Math.abs(Math.log(features.length / entry.units)) > 0.6) {
      problems.push(`${iso}：单元数 ${features.length} 与规划 ${entry.units} 差异过大`)
    }
    if (entry.meanAreaKm2 && Math.abs(Math.log(mean / entry.meanAreaKm2)) > 0.6) {
      problems.push(
        `${iso}：平均单元面积 ${Math.round(mean)} km² 与规划 ${Math.round(entry.meanAreaKm2)} km² 差异过大`,
      )
    }
  }

  const sorted = rows.sort((a, b) => a.mean - b.mean)
  const ratios = sorted.map((row) => row.mean / target)
  const percentile = (list, p) => list[Math.min(list.length - 1, Math.floor(list.length * p))]

  console.log(`基准 ${target} km²/单元，共 ${rows.length} 个国家\n`)
  console.log(
    `平均单元面积分布：最小 ${Math.round(sorted[0].mean)} km² / ` +
      `P10 ${Math.round(percentile(sorted, 0.1).mean)} / ` +
      `中位 ${Math.round(percentile(sorted, 0.5).mean)} / ` +
      `P90 ${Math.round(percentile(sorted, 0.9).mean)} / ` +
      `最大 ${Math.round(sorted[sorted.length - 1].mean)} km²`,
  )
  const inBand = ratios.filter((ratio) => ratio >= 0.2 && ratio <= 5).length
  console.log(`落在 0.2x ~ 5x 基准区间的国家：${inBand} / ${ratios.length}`)

  const tooFine = sorted.filter((row) => row.mean / target < 0.2)
  const tooCoarse = sorted.filter((row) => row.mean / target > 5)
  console.log(`\n偏细（<0.2x，${tooFine.length} 个）：`)
  for (const row of tooFine) {
    console.log(
      `  ${row.iso}  ${Math.round(row.mean)} km² ×${(row.mean / target).toFixed(2)}  ${row.level} ${row.units} 个`,
    )
  }
  console.log(`\n偏粗（>5x，${tooCoarse.length} 个）：`)
  for (const row of tooCoarse) {
    console.log(
      `  ${row.iso}  ${Math.round(row.mean)} km² ×${(row.mean / target).toFixed(2)}  ${row.level} ${row.units} 个`,
    )
  }

  console.log(`\n发现 ${problems.length} 个错误、${warnings.length} 条提示：`)
  for (const problem of problems) console.log(`  ✗ ${problem}`)
  for (const warning of warnings) console.log(`  · ${warning}`)

  process.exitCode = problems.length > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(`体检失败：${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
