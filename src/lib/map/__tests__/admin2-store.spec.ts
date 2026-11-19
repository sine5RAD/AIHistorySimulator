import { afterEach, describe, expect, it, vi } from 'vitest'

import { Admin2Store, toCorsSafeUrl } from '../admin2-store'

const chunkPayload = {
  type: 'FeatureCollection',
  features: [
    {
      id: '440100',
      properties: { name: '广州市', parent: '广东省', level: 'city' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [113, 23],
            [114, 23],
            [114, 24],
            [113, 24],
            [113, 23],
          ],
        ],
      },
    },
  ],
}

function jsonResponse(payload: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': contentType },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Admin2Store', () => {
  it('把 github.com/raw 链接换成 raw.githubusercontent.com（否则跨域会被拦）', () => {
    expect(
      toCorsSafeUrl(
        'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/MNG/ADM2/x.geojson',
      ),
    ).toBe(
      'https://raw.githubusercontent.com/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/MNG/ADM2/x.geojson',
    )
    expect(toCorsSafeUrl('https://www.geoboundaries.org/api/x')).toBe(
      'https://www.geoboundaries.org/api/x',
    )
  })
  it('按需加载本地分块并缓存命中', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(chunkPayload))
    vi.stubGlobal('fetch', fetchMock)

    const store = new Admin2Store({
      baseUrl: '/',
      index: { countries: { CHN: { units: 1 } } },
      enableRemote: false,
      onChange: () => {},
    })

    expect(store.state('CHN')).toBe('idle')
    store.ensure('CHN')
    expect(store.state('CHN')).toBe('loading')

    await vi.waitFor(() => expect(store.state('CHN')).toBe('ready'))

    const chunk = store.chunk('CHN')
    expect(chunk?.source).toBe('local')
    expect(chunk?.features[0]).toMatchObject({ id: '440100', name: '广州市', level: 'adm2' })
    expect(chunk?.bounds).toEqual({ minLng: 113, maxLng: 114, minLat: 23, maxLat: 24 })
    expect(fetchMock).toHaveBeenCalledWith('/geo/admin2/CHN.geojson', expect.anything())
  })

  it('索引里没有且关闭远端时不发请求', () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    const store = new Admin2Store({
      baseUrl: '/',
      index: null,
      enableRemote: false,
      onChange: () => {},
    })
    store.ensure('FRA')

    expect(store.state('FRA')).toBe('idle')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('哈希 shapeID 的分块会补一个可读的展示代码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        jsonResponse({
          type: 'FeatureCollection',
          features: [
            {
              id: '9070358B1315543690610',
              properties: { name: 'Oberbayern', parent: 'DEU', level: 'adm2' },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [11, 48],
                    [12, 48],
                    [12, 49],
                    [11, 49],
                  ],
                ],
              },
            },
          ],
        }),
      ),
    )

    const store = new Admin2Store({
      baseUrl: '/',
      index: { countries: { DEU: { units: 1 } } },
      enableRemote: false,
      onChange: () => {},
    })
    store.ensure('DEU')
    await vi.waitFor(() => expect(store.state('DEU')).toBe('ready'))

    expect(store.chunk('DEU')?.features[0]).toMatchObject({
      id: '9070358B1315543690610',
      code: 'DEU-ADM2',
      iso: 'DEU',
    })
  })

  it('返回 HTML 兜底页时标记为 missing，避免反复请求', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => jsonResponse('<!doctype html>', 'text/html')),
    )

    const store = new Admin2Store({
      baseUrl: '/',
      index: { countries: { FRA: { units: 1 } } },
      enableRemote: false,
      onChange: () => {},
    })
    store.ensure('FRA')

    await vi.waitFor(() => expect(store.state('FRA')).toBe('missing'))
    store.ensure('FRA')
    expect(store.state('FRA')).toBe('missing')
  })

  it('retain 只保留可视范围内的国家（LRU 淘汰）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => jsonResponse(chunkPayload)),
    )

    const store = new Admin2Store({
      baseUrl: '/',
      index: {
        countries: { AAA: { units: 1 }, BBB: { units: 1 }, CCC: { units: 1 } },
      },
      enableRemote: false,
      maxCountries: 2,
      onChange: () => {},
    })

    store.ensure('AAA')
    await vi.waitFor(() => expect(store.state('AAA')).toBe('ready'))
    store.ensure('BBB')
    await vi.waitFor(() => expect(store.state('BBB')).toBe('ready'))
    store.ensure('CCC')
    await vi.waitFor(() => expect(store.state('CCC')).toBe('ready'))
    expect(store.loadedCountries).toBe(3)

    store.retain(new Set(['CCC']))
    expect(store.loadedCountries).toBe(2)
    // 最早加载的 AAA 被淘汰，之后可以再次加载
    expect(store.state('AAA')).toBe('idle')
    expect(store.state('CCC')).toBe('ready')
  })
})
