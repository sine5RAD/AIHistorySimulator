/**
 * 等距圆柱投影的相机换算。
 *
 * 约定：世界坐标 x = 经度，y = 负纬度；屏幕坐标单位是 CSS 像素。
 * canvas 实体像素的变换矩阵见 `deviceTransform`，调用方乘上 dpr 即可。
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
  /** 经纬度到 CSS 像素的比例：width / 360 */
  scale: number
  zoom: number
  /** 经度偏移（度） */
  offsetX: number
  /** 纬度偏移（度） */
  offsetY: number
}

/** 当前视口覆盖的经纬度范围 */
export function viewBounds(camera: Camera, shift = 0): GeoFeatureBounds {
  const unit = camera.scale * camera.zoom
  if (unit <= 0) {
    return { minLng: -180, maxLng: 180, minLat: -90, maxLat: 90 }
  }
  return {
    minLng: (0 - camera.cx) / unit - camera.offsetX - shift,
    maxLng: (camera.width - camera.cx) / unit - camera.offsetX - shift,
    minLat: (camera.cy - camera.height) / unit - camera.offsetY,
    maxLat: (camera.cy - 0) / unit - camera.offsetY,
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
  const unit = camera.scale * camera.zoom
  return {
    x: camera.cx + (lng + camera.offsetX + shift) * unit,
    y: camera.cy - (lat + camera.offsetY) * unit,
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
  const unit = camera.scale * camera.zoom
  if (unit <= 0) {
    return { lng: 0, lat: 0 }
  }
  return {
    lng: (x - camera.cx) / unit - camera.offsetX - shift,
    lat: (camera.cy - y) / unit - camera.offsetY,
  }
}

/**
 * 世界坐标 → canvas 实体像素的变换矩阵分量。
 * 路径本身用 (lng, -lat) 构建，所以 y 轴同样是正向缩放。
 */
export function deviceTransform(
  camera: Camera,
  dpr: number,
  shift = 0,
): { a: number; e: number; f: number } {
  const unit = camera.scale * camera.zoom
  return {
    a: dpr * unit,
    e: dpr * (camera.cx + (camera.offsetX + shift) * unit),
    f: dpr * (camera.cy - camera.offsetY * unit),
  }
}

/** 屏幕线宽换算成世界坐标线宽（1 CSS 像素对应多少度） */
export function lineWidthFor(camera: Camera, cssPixels: number): number {
  const unit = camera.scale * camera.zoom
  return unit > 0 ? cssPixels / unit : 0
}
