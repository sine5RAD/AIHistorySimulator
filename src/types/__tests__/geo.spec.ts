import { describe, expect, it } from 'vitest'

import { pointInFeature } from '@/lib/map/geometry'
import { isRawFeatureCollection, normalizeWorldFeatures } from '../geo'

const square = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
]

describe('isRawFeatureCollection', () => {
  it('识别 FeatureCollection', () => {
    expect(isRawFeatureCollection({ type: 'FeatureCollection', features: [] })).toBe(true)
    expect(isRawFeatureCollection({ type: 'Feature', features: [] })).toBe(false)
    expect(isRawFeatureCollection(null)).toBe(false)
    expect(isRawFeatureCollection({ type: 'FeatureCollection' })).toBe(false)
  })
})

describe('normalizeWorldFeatures', () => {
  it('Natural Earth 风格：iso + 中英文名', () => {
    const features = normalizeWorldFeatures({
      type: 'FeatureCollection',
      features: [
        {
          properties: { iso: 'CHN', name: '中国', name_en: 'China' },
          geometry: { type: 'Polygon', coordinates: square },
        },
      ],
    })
    expect(features).toHaveLength(1)
    expect(features[0]).toMatchObject({
      id: 'CHN',
      name: '中国',
      nameEn: 'China',
      iso: 'CHN',
      level: 'country',
    })
    expect(features[0]!.bounds).toEqual({ minLng: 0, maxLng: 1, minLat: 0, maxLat: 1 })
  })

  it('DataV 风格：adcode 作为 id，parent 是对象', () => {
    const features = normalizeWorldFeatures(
      {
        type: 'FeatureCollection',
        features: [
          {
            properties: {
              adcode: 440100,
              name: '广州市',
              level: 'city',
              parent: { adcode: 440000 },
            },
            geometry: { type: 'MultiPolygon', coordinates: [square] },
          },
        ],
      },
      'adm2',
    )
    expect(features[0]).toMatchObject({
      id: '440100',
      code: '440100',
      name: '广州市',
      level: 'adm2',
      parent: '440000',
    })
  })

  it('geoBoundaries 风格：shape 字段，哈希 id 用「国家-层级」兜底展示', () => {
    const features = normalizeWorldFeatures(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              shapeID: '9070358B1315543690610',
              shapeName: 'Baden-Württemberg',
              shapeGroup: 'DEU',
            },
            geometry: { type: 'Polygon', coordinates: square },
          },
        ],
      },
      'adm2',
    )
    expect(features[0]).toMatchObject({
      id: '9070358B1315543690610',
      code: 'DEU-ADM2',
      name: 'Baden-Württemberg',
      iso: 'DEU',
      level: 'adm2',
    })
  })

  it('丢弃点线等无法绘制的要素，缺名时回退到 id', () => {
    const features = normalizeWorldFeatures({
      type: 'FeatureCollection',
      features: [
        { properties: { name: '线' }, geometry: { type: 'LineString', coordinates: [] } },
        { id: 'X1', properties: {}, geometry: { type: 'Polygon', coordinates: square } },
        { properties: {}, geometry: null },
      ],
    })
    expect(features).toHaveLength(1)
    expect(features[0]).toMatchObject({ id: 'X1', name: 'X1' })
  })

  it('展开 GeometryCollection', () => {
    const features = normalizeWorldFeatures({
      type: 'FeatureCollection',
      features: [
        {
          id: 'G',
          properties: { name: '集合' },
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Polygon', coordinates: square },
              { type: 'Point', coordinates: [0, 0] },
            ],
          },
        },
      ],
    })
    expect(features).toHaveLength(1)
    expect(features[0]!.polygons).toHaveLength(1)
  })

  it('跨 180° 经线的要素会展开成连续经度，包围盒不再横跨全球', () => {
    const features = normalizeWorldFeatures({
      type: 'FeatureCollection',
      features: [
        {
          id: 'FJI',
          properties: { name: '斐济' },
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [177, -17],
                  [180, -17],
                  [180, -18],
                  [177, -18],
                ],
              ],
              [
                [
                  [-180, -17],
                  [-178, -17],
                  [-178, -18],
                  [-180, -18],
                ],
              ],
            ],
          },
        },
      ],
    })

    const fiji = features[0]!
    expect(fiji.bounds).toEqual({ minLng: 177, maxLng: 182, minLat: -18, maxLat: -17 })
    // 原本在西半球的 -179° 被平移到了 181°，命中测试才能正常工作
    expect(pointInFeature(181, -17.5, fiji)).toBe(true)
    expect(pointInFeature(179, -17.5, fiji)).toBe(true)
  })
})
