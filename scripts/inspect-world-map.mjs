/**
 * 本地验收脚本：打开 /pages/world-map，检查缩放后的市级行政区渲染、悬停与点击，
 * 并记录长任务，确认拖拽/缩放没有明显卡顿。不依赖测试框架：
 *   node scripts/inspect-world-map.mjs [url]
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/pages/world-map'
const OUT_DIR = 'test-results'

const NAV_HEIGHT = 64
const VIEWPORT = { width: 1440, height: 900 }
const CANVAS_HEIGHT = VIEWPORT.height - NAV_HEIGHT
const SCALE = VIEWPORT.width / 360
const CX = VIEWPORT.width / 2
const CY = CANVAS_HEIGHT / 2

/** 缩放为 1、偏移为 0 时的经纬度 → 页面坐标 */
function toPage(lng, lat) {
  return { x: CX + lng * SCALE, y: NAV_HEIGHT + (CY - lat * SCALE) }
}

/** 用页面里读到的相机状态换算页面坐标 */
function pagePoint(lng, lat, camera) {
  const unitX = camera.scaleX * camera.zoom
  const unitY = camera.scaleY * camera.zoom
  return {
    x: camera.cx + (lng + camera.offsetX) * unitX,
    y: NAV_HEIGHT + camera.cy - (lat + camera.offsetY) * unitY,
  }
}

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      const browser = await chromium.launch(channel ? { channel } : {})
      console.log(`浏览器：${channel ?? 'bundled chromium'}`)
      return browser
    } catch (error) {
      console.log(`启动 ${channel ?? 'chromium'} 失败：${error.message.split('\n')[0]}`)
    }
  }
  throw new Error('没有可用的 Chromium（先执行 npx playwright install chromium）')
}

await mkdir(OUT_DIR, { recursive: true })
const browser = await launch()
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })

const consoleErrors = []
const failedRequests = []
const badResponses = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(`${message.text()} @ ${message.location().url}`)
  }
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))
page.on('requestfailed', (request) =>
  failedRequests.push(`${request.url()} ${request.failure()?.errorText}`),
)
page.on('response', (response) => {
  if (response.status() >= 400) {
    badResponses.push(`${response.status()} ${response.url()}`)
  }
})

await page.goto(URL, { waitUntil: 'load' })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT_DIR}/map-1-world.png` })
console.log('已截图 map-1-world.png（全球视图）')

// 以中国为中心连续放大，越过 CITY_ZOOM=2.4（1.12^9 ≈ 2.77）
const china = toPage(105, 34)
await page.mouse.move(china.x, china.y)
for (let index = 0; index < 9; index += 1) {
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(80)
}
await page.waitForTimeout(2200)
await page.screenshot({ path: `${OUT_DIR}/map-2-china-cities.png` })

const cameraState = await page.evaluate(() => window.__worldMapCamera?.() ?? null)
console.log(
  `相机：zoom=${cameraState?.zoom?.toFixed(2)} offsetX=${cameraState?.offsetX?.toFixed(1)} offsetY=${cameraState?.offsetY?.toFixed(1)}`,
)
console.log('已截图 map-2-china-cities.png')

// 悬停在中国中部，检查市级高亮
const zunyi = pagePoint(107.0, 27.7, cameraState)
await page.mouse.move(zunyi.x - 4, zunyi.y - 4)
await page.waitForTimeout(300)
await page.mouse.move(zunyi.x, zunyi.y)
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT_DIR}/map-3-hover.png` })
console.log('已截图 map-3-hover.png')

// 点击市级行政区：不应该触发全屏过场，直接弹出面板
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(700)
const overlay = await page.locator('.loading-panel').count()
const cityPanel = await page
  .locator('.info-panel')
  .innerText()
  .catch(() => '')
await page.screenshot({ path: `${OUT_DIR}/map-4-city-panel.png` })
console.log(`点击市级：过场=${overlay}，面板=${JSON.stringify(cityPanel)}`)
console.log('已截图 map-4-city-panel.png')

// 点击国家（蒙古）：应该仍然播放“入侵进度”过场
const mongolia = pagePoint(103.5, 46.8, cameraState)
await page.mouse.move(mongolia.x, mongolia.y)
await page.waitForTimeout(200)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(800)
const countryOverlay = await page.locator('.loading-panel').count()
const countryPanel = await page
  .locator('.info-panel')
  .innerText()
  .catch(() => '')
console.log(`点击国家：过场=${countryOverlay}，面板=${JSON.stringify(countryPanel)}`)
await page.screenshot({ path: `${OUT_DIR}/map-5-country-loading.png` })
console.log('已截图 map-5-country-loading.png')

// 等“入侵进度”过场结束，否则它会挡住后续点击
await page
  .waitForSelector('.loading-panel', { state: 'detached', timeout: 15000 })
  .catch(() => console.log('过场没有在 15s 内结束'))

// 再检查一个 geoBoundaries 国家（德国），验证非中国数据的渲染与点击
const focusReady = await page.evaluate(() => typeof window.__worldMapFocus === 'function')
console.log(`调试聚焦接口：${focusReady ? '可用' : '不可用'}`)
await page.evaluate(() => window.__worldMapFocus?.(10.4, 51.1, 6))
await page.waitForTimeout(2600)
await page.screenshot({ path: `${OUT_DIR}/map-6-germany.png` })
const germanyCamera = await page.evaluate(() => window.__worldMapCamera?.() ?? null)
const bavaria = pagePoint(11.4, 48.8, germanyCamera)
await page.mouse.move(bavaria.x, bavaria.y)
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT_DIR}/map-7-germany-hover.png` })
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(700)
const germanyPanel = await page
  .locator('.info-panel')
  .innerText()
  .catch(() => '')
console.log(`点击德国次级行政区：面板=${JSON.stringify(germanyPanel)}`)
await page.screenshot({ path: `${OUT_DIR}/map-8-germany-panel.png` })

// 长任务统计：缩放 + 拖拽若出现 >50ms 的长任务说明掉帧
await page.evaluate(() => {
  window.__longTasks = []
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__longTasks.push(Math.round(entry.duration))
    }
  }).observe({ entryTypes: ['longtask'] })
})

await page.mouse.move(700, 400)
await page.mouse.down()
for (let index = 0; index < 30; index += 1) {
  await page.mouse.move(700 - index * 6, 400 + index * 2)
  await page.waitForTimeout(40)
}
await page.mouse.up()
for (let index = 0; index < 6; index += 1) {
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(60)
}
const longTasks = await page.evaluate(() => window.__longTasks)
console.log(`长任务（>50ms）：${longTasks.length === 0 ? '无' : longTasks.join(', ') + ' ms'}`)

const loadedChunks = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/geo/admin2/'))
    .map((entry) => entry.name.split('/admin2/')[1]),
)
console.log(`加载的市级分块：${loadedChunks.join(', ') || '(无)'}`)

if (badResponses.length > 0) {
  console.log(`HTTP 错误：${badResponses.join(' | ')}`)
}
if (failedRequests.length > 0) {
  console.log(`失败请求：${failedRequests.join(' | ')}`)
}
console.log(
  consoleErrors.length === 0
    ? '页面无 console error'
    : `页面错误 ${consoleErrors.length} 条：\n  - ${consoleErrors.join('\n  - ')}`,
)

await browser.close()
