/**
 * 等距圆柱投影的相机换算。
 *
 * 约定：世界坐标 x = 经度，y = 负纬度；屏幕坐标单位是 CSS 像素。
 * canvas 实体像素的变换矩阵见 `deviceTransform`，调用方乘上 dpr 即可。
 * 为了适配视口，横向与纵向允许使用不同的缩放比例（见 `fitScale`）。
 */
import type { GeoFeatureBounds } from '@/types/geo'

export interface Camera {
  /** 画布 CSS 宽度 */
  width: number
  /** 画布 CSS 高度 */
  height: number
  /** 宽度一半，投影中心 X */
  cx: number
  /** 高度一半，投影中心 Y */
  cy: number
  /** 经度方向：1° 对应的 CSS 像素 */
  scaleX: number
  /** 纬度方向：1° 对应的 CSS 像素；与 scaleX 不等时即为横向拉伸适配 */
  scaleY: number
  zoom: number
  /** 经度偏移（度） */
  offsetX: number
  /** 纬度偏移（度） */
  offsetY: number
}

/**
 * 计算覆盖视口的经纬度比例。
 * - 横向始终让 360° 铺满窗口宽度，最小缩放时左右不会露出重复副本；
 * - 纵向保证整个 180° 纬度都放得下，整幅世界地图完整可见；
 * - 窗口比 2:1 更扁时，纵向比例小于横向，地图被横向拉伸，而不是裁掉南北极。
 */
export function fitScale(width: number, height: number): { scaleX: number; scaleY: number } {
  const scaleX = width / 360
  return { scaleX, scaleY: Math.min(scaleX, height / 180) }
}

/** 当前视口覆盖的经纬度范围 */
export function viewBounds(camera: Camera, shift = 0): GeoFeatureBounds {
  const unitX = camera.scaleX * camera.zoom
  const unitY = camera.scaleY * camera.zoom
  if (unitX <= 0 || unitY <= 0) {
    return { minLng: -180, maxLng: 180, minLat: -90, maxLat: 90 }
  }
  return {
    minLng: (0 - camera.cx) / unitX - camera.offsetX - shift,
    maxLng: (camera.width - camera.cx) / unitX - camera.offsetX - shift,
    minLat: (camera.cy - camera.height) / unitY - camera.offsetY,
    maxLat: (camera.cy - 0) / unitY - camera.offsetY,
  }
}

/** 经纬度 → CSS 像素坐标 */
export function worldToScreen(
  camera: Camera,
  lng: number,
  lat: number,
  shift = 0,
): {
  x: number
  y: number
} {
  const unitX = camera.scaleX * camera.zoom
  const unitY = camera.scaleY * camera.zoom
  return {
    x: camera.cx + (lng + camera.offsetX + shift) * unitX,
    y: camera.cy - (lat + camera.offsetY) * unitY,
  }
}

/** CSS 像素 → 经纬度（shift 对应第几份经度副本） */
export function screenToWorld(
  camera: Camera,
  x: number,
  y: number,
  shift = 0,
): {
  lng: number
  lat: number
} {
  const unitX = camera.scaleX * camera.zoom
  const unitY = camera.scaleY * camera.zoom
  if (unitX <= 0 || unitY <= 0) {
    return { lng: 0, lat: 0 }
  }
  return {
    lng: (x - camera.cx) / unitX - camera.offsetX - shift,
    lat: (camera.cy - y) / unitY - camera.offsetY,
  }
}

/**
 * 世界坐标 → canvas 实体像素的变换矩阵分量。
 * 路径本身用 (lng, -lat) 构建，所以 y 轴同样是正向缩放；
 * 横向拉伸适配时 a 与 d 不相等。
 */
export function deviceTransform(
  camera: Camera,
  dpr: number,
  shift = 0,
): { a: number; d: number; e: number; f: number } {
  const unitX = camera.scaleX * camera.zoom
  const unitY = camera.scaleY * camera.zoom
  return {
    a: dpr * unitX,
    d: dpr * unitY,
    e: dpr * (camera.cx + (camera.offsetX + shift) * unitX),
    f: dpr * (camera.cy - camera.offsetY * unitY),
  }
}

/**
 * 屏幕线宽换算成世界坐标线宽（1 CSS 像素对应多少度）。
 * 横向可能被拉伸，取两个方向单位比例的几何平均，线宽在两个方向的偏差最小。
 */
export function lineWidthFor(camera: Camera, cssPixels: number): number {
  const unit = Math.sqrt(camera.scaleX * camera.scaleY) * camera.zoom
  return unit > 0 ? cssPixels / unit : 0
}
