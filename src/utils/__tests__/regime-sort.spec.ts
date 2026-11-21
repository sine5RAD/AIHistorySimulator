import { describe, expect, it } from 'vitest'

import { createEmptyRegimeData } from '@/types/scenario'
import { buildIndexedRegimes, compareRegimeNames } from '../regime-sort'

const makeRegime = (name: string) => {
  const regime = createEmptyRegimeData()
  regime.国家名称 = name
  return regime
}

describe('compareRegimeNames', () => {
  it('按拼音顺序比较中文名称', () => {
    expect(compareRegimeNames('德国', '法国')).toBeLessThan(0)
    expect(compareRegimeNames('中国', '美国')).toBeGreaterThan(0)
  })
})

describe('buildIndexedRegimes', () => {
  it('按拼音排序，同时保留原数组索引', () => {
    const names = ['中国', '美国', '法国', '德国', '日本', '英国', '阿根廷']
    const sorted = buildIndexedRegimes(names.map(makeRegime), 'pinyin')

    expect(sorted.map((entry) => entry.name)).toEqual([
      '阿根廷',
      '德国',
      '法国',
      '美国',
      '日本',
      '英国',
      '中国',
    ])
    expect(sorted.find((entry) => entry.name === '中国')?.index).toBe(0)
    expect(sorted.find((entry) => entry.name === '阿根廷')?.index).toBe(6)
  })

  it('创建顺序模式保持原数组顺序', () => {
    const names = ['中国', '美国', '法国']
    const sorted = buildIndexedRegimes(names.map(makeRegime), 'created')

    expect(sorted.map((entry) => entry.name)).toEqual(names)
    expect(sorted.map((entry) => entry.index)).toEqual([0, 1, 2])
  })

  it('空名称排在最后', () => {
    const regimes = [makeRegime(''), makeRegime('中国'), makeRegime('美国')]
    const sorted = buildIndexedRegimes(regimes, 'pinyin')

    expect(sorted.map((entry) => entry.name)).toEqual(['美国', '中国', '未命名政权'])
    expect(sorted[2]?.isEmptyName).toBe(true)
  })

  it('数字后缀按数值排序', () => {
    const regimes = [makeRegime('新政权 10'), makeRegime('新政权 2')]
    const sorted = buildIndexedRegimes(regimes, 'pinyin')

    expect(sorted.map((entry) => entry.name)).toEqual(['新政权 2', '新政权 10'])
  })
})
