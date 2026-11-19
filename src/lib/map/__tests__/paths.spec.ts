import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFeaturePath, FeaturePathCache, isPath2DSupported } from '../paths'
import type { WorldMapFeature } from '@/types/geo'

/** 记录调用序列的假 Path2D，用来验证世界坐标（y 轴取负）编码 */
class FakePath2D {
  readonly ops: string[] = []

  moveTo(x: number, y: number): void {
    this.ops.push(`M ${x} ${y}`)
  }

  lineTo(x: number, y: number): void {
    this.ops.push(`L ${x} ${y}`)
  }

  closePath(): void {
    this.ops.push('Z')
  }
}

function opsOf(path: unknown): string[] {
  return (path as FakePath2D).ops
}

function makeFeature(id: string): WorldMapFeature {
  return {
    id,
    code: id,
    name: id,
    nameEn: '',
    iso: '',
    parent: '',
    level: 'country',
    polygons: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    ],
    bounds: { minLng: 0, maxLng: 1, minLat: 0, maxLat: 1 },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Path2D 路径构建', () => {
  it('把经度当 x、纬度取负当 y，并闭合每个环', () => {
    vi.stubGlobal('Path2D', FakePath2D)
    const path = buildFeaturePath(makeFeature('a'))

    expect(path).toBeInstanceOf(FakePath2D)
    expect(opsOf(path)).toEqual(['M 0 0', 'L 1 0', 'L 1 -1', 'L 0 -1', 'Z'])
  })

  it('多边形的内环也写进同一条路径（靠 evenodd 挖洞）', () => {
    vi.stubGlobal('Path2D', FakePath2D)
    const feature = makeFeature('a')
    feature.polygons[0]!.push([
      [0.25, 0.25],
      [0.75, 0.25],
      [0.75, 0.75],
    ])

    const ops = opsOf(buildFeaturePath(feature))
    expect(ops.filter((op) => op === 'Z')).toHaveLength(2)
    expect(ops).toContain('M 0.25 -0.25')
  })

  it('环境没有 Path2D 时返回 null（jsdom 默认如此）', () => {
    vi.stubGlobal('Path2D', undefined)
    expect(isPath2DSupported()).toBe(false)
    expect(buildFeaturePath(makeFeature('a'))).toBeNull()
  })
})

describe('FeaturePathCache', () => {
  it('同一要素只构建一次，clear 后重建', () => {
    vi.stubGlobal('Path2D', FakePath2D)
    const cache = new FeaturePathCache()
    const feature = makeFeature('a')

    const first = cache.get(feature)
    expect(cache.get(feature)).toBe(first)

    cache.clear()
    expect(cache.get(feature)).not.toBe(first)
  })

  it('不同 id 的要素互不覆盖', () => {
    vi.stubGlobal('Path2D', FakePath2D)
    const cache = new FeaturePathCache()
    expect(cache.get(makeFeature('a'))).not.toBe(cache.get(makeFeature('b')))
  })
})
