import { describe, expect, it } from 'vitest'

import {
  deviceTransform,
  fitScale,
  lineWidthFor,
  screenToWorld,
  viewBounds,
  worldToScreen,
  type Camera,
} from '../projection'

const camera: Camera = {
  width: 1200,
  height: 600,
  cx: 600,
  cy: 300,
  scaleX: 1200 / 360,
  scaleY: 600 / 180,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
}

describe('fitScale', () => {
  it('窗口比 2:1 更扁时横向拉伸铺满宽度，纵向仍能放下整个世界', () => {
    const { scaleX, scaleY } = fitScale(1920, 886)
    expect(scaleX * 360).toBeCloseTo(1920, 5)
    expect(scaleY * 180).toBeCloseTo(886, 5)
    expect(scaleX).toBeGreaterThan(scaleY)
  })

  it('窗口比 2:1 更窄时保持等比，不会横向压缩地图', () => {
    const { scaleX, scaleY } = fitScale(1000, 1200)
    expect(scaleY).toBeCloseTo(scaleX, 6)
    expect(scaleX * 360).toBeCloseTo(1000, 5)
    expect(scaleY * 180).toBeLessThanOrEqual(1200)
  })
})

describe('viewBounds', () => {
  it('zoom=1 时宽度覆盖整个世界', () => {
    const bounds = viewBounds(camera)
    expect(bounds.minLng).toBeCloseTo(-180, 5)
    expect(bounds.maxLng).toBeCloseTo(180, 5)
  })

  it('放大后可视范围变小，并随偏移移动', () => {
    const zoomed = viewBounds({ ...camera, zoom: 4 })
    expect(zoomed.maxLng - zoomed.minLng).toBeCloseTo(90, 5)

    const shifted = viewBounds({ ...camera, zoom: 4, offsetX: 30 })
    expect(shifted.minLng).toBeCloseTo(zoomed.minLng - 30, 5)
    expect(shifted.maxLng).toBeCloseTo(zoomed.maxLng - 30, 5)
  })

  it('经度副本会整体平移 360 度', () => {
    const base = viewBounds(camera)
    const shifted = viewBounds(camera, 360)
    expect(shifted.minLng).toBeCloseTo(base.minLng - 360, 5)
    expect(shifted.maxLng).toBeCloseTo(base.maxLng - 360, 5)
  })
})

describe('worldToScreen / screenToWorld', () => {
  it('互逆', () => {
    const screen = worldToScreen({ ...camera, zoom: 3, offsetX: -20, offsetY: 12 }, 100, 30, 360)
    const world = screenToWorld(
      { ...camera, zoom: 3, offsetX: -20, offsetY: 12 },
      screen.x,
      screen.y,
      360,
    )
    expect(world.lng).toBeCloseTo(100, 5)
    expect(world.lat).toBeCloseTo(30, 5)
  })

  it('横向拉伸时两个方向各用自己的比例，且仍然互逆', () => {
    const stretched = { ...camera, scaleX: camera.scaleX * 1.2 }
    const screen = worldToScreen(stretched, 90, 45)
    expect(screen.x).toBeCloseTo(stretched.cx + 90 * stretched.scaleX, 5)
    expect(screen.y).toBeCloseTo(stretched.cy - 45 * stretched.scaleY, 5)

    const world = screenToWorld(stretched, screen.x, screen.y)
    expect(world.lng).toBeCloseTo(90, 5)
    expect(world.lat).toBeCloseTo(45, 5)
  })

  it('赤道与中央经线落在画布中心', () => {
    expect(worldToScreen(camera, 0, 0)).toEqual({ x: 600, y: 300 })
  })
})

describe('deviceTransform', () => {
  it('与 worldToScreen 的结果一致（含 dpr 与经度副本）', () => {
    const shifted = { ...camera, zoom: 2.5, offsetX: 8, offsetY: -4 }
    const dpr = 2
    const transform = deviceTransform(shifted, dpr, 360)
    const screen = worldToScreen(shifted, 45, 20, 360)

    const deviceX = transform.a * 45 + transform.e
    const deviceY = transform.d * -20 + transform.f
    expect(deviceX).toBeCloseTo(screen.x * dpr, 5)
    expect(deviceY).toBeCloseTo(screen.y * dpr, 5)
  })

  it('线宽换算：1 CSS 像素对应 1/(几何平均比例*zoom) 度', () => {
    const unit = Math.sqrt(camera.scaleX * camera.scaleY) * 2
    expect(lineWidthFor({ ...camera, zoom: 2 }, 1)).toBeCloseTo(1 / unit, 6)
  })
})
