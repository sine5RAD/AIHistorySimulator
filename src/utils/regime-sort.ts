import type { RegimeData } from '@/types/scenario'

export type RegimeSortMode = 'pinyin' | 'created'

export interface IndexedRegime {
  regime: RegimeData
  /** 原数组下标，用于选择/编辑；排序不能改变它 */
  index: number
  /** 展示名称，空名称回退为「未命名政权」 */
  name: string
  /** 空名称统一排在最后 */
  isEmptyName: boolean
}

/** zh-Hans-CN 的默认排序即拼音序，numeric 让「新政权 2」排在「新政权 10」前。 */
const collator = new Intl.Collator('zh-Hans-CN', {
  sensitivity: 'base',
  numeric: true,
})

export const compareRegimeNames = (a: string, b: string): number => collator.compare(a, b)

/**
 * 生成用于政权列表展示的数组。
 *
 * 排序只影响左侧列表显示，`index` 仍指向原数组，
 * 因此导出 JSON 的顺序、编辑/删除/当前选中项都不会被打乱。
 */
export function buildIndexedRegimes(
  regimes: RegimeData[],
  mode: RegimeSortMode = 'pinyin',
): IndexedRegime[] {
  const entries: IndexedRegime[] = regimes.map((regime, index) => {
    const rawName = regime.国家名称.trim()

    return {
      regime,
      index,
      name: rawName || '未命名政权',
      isEmptyName: rawName.length === 0,
    }
  })

  if (mode === 'created') {
    return entries
  }

  return entries.sort((a, b) => {
    if (a.isEmptyName !== b.isEmptyName) {
      return a.isEmptyName ? 1 : -1
    }

    return compareRegimeNames(a.name, b.name) || a.index - b.index
  })
}
