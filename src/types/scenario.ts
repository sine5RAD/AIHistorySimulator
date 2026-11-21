import type { CountryData, CountryIndicatorData } from './country'
import { createEmptyCountryData } from './country'
import type { Area } from './land'

/**
 * 政权领导人。
 *
 * 一国的领导人不一定是单人：君主、首相、总书记、最高领袖都可能同时存在，
 * 所以这里用数组保存，并保留职位与简介，方便事件推演时引用具体人物。
 */
export interface LeaderData {
  姓名: string
  职位: string
  简介: string
}

/**
 * 政权领土条目。
 *
 * 三种来源可以混用：
 * - `代码`：内置世界地图的要素编号。国家用 ISO3，下级行政区用地区编号
 *   （中国 adcode、ISO 3166-2 等），渲染时按地图数据解析；
 * - `国家代码`：下级行政区所属国家的 ISO3，用于按国家加载行政区数据；
 * - `区域`：自定义多边形，坐标统一为 `[经度, 纬度]`，用于架空地图或世界生成里的手绘国土。
 */
export type TerritoryLevel = 'country' | 'adm1' | 'adm2' | 'adm3'

export interface TerritoryData {
  名称: string
  代码?: string
  国家代码?: string
  级别?: TerritoryLevel
  区域?: Area[]
}

/**
 * 剧本中的一个政权。
 *
 * 字段是「文章转 JSON」里 `CountryData` 的超集：AI 生成的国家档案可以直接
 * 作为政权导入，剧本额外关心的代表色、政体、领导人、领土与初始国家力量
 * 都挂在同一层，导出后仍然是一个可直接阅读的政权 JSON。
 */
export interface RegimeData extends CountryData {
  代表色: string
  政体: string
  领导人: LeaderData[]
  领土: TerritoryData[]
  初始国家力量: CountryIndicatorData
}

/**
 * 剧本文件（剧本.json）。
 *
 * 最小结构就是：开局时间 + 存在国家（每个国家带领土列表）。
 */
export interface ScenarioData {
  剧本名称: string
  开局时间: string
  存在国家: RegimeData[]
}

/** 政体下拉建议项；用户仍然可以输入任意自定义政体。 */
export const governmentFormOptions = [
  '君主制',
  '君主立宪制',
  '共和制',
  '联邦制',
  '单一制',
  '总统制',
  '议会制',
  '半总统制',
  '社会主义共和制',
  '共产主义',
  '神权政治',
  '军政府',
  '寡头制',
  '一党制',
  '多党制',
  '城邦制',
  '部落联盟',
  '殖民统治',
  '傀儡政权',
  '临时政府',
  '无政府状态',
] as const

/** 政权代表色预设。 */
export const regimeColorPresets = [
  '#d64545',
  '#e07a35',
  '#d9b13b',
  '#7aa84a',
  '#3f9e83',
  '#3b82f6',
  '#6d5bd0',
  '#c2417d',
  '#8a8f98',
  '#e5e7eb',
] as const

export const DEFAULT_REGIME_COLOR = '#3b82f6'

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 生成 `<input type="datetime-local">` 可直接使用的本地时间文本。 */
export const formatDateTimeLocal = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`

export const createEmptyLeaderData = (): LeaderData => ({
  姓名: '',
  职位: '',
  简介: '',
})

export const createEmptyRegimeData = (color: string = DEFAULT_REGIME_COLOR): RegimeData => {
  const country = createEmptyCountryData()

  return {
    ...country,
    代表色: color,
    政体: '',
    领导人: [],
    领土: [],
    初始国家力量: { ...country.国家指标 },
  }
}

export const createEmptyScenarioData = (): ScenarioData => ({
  剧本名称: '新剧本',
  开局时间: formatDateTimeLocal(new Date()),
  存在国家: [],
})
