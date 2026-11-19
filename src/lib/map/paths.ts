/**
 * 世界坐标下的 Path2D 缓存。
 *
 * 每个要素的路径只构建一次，坐标是「经度 / 负纬度」这种世界坐标，
 * 绘制时靠 ctx.setTransform 做平移缩放。这样拖动、缩放时构建路径的
 * JS 开销为零，canvas 用原生代码变换即可。
 */
import type { WorldMapFeature } from '@/types/geo'

/** jsdom 等环境没有 Path2D，需要降级 */
export function isPath2DSupported(): boolean {
  return typeof Path2D !== 'undefined'
}

/**
 * 把一个要素的多边形编成一条 Path2D。
 * 内环直接跟在后面，靠 fill('evenodd') 挖洞。
 */
export function buildFeaturePath(feature: WorldMapFeature): Path2D | null {
  if (!isPath2DSupported()) {
    return null
  }
  const path = new Path2D()
  let started = false

  for (const polygon of feature.polygons) {
    for (const ring of polygon) {
      const start = ring[0]
      if (!start) {
        continue
      }
      path.moveTo(start[0], -start[1])
      for (let index = 1; index < ring.length; index += 1) {
        const point = ring[index]
        if (!point) {
          continue
        }
        path.lineTo(point[0], -point[1])
      }
      path.closePath()
      started = true
    }
  }

  return started ? path : null
}

/**
 * 按要素缓存的 Path2D 表。
 *
 * 用 WeakMap 以要素对象为键：某个国家的市级分块被 LRU 淘汰后，要素对象
 * 没人引用，缓存项会被 GC 一起回收，长时间浏览不会越积越多。
 */
export class FeaturePathCache {
  private cache = new WeakMap<WorldMapFeature, Path2D | null>()

  get(feature: WorldMapFeature): Path2D | null {
    if (this.cache.has(feature)) {
      return this.cache.get(feature) ?? null
    }
    const built = buildFeaturePath(feature)
    this.cache.set(feature, built)
    return built
  }

  clear(): void {
    this.cache = new WeakMap()
  }
}
