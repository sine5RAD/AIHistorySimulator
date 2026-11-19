import { describe, expect, it } from 'vitest'

import { boundsIntersect, expandBounds, pointInFeature, pointInPolygon, rayCast } from '../geometry'
import type { GeoPolygon, GeoPolygons, WorldMapFeature } from '@/types/geo'

/** 一个 10×10 的正方形，中间挖掉 2×2 的洞 */
const squareWithHole: GeoPolygon = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
  ],
]

const detachedIsland: GeoPolygon = [
  [
    [20, 20],
    [21, 20],
    [21, 21],
    [20, 21],
  ],
]

function makeFeature(polygons: GeoPolygons): WorldMapFeature {
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        minLng = Math.min(minLng, lng)
        maxLng = Math.max(maxLng, lng)
        minLat = Math.min(minLat, lat)
        maxLat = Math.max(maxLat, lat)
      }
    }
  }
  return {
    id: 'test',
    code: 'test',
    name: '测试',
    nameEn: '',
    iso: '',
    parent: '',
    level: 'country',
    polygons,
    bounds: { minLng, maxLng, minLat, maxLat },
  }
}

describe('boundsIntersect', () => {
  it('相交与相离', () => {
    const a = { minLng: 0, maxLng: 10, minLat: 0, maxLat: 10 }
    expect(boundsIntersect(a, { minLng: 5, maxLng: 15, minLat: 5, maxLat: 15 })).toBe(true)
    expect(boundsIntersect(a, { minLng: 10, maxLng: 20, minLat: 10, maxLat: 20 })).toBe(true)
    expect(boundsIntersect(a, { minLng: 11, maxLng: 20, minLat: 0, maxLat: 10 })).toBe(false)
  })

  it('expandBounds 向四周扩张', () => {
    expect(expandBounds({ minLng: 0, maxLng: 10, minLat: 2, maxLat: 8 }, 1)).toEqual({
      minLng: -1,
      maxLng: 11,
      minLat: 1,
      maxLat: 9,
    })
  })
})

describe('rayCast / pointInPolygon', () => {
  it('内部命中外环，外部不命中', () => {
    expect(rayCast(2, 2, squareWithHole[0]!)).toBe(true)
    expect(rayCast(20, 2, squareWithHole[0]!)).toBe(false)
  })

  it('洞里的点不算命中', () => {
    expect(pointInPolygon(5, 5, squareWithHole)).toBe(false)
    expect(pointInPolygon(2, 5, squareWithHole)).toBe(true)
  })
})

describe('pointInFeature', () => {
  it('先过包围盒，再逐多边形判断', () => {
    const feature = makeFeature([squareWithHole])
    expect(pointInFeature(1, 1, feature)).toBe(true)
    expect(pointInFeature(5, 5, feature)).toBe(false)
    expect(pointInFeature(-1, 1, feature)).toBe(false)
  })

  it('多块不相连的领土任一命中即可', () => {
    const feature = makeFeature([squareWithHole, detachedIsland])
    expect(pointInFeature(20.5, 20.5, feature)).toBe(true)
    expect(pointInFeature(2, 2, feature)).toBe(true)
  })
})
