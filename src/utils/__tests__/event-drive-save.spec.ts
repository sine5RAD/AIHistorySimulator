import { describe, expect, it } from 'vitest'

import {
  EVENT_DRIVE_ARCHIVE_KEY,
  EVENT_DRIVE_LAST_WORLD_KEY,
  EVENT_DRIVE_SELECTED_SNAPSHOT_KEY,
  EVENT_DRIVE_SNAPSHOT_HISTORY_KEY,
  WORLD_PACKAGE_TRANSFER_KEY,
  buildEventDriveSaveMap,
  getWorldArchiveKey,
  readActiveEventDriveSave,
  resolveSaveTerritory,
  type EventDriveSaveSnapshot,
  type EventDriveWorldPayload,
} from '../event-drive-save'

const createStorage = (values: Record<string, string>): Pick<Storage, 'getItem'> => ({
  getItem: (key: string) => values[key] ?? null,
})

const createSnapshot = (world: EventDriveWorldPayload): EventDriveSaveSnapshot => ({
  key: '剧本 · 测试 · 1947-01-01T00:00',
  label: '测试存档',
  source: 'archive',
  updatedAt: '2026-11-22T00:00:00.000Z',
  world,
  timeline: null,
})

const createArchiveEntry = (world: EventDriveWorldPayload) => ({
  world,
  countryIndicators: {},
  chatInput: '',
  chatMessages: [],
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
})

describe('世界存档键', () => {
  it('与事件驱动页的命名保持一致', () => {
    expect(getWorldArchiveKey(null)).toBe('')
    expect(
      getWorldArchiveKey({ scenarioName: '1947 开局', scenarioStartTime: '1947-01-01T00:00' }),
    ).toBe('剧本 · 1947 开局 · 1947-01-01T00:00')
    expect(getWorldArchiveKey({ scenarioName: '1947 开局' })).toBe('剧本 · 1947 开局')
    expect(getWorldArchiveKey({ currentCountryName: '中国' })).toBe('中国')
    expect(getWorldArchiveKey({ generatedAt: '2026-11-22T00:00:00.000Z' })).toBe(
      '未命名世界_2026-11-22T00:00:00.000Z',
    )
    expect(getWorldArchiveKey({})).toBe('未命名世界')
  })
})

describe('读取事件驱动当前存档', () => {
  it('没有存档也没有世界包时返回 null', () => {
    expect(readActiveEventDriveSave(createStorage({}), createStorage({}))).toBeNull()
  })

  it('优先使用上次打开的世界键对应的存档条目', () => {
    const world = { scenarioName: '测试', scenarioStartTime: '1947-01-01T00:00' }
    const key = getWorldArchiveKey(world)
    const local = createStorage({
      [EVENT_DRIVE_ARCHIVE_KEY]: JSON.stringify({
        [key]: createArchiveEntry(world),
        另一份世界: createArchiveEntry({ currentCountryName: '另一份世界' }),
      }),
      [EVENT_DRIVE_LAST_WORLD_KEY]: key,
    })

    expect(readActiveEventDriveSave(local, createStorage({}))).toMatchObject({
      key,
      source: 'archive',
      world,
    })
  })

  it('选中的快照覆盖存档条目', () => {
    const local = createStorage({
      [EVENT_DRIVE_ARCHIVE_KEY]: JSON.stringify({
        '剧本 · 旧世界': createArchiveEntry({ scenarioName: '旧世界' }),
      }),
      [EVENT_DRIVE_LAST_WORLD_KEY]: '剧本 · 旧世界',
      [EVENT_DRIVE_SELECTED_SNAPSHOT_KEY]: 'snapshot-1',
      [EVENT_DRIVE_SNAPSHOT_HISTORY_KEY]: JSON.stringify([
        {
          id: 'snapshot-1',
          label: '旧世界 · 1948',
          world: { scenarioName: '快照世界' },
          createdAt: '2026-11-22T01:00:00.000Z',
        },
      ]),
    })

    expect(readActiveEventDriveSave(local, createStorage({}))).toMatchObject({
      key: 'snapshot-1',
      label: '旧世界 · 1948',
      source: 'snapshot',
      world: { scenarioName: '快照世界' },
    })
  })

  it('选中空快照时不再显示任何存档', () => {
    const local = createStorage({
      [EVENT_DRIVE_ARCHIVE_KEY]: JSON.stringify({
        '剧本 · 旧世界': createArchiveEntry({ scenarioName: '旧世界' }),
      }),
      [EVENT_DRIVE_SELECTED_SNAPSHOT_KEY]: 'snapshot-1',
      [EVENT_DRIVE_SNAPSHOT_HISTORY_KEY]: JSON.stringify([
        { id: 'snapshot-1', label: '空快照', world: null },
      ]),
    })

    expect(readActiveEventDriveSave(local, createStorage({}))).toBeNull()
  })

  it('没有存档时退回当前世界包', () => {
    const world = { source: 'world-generator', currentCountryName: '测试世界' }
    const local = createStorage({
      [WORLD_PACKAGE_TRANSFER_KEY]: JSON.stringify(world),
    })

    expect(readActiveEventDriveSave(local, createStorage({}))).toMatchObject({
      label: '测试世界',
      source: 'package',
      world,
    })
  })

  it('世界包对应存档条目时优先用存档里的最新版本', () => {
    const world = { scenarioName: '测试', scenarioStartTime: '1947-01-01T00:00' }
    const key = getWorldArchiveKey(world)
    const local = createStorage({
      [WORLD_PACKAGE_TRANSFER_KEY]: JSON.stringify(world),
      [EVENT_DRIVE_ARCHIVE_KEY]: JSON.stringify({
        [key]: createArchiveEntry({ ...world, scenarioName: '存档里的新名字' }),
      }),
    })

    expect(readActiveEventDriveSave(local, createStorage({}))).toMatchObject({
      key,
      source: 'archive',
      world: { scenarioName: '存档里的新名字' },
    })
  })
})

