/**
 * 地图几何工具：包围盒、射线法命中测试。
 *
 * 这些函数只处理经纬度，不碰 canvas，方便单独测试。
 */
import type { GeoFeatureBounds, GeoPolygon, GeoRing, WorldMapFeature } from '@/types/geo'

/** 两个包围盒是否相交（含接触） */
export function boundsIntersect(a: GeoFeatureBounds, b: GeoFeatureBounds): boolean {
  return (
    a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat
  )
}

/** 向外扩张包围盒，用于给裁剪留一点余量 */
export function expandBounds(bounds: GeoFeatureBounds, margin: number): GeoFeatureBounds {
  return {
    minLng: bounds.minLng - margin,
    maxLng: bounds.maxLng + margin,
    minLat: bounds.minLat - margin,
    maxLat: bounds.maxLat + margin,
  }
}

/** 射线法：点是否在环内 */
export function rayCast(lng: number, lat: number, ring: GeoRing): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const current = ring[i]
    const previous = ring[j]
    if (!current || !previous) {
      continue
    }
    const [xi, yi] = current
    const [xj, yj] = previous
    // 边跨越测试点所在纬度，且交点在测试点右侧
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** 在外环内且不在任何内环里才算命中 */
export function pointInPolygon(lng: number, lat: number, polygon: GeoPolygon): boolean {
  const outer = polygon[0]
  if (!outer || !rayCast(lng, lat, outer)) {
    return false
  }
  for (let index = 1; index < polygon.length; index += 1) {
    const hole = polygon[index]
    if (hole && rayCast(lng, lat, hole)) {
      return false
    }
  }
  return true
}

/** 先过包围盒再逐多边形命中，避免无谓的射线计算 */
export function pointInFeature(lng: number, lat: number, feature: WorldMapFeature): boolean {
  const { bounds } = feature
  if (lng < bounds.minLng || lng > bounds.maxLng || lat < bounds.minLat || lat > bounds.maxLat) {
    return false
  }
  return feature.polygons.some((polygon) => pointInPolygon(lng, lat, polygon))
}
