import { describe, expect, it } from 'vitest'

import type { WorldMapFeature } from '@/types/geo'
import { getFeatureTerritoryCode, normalizeTerritoryCode } from '../territory-code'

const makeFeature = (overrides: Partial<WorldMapFeature>): WorldMapFeature => ({
  id: 'feature',
  code: '',
  name: '测试地区',
  nameEn: '',
  iso: '',
  parent: '',
  level: 'adm1',
  polygons: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    ],
  ],
  bounds: { minLng: 0, maxLng: 1, minLat: 0, maxLat: 1 },
  ...overrides,
})

describe('normalizeTerritoryCode', () => {
  it('统一大小写并去掉空白', () => {
    expect(normalizeTerritoryCode('  de-by ')).toBe('DE-BY')
    expect(normalizeTerritoryCode('110000')).toBe('110000')
  })
})

describe('getFeatureTerritoryCode', () => {
  it('国家使用 ISO3', () => {
    expect(
      getFeatureTerritoryCode(
        makeFeature({ id: 'Germany', code: 'DEU', iso: 'DEU', level: 'country' }),
      ),
    ).toBe('DEU')
  })

  it('优先使用 ISO 3166-2 地区编号', () => {
    expect(
      getFeatureTerritoryCode(
        makeFeature({ id: 'hash-1', code: 'DE-BY', iso: 'DEU', level: 'adm1' }),
      ),
    ).toBe('DE-BY')
  })

  it('中国 adcode 即使和要素 id 相同也保留', () => {
    expect(
      getFeatureTerritoryCode(
        makeFeature({ id: '110000', code: '110000', iso: 'CHN', level: 'adm2' }),
      ),
    ).toBe('110000')
  })

  it('占位代码退回「国家:要素ID」', () => {
    expect(
      getFeatureTerritoryCode(
        makeFeature({ id: 'hash-2', code: 'DEU-ADM1', iso: 'DEU', level: 'adm1' }),
      ),
    ).toBe('DEU:HASH-2')
  })

  it('代码等于哈希 ID 时也退回「国家:要素ID」', () => {
    expect(
      getFeatureTerritoryCode(
        makeFeature({ id: 'abc123', code: 'abc123', iso: 'FRA', level: 'adm2' }),
      ),
    ).toBe('FRA:ABC123')
  })
})
