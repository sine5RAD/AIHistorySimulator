#!/usr/bin/env node
/**
 * 兼容入口：地图数据生成已合并到 `scripts/build-map-data.mjs`。
 *
 * 这个文件只做转发，等价于 `node scripts/build-map-data.mjs --world --china`；
 * 新代码请直接用 `pnpm map:data` 或 `pnpm map:data:all`。
 */
console.warn(
  '[deprecated] scripts/download-world-geojson.mjs 已合并到 scripts/build-map-data.mjs，' +
    '正在转发为 --world --china …',
)
await import('./build-map-data.mjs')