describe('解析存档领土', () => {
  it('按级别读取编号、颜色、名称与国家代码', () => {
    const map = buildEventDriveSaveMap(
      createSnapshot({
        countries: [
          {
            国家名称: '中国',
            代表色: '#d64545',
            领土: {
              总数: 3,
              country: ['MNG'],
              adm2: ['440100', '810001'],
            },
          },
          {
            国家名称: '美国',
            领土: { adm1: ['US-MS'] },
          },
        ],
        countryColorMap: { 中国: '#ff0000' },
        territoryNames: { '440100': '广州市' },
        territoryCountries: { '440100': 'CHN', '810001': 'HKG', 'US-MS': 'USA' },
      }),
    )

    expect(map.units).toHaveLength(4)
    expect(map.hasSubCountryUnits).toBe(true)
    expect(map.unknownSubCountryCountry).toBe(false)
    expect(map.units[0]).toMatchObject({
      regimeName: '中国',
      color: '#ff0000',
      code: 'MNG',
      level: 'country',
      countryCode: 'MNG',
    })
    expect(map.units[1]).toMatchObject({
      code: '440100',
      level: 'adm2',
      countryCode: 'CHN',
      name: '广州市',
    })
    expect(map.units[3]).toMatchObject({
      regimeName: '美国',
      code: 'US-MS',
      level: 'adm1',
      countryCode: 'USA',
    })
    expect(map.byKey.get('440100|CHN')?.name).toBe('广州市')
    expect(map.byKey.get('US-MS|USA')?.regimeName).toBe('美国')
    expect(map.regimes.map((regime) => regime.name)).toEqual(['中国', '美国'])
  })

  it('兼容旧存档的数组写法与自定义区域', () => {
    const map = buildEventDriveSaveMap(
      createSnapshot({
        countries: [
          {
            国家名称: '阿特兰蒂斯',
            代表色: '#123456',
            领土: [
              {
                名称: '本岛',
                代码: 'CHN',
                级别: 'country',
                国家代码: 'CHN',
                区域: [
                  [
                    [100, 20],
                    [110, 20],
                    [110, 30],
                    [100, 20],
                  ],
                ],
              },
            ],
          },
        ],
      }),
    )

    expect(map.units).toHaveLength(1)
    expect(map.units[0]?.code).toBe('CHN')
    expect(map.areaGroups).toHaveLength(1)
    expect(map.areaGroups[0]?.color).toBe('#123456')
    expect(map.areaGroups[0]?.areas[0]?.vertices).toEqual([
      [100, 20],
      [110, 20],
      [110, 30],
      [100, 20],
    ])
    expect(map.areaGroups[0]?.feature).toMatchObject({
      name: '阿特兰蒂斯',
      level: 'country',
      bounds: { minLng: 100, maxLng: 110, minLat: 20, maxLat: 30 },
    })
    expect(map.areaGroups[0]?.feature.polygons[0]?.[0]).toHaveLength(4)
  })

  it('把世界生成的手绘国土从墨卡托坐标换算成经纬度', () => {
    const map = buildEventDriveSaveMap(
      createSnapshot({
        world: {
          countries: [{ 国家名称: '海洋国' }],
          countryColorMap: { 海洋国: '#00aaff' },
          landMap: {
            海洋国: {
              areas: [
                {
                  vertices: [
                    [0.5, 0.5],
                    [0.6, 0.5],
                    [0.6, 0.4],
                    [0.5, 0.5],
                  ],
                },
              ],
            },
          },
        },
      }),
    )

    expect(map.areaGroups).toHaveLength(1)
    expect(map.areaGroups[0]).toMatchObject({
      regimeName: '海洋国',
      color: '#00aaff',
      feature: { name: '海洋国' },
    })
    const vertices = map.areaGroups[0]?.areas[0]?.vertices ?? []
    expect(vertices[0]?.[0]).toBeCloseTo(0, 5)
    expect(vertices[0]?.[1]).toBeCloseTo(0, 5)
    expect(vertices[1]?.[0]).toBeCloseTo(36, 5)
    expect(vertices[1]?.[1]).toBeCloseTo(0, 5)
    expect(vertices[2]?.[0]).toBeCloseTo(36, 5)
    expect(vertices[2]?.[1]).toBeGreaterThan(0)
    expect(map.areaGroups[0]?.bounds.maxLng).toBeCloseTo(36, 5)
  })

  it('同名编号按国家代码区分，不会串到邻国', () => {
    const map = buildEventDriveSaveMap(
      createSnapshot({
        countries: [
          {
            国家名称: '苏丹',
            领土: { adm1: ['N/A'] },
          },
        ],
        territoryCountries: { 'N/A': 'SDN' },
      }),
    )

    expect(resolveSaveTerritory(map, 'N/A', 'SDN')?.regimeName).toBe('苏丹')
    expect(resolveSaveTerritory(map, 'N/A', 'LBN')).toBeNull()
  })

  it('旧存档没有国家代码时按编号兜底匹配', () => {
    const map = buildEventDriveSaveMap(
      createSnapshot({
        countries: [
          {
            国家名称: '旧存档政权',
            领土: { adm1: ['N/A'] },
          },
        ],
      }),
    )

    expect(map.unknownSubCountryCountry).toBe(true)
    expect(resolveSaveTerritory(map, 'N/A', 'SDN')?.regimeName).toBe('旧存档政权')
    expect(resolveSaveTerritory(map, 'N/A', 'LBN')?.regimeName).toBe('旧存档政权')
  })
})
