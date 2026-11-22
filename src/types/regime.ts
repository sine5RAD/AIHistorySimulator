import type { CountryIndicatorData } from './country'
import type { LeaderData } from './scenario'

/**
 * 推演中的政权变更。
 *
 * 四种基本动作，其它形态都用它们组合出来：
 * - 「建立」：新建一个政权。带 `原政权` 表示从该政权分裂/独立，`领土` 里的编号会从原政权划走。
 * - 「灭亡」：删除一个政权，并用 `继承` / `继承国` / `领土分配` 说明领土去向。
 * - 「更名」：政权存续但改旗易帜，领土与指标不变。
 * - 「领土」：在两个已存在的政权之间划转领土，用于政权更替后给新政权补地、割地、占领。
 *
 * 于是：
 * - 合并 = 对被合并的每个政权各发一条「灭亡」，`继承国` 指向保留的那个；
 * - 分裂 = 一条「建立」（`原政权` = 母国，`领土` = 划走的部分）；
 * - 政权更替 = 先「建立」新政权，再「灭亡」旧政权且 `继承国` 指向新政权。
 */
export type RegimeChangeKind = '建立' | '灭亡' | '更名' | '领土'

/** 「灭亡」之后领土的归属方式。 */
export type RegimeSuccession = '无主' | '继承国'

/**
 * 领土摘要。
 *
 * 与 `compactRegime` 产出的结构一致：按级别保存编号数组，
 * 自定义多边形只保留数量（顶点无法通过编号迁移）。
 * 也兼容旧存档里的 `[{ 名称, 代码, 级别, 区域? }]` 数组写法。
 */
export interface RegimeTerritorySummary {
  总数?: number
  country?: string[]
  adm1?: string[]
  adm2?: string[]
  adm3?: string[]
  unknown?: string[]
  自定义区域数量?: number
}

/**
 * 一条政权变更。
 *
 * `政权名称` 的语义随 `类型` 变化：
 * - 「建立」：新建政权的名称；
 * - 「灭亡」/「更名」：被操作的现有政权名称。
 */
export interface RegimeChangeData {
  类型: RegimeChangeKind
  政权名称: string
  /** 仅「更名」使用：变更后的名称。 */
  新名称?: string
  /** 仅「建立」使用：新政权的来源政权（分裂、独立、附属国转正等）。 */
  原政权?: string
  /** 仅「领土」使用：领土的出让方。 */
  来源政权?: string
  原因?: string
  /** 推演出的日期文本；时间线用它定位事件发生的具体时间。 */
  日期?: string
  /** 事件实际发生日期；优先于 `日期`，格式如 `1948-03-15`。 */
  时间?: string
  政体?: string
  政治制度?: string
  经济状况?: string
  代表色?: string
  AI控制?: boolean
  领导人?: LeaderData[]
  国家指标?: CountryIndicatorData
  /** 仅「灭亡」使用。缺省按「无主」处理。 */
  继承?: RegimeSuccession
  /** 仅「灭亡」使用。`继承` 为「继承国」时至少需要一个。 */
  继承国?: string[]
  /**
   * 仅「灭亡」使用：把具体编号分割给不同继承国。
   * 未出现在这里的编号会被丢弃（视为无主）。
   */
  领土分配?: Record<string, RegimeTerritorySummary>
  /** 「建立」的新政权初始领土；「领土」的划转范围（省略表示划走来源政权的全部领土）。 */
  领土?: RegimeTerritorySummary
  /** AI 给出的自检结论，只用于展示。 */
  校验?: string
}

/**
 * 一条已经成功应用的政权变更。
 *
 * 与原始输入的 `RegimeChangeData` 不同，这里的字段是**落库后的实际值**：
 * - `代表色` 与 `国家指标` 取变更完成后的颜色 / 指标（灭亡时取灭亡前的值）；
 * - `继承国` 只保留真正接管了领土的政权，`无主` 灭亡时为空。
 *
 * 时间线等模块只消费这个结构，不需要再猜「哪些变更生效了」。
 */
export interface AppliedRegimeChange {
  类型: RegimeChangeKind
  政权名称: string
  新名称?: string
  继承国?: string[]
  原因?: string
  /** 事件实际发生日期，时间线用它定位分叉 / 灭亡点。 */
  时间?: string
  /** 旧字段，兼容仍然只写 `日期` 的回复。 */
  日期?: string
  代表色?: string
  国家指标?: CountryIndicatorData
}

/** 允许的变更类型，供解析与校验共用。 */
export const REGIME_CHANGE_KINDS = ['建立', '灭亡', '更名', '领土'] as const

/** 判断一个未知值是否像一条政权变更（只看 `类型`）。 */
export const isRegimeChangeKind = (value: unknown): value is RegimeChangeKind =>
  typeof value === 'string' && (REGIME_CHANGE_KINDS as readonly string[]).includes(value.trim())

/** 政权存续提示：用于侧栏与「当前剧本」卡片的计数说明。 */
export interface RegimeChangeOutcome {
  政权名称: string
  类型: RegimeChangeKind
  /** 人类可读摘要，直接推送到聊天窗口。 */
  summary: string
}
