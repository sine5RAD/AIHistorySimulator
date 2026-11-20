/**
 * 粒度统一后的视觉验收：欧洲整片、中国县级、以及分块加载耗时。
 *   node scripts/inspect-granularity.mjs [url]
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/pages/world-map'
const OUT_DIR = 'test-results'
const VIEWPORT = { width: 1440, height: 900 }

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch(channel ? { channel } : {})
    } catch {
      // 换下一个
    }
  }
  throw new Error('没有可用的 Chromium')
}

await mkdir(OUT_DIR, { recursive: true })
const browser = await launch()
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    errors.push(message.text())
  }
})

await page.goto(URL, { waitUntil: 'load' })
await page.waitForTimeout(2500)

// 欧洲：对齐用户截图里的视角
await page.evaluate(() => window.__worldMapFocus?.(5.2, 50.2, 5.6))
await page.waitForTimeout(4500)
await page.screenshot({ path: `${OUT_DIR}/gran-1-europe.png` })
console.log('已截图 gran-1-europe.png（欧洲）')

// 中国：县级
await page.evaluate(() => {
  window.__longTasks = []
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration))
  }).observe({ entryTypes: ['longtask'] })
})
await page.evaluate(() => window.__worldMapFocus?.(105, 34, 4.2))
const chinaStart = Date.now()
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT_DIR}/gran-2-china-county.png` })
const longTasks = await page.evaluate(() => window.__longTasks)
console.log(
  `已截图 gran-2-china-county.png（等待 ${((Date.now() - chinaStart) / 1000).toFixed(1)}s，` +
    `长任务 ${longTasks.length ? longTasks.join(' / ') + ' ms' : '无'}）`,
)

// 点一个县级单元，确认面板显示层级名
const camera = await page.evaluate(() => window.__worldMapCamera?.() ?? null)
const unitX = camera.scaleX * camera.zoom
const unitY = camera.scaleY * camera.zoom
const clickX = camera.cx + (113.26 + camera.offsetX) * unitX
const clickY = 64 + camera.cy - (23.13 + camera.offsetY) * unitY
await page.mouse.move(clickX, clickY)
await page.waitForTimeout(300)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(800)
const panel = await page
  .locator('.info-panel')
  .innerText()
  .catch(() => '')
console.log(`点击广州附近：${JSON.stringify(panel)}`)
await page.screenshot({ path: `${OUT_DIR}/gran-3-china-panel.png` })

const resources = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/geo/admin2/') && entry.name.endsWith('.geojson'))
    .map((entry) => ({
      file: entry.name.split('/admin2/')[1],
      kb: Math.round((entry.transferSize || 0) / 1024),
      ms: Math.round(entry.duration),
    })),
)
console.log('分块加载：', JSON.stringify(resources.slice(0, 8)))

const sampledLongTasks = await page.evaluate(() => window.__longTasks ?? null)
console.log(
  sampledLongTasks
    ? `中国分块相关长任务：${sampledLongTasks.length ? sampledLongTasks.join(' / ') + ' ms' : '无'}`
    : '（未采样长任务）',
)
console.log(errors.length === 0 ? '无页面错误' : `页面错误：${errors.slice(0, 5).join(' | ')}`)

await browser.close()
