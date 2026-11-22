# AIHistorySimulator 接口文档

## 项目概述

AIHistorySimulator 是一个基于 Vue 3 + TypeScript 构建的架空历史事件推演应用，整合了 AI 模型能力，可以生成结构化的国家数据、世界地图可视化，以及进行多轮事件驱动对话。

---

## 页面接口

### 1. 首页 (pages/index)

**路由**: `/pages/index` 或 `/`  
**用途**: 应用使用教程和流程导航入口

#### 主要内容

- 推荐使用顺序指引（5步流程）
- 各页面的详细说明卡片
- 用户流程规范化指导

#### 关键组件

- `IndexTutorialPage` 组件
- 纯静态展示，无动态接口

---

### 2. 设置页面 (pages/local-setting)

**路由**: `/pages/setting` 或 `/pages/local-setting`  
**用途**: 统一管理 AI 提供商、API、模型和提示词配置

#### 主要功能函数

##### `saveAiSettings()`

- **用途**: 保存 AI 设置到 localStorage
- **参数**: 无（使用组件内 ref 值）
- **返回值**: void
- **保存项**:
  - `provider`: 模型提供商（OpenAI / DeepSeek / Qwen / Anthropic / OpenCode Go）
  - `api`: API 密钥
  - `model`: 选中的模型名称

##### `savePrompts()`

- **用途**: 保存自定义提示词模板到 localStorage
- **参数**: 无
- **返回值**: void
- **保存键**:
  - `prompt-text-to-json`: 文本转 JSON 提示词
  - `prompt-event-drive`: 事件驱动提示词

##### `resetTextToJsonPrompt()`

- **用途**: 重置文本转 JSON 提示词为默认值
- **参数**: 无
- **返回值**: void

##### `resetEventDrivePrompt()`

- **用途**: 重置事件驱动提示词为默认值
- **参数**: 无
- **返回值**: void

##### `resizeTextarea(textarea: HTMLTextAreaElement | null)`

- **用途**: 自动调整 textarea 高度以适应内容
- **参数**: textarea 元素引用
- **返回值**: void

#### 配置数据结构

```typescript
interface AiSettings {
  provider: 'OpenAI' | 'DeepSeek' | 'Qwen' | 'Anthropic' | 'OpenCode Go'
  api: string
  model: string
}
```

#### 支持的模型列表

```
OpenAI: gpt-4.1-mini, gpt-4.1, gpt-4o-mini
DeepSeek: deepseek-chat, deepseek-reasoner, deepseek-v4-flash, deepseek-v4-pro
Qwen: qwen-plus, qwen-max, qwen-turbo
Anthropic: claude-3-5-sonnet-latest, claude-3-5-haiku-latest
OpenCode Go: deepseek-v4.1-flash, deepseek-v4-pro, glm-5.3, glm-5.3-flash, kimi-k3,
             kimi-k2.7-code, qwen3.8-max, qwen3.8-flash, minimax-m3.1-flash, hy4
```

---

### 3. 文本转 JSON 页面 (pages/text-to-json)

**路由**: `/pages/text-to-json`  
**用途**: 将自然语言文本转换为结构化国家数据 JSON，支持文件导入和数据校验

#### 主要功能函数

##### `normalizeJsonText(text: string): string`

- **用途**: 规范化 JSON 文本（清理 markdown 代码块，格式化缩进）
- **参数**: 原始 JSON 字符串
- **返回值**: 格式化后的 JSON 字符串或原始文本
- **处理**:
  - 自动移除 markdown 代码块符号 (` ``` `)
  - JSON 格式验证和美化

##### `createJsonFileName(): string`

- **用途**: 基于上传文件名生成 JSON 输出文件名
- **参数**: 无（使用 `selectedFile.value`）
- **返回值**: 带 `.json` 扩展名的文件名

##### `validatePopulation(p: unknown, path?: string): string[]`

- **用途**: 校验人口数据结构
- **参数**:
  - `p`: 待校验的人口对象
  - `path`: 错误消息的路径前缀
- **返回值**: 错误消息数组（空数组表示通过）
- **检验项**:
  - `总数` 必须为 number
  - `种族比例` 必须为对象

##### `validateCity(c: unknown, path?: string): string[]`

- **用途**: 校验单个城市数据结构
- **参数**: 城市对象和路径前缀
- **返回值**: 错误消息数组
- **检验项**:
  - `名称`: string
  - `简介`: string
  - `人口比例`: object
  - `经济状况`: string
  - `政治状况`: string

##### `validateMilitary(m: unknown, path?: string): string[]`

- **用途**: 校验武装力量数据
- **参数**: 武装力量对象
- **返回值**: 错误消息数组
- **检验项**:
  - `名称`, `规模`, `兵役制度`: string
  - `军种`: array

##### `validateDefinition(d: unknown, path?: string): string[]`

- **用途**: 校验名词定义数据
- **参数**: 定义对象
- **返回值**: 错误消息数组
- **检验项**:
  - `术语`: string
  - `定义`: string

##### `validatePolitical(p: unknown, path?: string): string[]`

- **用途**: 校验政治制度数据
- **参数**: 政治对象
- **返回值**: 错误消息数组
- **递归检验**: 联盟数据

##### `validateTechnology(t: unknown, path?: string): string[]`

- **用途**: 校验科技领域数据
- **参数**: 科技对象
- **返回值**: 错误消息数组
- **检验字段**: 重工业、轻工业、第三产业、航天工业、信息产业、农业

##### `validateEthnicGroup(e: unknown, path?: string): string[]`

- **用途**: 校验种族数据
- **参数**: 种族对象
- **返回值**: 错误消息数组

##### `validateCountry(c: unknown, path?: string): string[]`

- **用途**: 完整校验整个国家数据结构
- **参数**: 国家对象
- **返回值**: 错误消息数组
- **全面检查**: 调用所有子校验函数

#### 数据流程

```
文件导入 → 文件内容解析 → 提示词准备 → 提交到 AI 模型
→ JSON 输出 → 规范化格式 → 结构校验 → 导出/复制结果
```

---

### 4. 世界观生成器 (pages/world-generator)

**路由**: `/pages/world-generator`  
**用途**: 维护国家、国土与世界地图数据，形成可用于推演的世界状态；提供 3D 球体地图可视化

#### 主要功能函数

##### 国家与国土管理

###### `setCountryLand(countryName: string, land: LandData): void`

- **用途**: 为指定国家设置国土数据
- **参数**:
  - `countryName`: 国家名称
  - `land`: 国土数据对象
- **返回值**: void

###### `getCountryLand(countryName: string): LandData`

- **用途**: 获取指定国家的国土数据（不存在则创建空数据）
- **参数**: 国家名称
- **返回值**: LandData 对象
- **特性**: 自动创建不存在的条目

###### `peekCountryLand(countryName: string): LandData | null`

- **用途**: 查看指定国家的国土数据（只读，不创建新条目）
- **参数**: 国家名称
- **返回值**: LandData 或 null

###### `removeCountryLand(countryName: string): void`

- **用途**: 删除指定国家的国土数据
- **参数**: 国家名称
- **返回值**: void

###### `listCountryLands(): Record<string, LandData>`

- **用途**: 获取所有国家的国土数据副本
- **参数**: 无
- **返回值**: 国家名称到国土数据的映射对象

##### 颜色管理

###### `hashCountryName(countryName: string): number`

- **用途**: 根据国家名称计算哈希值
- **参数**: 国家名称
- **返回值**: 无符号 32 位整数
- **用途**: 用于生成确定性颜色

###### `createCountryColor(countryName: string): string`

- **用途**: 根据国家名称生成确定性的 HSL 颜色
- **参数**: 国家名称
- **返回值**: HSL 颜色字符串（如 `hsl(120 60% 50%)`）
- **特性**:
  - 同一国家名称总是生成相同颜色
  - 颜色饱和度和亮度随机波动

###### `getCountryColor(countryName: string): string`

- **用途**: 获取指定国家的颜色（若不存在则使用默认色）
- **参数**: 国家名称
- **返回值**: CSS 颜色字符串

###### `setCountryColor(countryName: string, color: string): void`

- **用途**: 设置指定国家的自定义颜色
- **参数**:
  - `countryName`: 国家名称
  - `color`: CSS 颜色值（如 `#FF5733` 或 `rgb(255, 87, 51)`）
- **返回值**: void
- **触发**: 重新渲染地球

###### `updateCurrentCountryColorChannel(channel: 'r' | 'g' | 'b', value: number): void`

- **用途**: 调整当前国家颜色的单个 RGB 通道值
- **参数**:
  - `channel`: 红、绿、蓝通道之一
  - `value`: 0-255 的通道值
- **返回值**: void
- **效果**: 调整后立即更新球体渲染

###### `withColorAlpha(color: string, alpha: number): string`

- **用途**: 为颜色字符串添加透明度
- **参数**:
  - `color`: CSS 颜色
  - `alpha`: 0-1 的透明度值
- **返回值**: 带透明度的 CSS 颜色字符串

###### `parseCssColorToRgb(color: string): RgbColor`

- **用途**: 解析 CSS 颜色为 RGB 对象
- **参数**: CSS 颜色字符串
- **返回值**: `{r, g, b}` 对象（0-255 范围）
- **支持**: HSL、RGB、十六进制格式

##### 世界数据持久化

###### `saveWorldDraft(): void`

- **用途**: 将当前世界数据保存到 sessionStorage
- **参数**: 无
- **返回值**: void
- **保存键**: `worldDataDraft`
- **包含**: 国家、地图、国土、颜色映射等

###### `restoreWorldDraft(draft: unknown): void`

- **用途**: 从草稿数据恢复世界状态
- **参数**: 草稿对象（通常来自 sessionStorage）
- **返回值**: void

##### 3D 球体渲染

###### `renderWorldGlobe(): void`

- **用途**: 渲染 3D 地球球体
- **参数**: 无
- **返回值**: void
- **技术**: Canvas 2D + 旋转投影
- **性能**: 使用 requestAnimationFrame 节流

###### `scheduleRenderWorldGlobe(): void`

- **用途**: 调度地球重新渲染（防止高频多次渲染）
- **参数**: 无
- **返回值**: void
- **机制**: 使用定时器确保渲染效率

##### 交互与拖拽

- **旋转**: 鼠标拖动改变 `rotation` (经度) 和 `tilt` (纬度)
- **状态**: `isDragging`, `dragStartX`, `dragStartY` 等跟踪交互状态
- **指针**: 支持 `pointerdown`, `pointermove`, `pointerup` 事件

##### 数据结构

```typescript
interface WorldData {
  countries: CountryData[]
  worldMapImage?: unknown
  // ... 其他字段
}

interface LandData {
  // 国土形状、坐标等信息
}

interface RgbColor {
  r: number
  g: number
  b: number
}
```

---

### 5. 剧本编辑页面 (pages/scenario-editor)

**路由**: `/pages/scenario-editor`  
**用途**: 配置开局时间与存在国家，编辑每个政权的代表色、政体、领导人、领土与初始国家力量

#### 主要功能

- 剧本 JSON 导入/导出与本地自动保存（`scenario-editor-draft`）
- 「发送至推演」把完整剧本写入 `event-drive-scenario-json`（sessionStorage）并跳转事件驱动页；
  推演页优先于世界包读取该交接内容，每轮默认注入**国家简报**（名称、`AI控制`、三国力、政体、政治制度、
  经济状况、领导人姓名/职位、人口与领土摘要），只有消息中提到某国时才追加该国**详细档案**
  （领导人简介、城市、科技、武装力量等，领土仍用摘要）；交接键读取后立即清除，避免下次打开覆盖后续聊天
- 「发送至 AI」使用精简审核版：省略空字段、重复的国家指标和地区名称，领土按级别只保留编号；
  80 政权 / 4,465 块领土约 4.1 万 tokens，避免完整 JSON（约 22 万 tokens）超出模型上下文；
  请求失败时显示真实 HTTP 状态与服务端错误，不再只显示「没有返回有效内容」
- 当前接入 OpenAI / DeepSeek / OpenCode Go；Qwen / Anthropic 尚未接入，会在发送前明确提示
- 政权列表默认按拼音排序，可切换为创建顺序；排序只影响列表显示，不改变数组/导出顺序
- 新建/复制/删除政权；代表色支持取色器、预设与 `#RRGGBB` 文本
- 「政权设定」顶部提供「玩家操控国家」复选框，勾选写入 `AI控制: false`，不勾选为 `AI控制: true`；
  新建政权默认由 AI 操控，政权列表与统计栏会标记玩家政权
- 「发送至 AI」按钮：把当前剧本（`serializeScenarioForExport` 的结果）作为 JSON 上下文发给设置页配置的模型，
  使用 `defaultScenarioReviewPrompt` 审校剧本并给出开局推演，回复直接显示在页面顶部（可复制 / 收起）
- 政体建议下拉 + 自定义输入
- 领导人列表（姓名 / 职位 / 简介，支持上下移动）
- 初始国家力量三维度滑块（-100 ~ 100），同步写入 `国家指标`
- 领土只在「地区」粒度编辑：放大到 2.4 倍后自动加载并显示下级行政区，点击单个行政区即可划入或移出，
  逐个记录地区编号（中国 adcode、ISO 3166-2 等）
- 领土以「代码 + 国家代码」唯一标识，源数据里的 `N/A` 等重复编号（Abyei / Keserwan-Jbeil）不会串到同一块图
- 领土地图最高 200×，右下角提供 `+ / − / 重置`；小地块（如摩纳哥的 9 个区）也能点中
- 点选国家本身不会产生领土：低倍率点击只提示缩放，该国没有下级行政区数据时也会给出提示
- 从导入数据继承的整国编号（ISO3）领土保留在列表与地图上，可单独删除，但不能再通过地图新增
- 从世界生成草稿 / 世界 JSON 导入国家与手绘国土（墨卡托纹理坐标自动转经纬度）
- 国家档案导入 / 导出：兼容文章转 JSON 的 `CountryData` 与本页导出的 `.regime.json`
- 实时校验：缺少开局时间、未命名政权、重复名称、重复代表色、无领土/政体等

#### 数据结构

```typescript
interface ScenarioData {
  剧本名称: string
  开局时间: string
  存在国家: RegimeData[]
}

interface RegimeData extends CountryData {
  代表色: string
  政体: string
  领导人: Array<{ 姓名: string; 职位: string; 简介: string }>
  领土: Array<{
    名称: string
    代码?: string // 地区编号：ISO3 / 中国 adcode / ISO 3166-2
    国家代码?: string // 下级行政区所属国家 ISO3
    级别?: 'country' | 'adm1' | 'adm2' | 'adm3'
    区域?: Array<{ vertices: [number, number][] }> // 自定义多边形，[经度, 纬度]
  }>
  初始国家力量: { 政治稳定: number; 经济发展: number; 国际影响: number }
}
```

#### 关键模块

- `src/types/scenario.ts`：剧本 / 政权 / 领导人 / 领土类型与默认值
- `src/utils/scenario-data.ts`：规范化、世界数据转换、导入导出
- `src/lib/map/territory-code.ts`：国家 / 地区编号的统一算法
- `src/composables/territory-map.ts`：领土地图选择（复用世界地图的投影、几何与行政区加载逻辑）
- `src/pages/scenario-editor/scenario-editor.vue`：页面与交互

#### localStorage 键

| 键名                        | 用途                           |
| --------------------------- | ------------------------------ |
| `scenario-editor-draft`     | 剧本草稿（自动保存）           |
| `scenario-editor-import`    | 文章转 JSON 的一次性交接数据   |
| `event-drive-scenario-json` | 「发送至推演」的剧本交接数据   |
| `worldDataDraft`            | 世界生成草稿（读取后转换领土） |

#### 与文章转 JSON 的衔接

文章转 JSON 页面校验通过后可点击「发送至剧本」，把 `CountryData` 写入 `scenario-editor-import` 并跳转；
剧本编辑页会在已有剧本中追加为新政权，空剧本时直接载入。

#### 与 AI 的衔接

「发送至 AI」使用 `readAiSettingsFromStorage()` 读取设置页的提供商 / API / 模型，
把 `serializeScenarioForExport(scenario)` 的 JSON 交给 `submitPreparedPrompt()`，
系统提示词为 `defaultScenarioReviewPrompt`。回复只保存在页面状态中，不写入草稿或剧本 JSON；
切换 / 新建 / 导入剧本时会清空旧回复，避免把上一次的审校结果当成当前剧本的结论。

#### 与事件驱动的衔接

「发送至推演」调用 `createScenarioTransferPayload(scenario)` 生成
`{ source: 'scenario-editor', sentAt, scenario }`，写入 `event-drive-scenario-json`
并设置 `event-drive-fresh-session`，然后 `router.push({ name: 'event-drive' })`。

事件驱动页在挂载时用 `parseScenarioTransferPayload()` 读取并校验（没有政权时视为无效），
再用 `compactRegimeForEventDrive()` 生成完整的精简国家档案，存入
`WorldLandTransferPayload.countries` 作为按需详情的数据源，同时把 `剧本名称` / `开局时间`
存到 `scenarioName` / `scenarioStartTime`。每轮请求时：

- `toBriefCountry()` 生成国家简报（约 1.4 万 tokens / 80 政权）；
- `matchCountryNamesInText()` 从本轮消息中找出国家名；
- `toDetailCountry()` 只给提到的国家附加详细档案（约 500 tokens / 国），领土统一压缩成摘要。

该世界包会像普通世界包一样写入存档与快照，因此刷新页面或重新选择归档后仍能恢复；
读取成功后交接键会被清除。

---

### 6. 事件驱动页面 (pages/event-drive)

**路由**: `/pages/event-drive`  
**用途**: 在世界背景下进行连续多轮对话，推演历史事件发展，支持存档与快照

挂载时会优先读取 `event-drive-scenario-json`（剧本编辑页「发送至推演」），把它转换成
`countries` 世界包；没有交接数据时再按原来的世界包 / 存档逻辑恢复。剧本来源会在侧栏显示
「当前剧本」卡片；每轮请求注入国家简报，消息提到具体国家时再追加该国详细档案。

#### 主要功能函数

##### 对话与消息处理

###### `sendMessage(): Promise<void>`

- **用途**: 发送用户消息到 AI 模型并获取回复
- **参数**: 无（使用 `chatInput.value`）
- **返回值**: Promise（异步等待响应）
- **副作用**:
  - 将消息添加到 `chatMessages`
  - 设置 `isSending = true` 期间请求
  - 自动滚动聊天窗口到底部

###### `scrollToBottom(): Promise<void>`

- **用途**: 平滑滚动聊天历史到最底部
- **参数**: 无
- **返回值**: Promise（nextTick）
- **行为**: 使用 `smooth` 滚动动画

##### 存档与快照管理

###### `readEventDriveArchive(): EventDriveArchive`

- **用途**: 从 localStorage 读取事件驱动聊天存档
- **参数**: 无
- **返回值**: 存档对象（国家名称 → 存档条目）
- **存档键**: `event-drive-world-chat-archive-json`
- **数据验证**: 自动过滤无效消息

###### `getWorldArchiveKey(payload: WorldLandTransferPayload | null): string`

- **用途**: 为世界数据生成存档键（以国家名称或时间戳为基础）
- **参数**: 世界加载数据
- **返回值**: 存档键字符串
- **优先级**: 国家名称 > 时间戳 > "未命名世界"

###### `createSnapshot(): void`

- **用途**: 创建当前对话的快照
- **参数**: 无
- **返回值**: void
- **快照包含**:
  - 世界状态
  - 当前对话内容
  - 创建时间戳

###### `restoreSnapshot(snapshotId: string): void`

- **用途**: 恢复指定快照的对话状态
- **参数**: 快照 ID
- **返回值**: void

##### 世界数据传递

###### `receiveWorldPackage(payload: WorldLandTransferPayload): void`

- **用途**: 接收来自 world-generator 页面的世界数据包
- **参数**: 世界加载数据
- **返回值**: void
- **来源**: session/local storage

##### UI 辅助

###### `goToSetting(): void`

- **用途**: 导航到设置页面
- **参数**: 无
- **返回值**: void

#### 类型定义

```typescript
type ChatRole = 'user' | 'assistant'
type PromptRole = 'user' | 'assistant' | 'system'

interface PromptMessage {
  role: PromptRole
  content: string
}

interface ChatMessage {
  role: ChatRole
  content: string
}

interface WorldLandTransferPayload {
  source?: string
  generatedAt?: string
  currentCountryName?: string
  world?: unknown
  quadtree?: unknown
  countries?: unknown[]
  worldMapImage?: unknown
  width?: number
  height?: number
  classification?: {
    type?: string
    blueRatio?: number
    blueMargin?: number
    alphaThreshold?: number
  }
  maxDepth?: number
  minSize?: number
  tree?: unknown
  landMap?: Record<string, unknown>
  countryColorMap?: Record<string, unknown>
}

interface EventDriveArchiveEntry {
  world: WorldLandTransferPayload
  countryIndicators: Record<string, CountryIndicatorData>
  chatInput: string
  chatMessages: ChatMessage[]
  /** 与这份世界一起保存的时间线；旧存档可能没有。 */
  timeline: TimelineState | null
  createdAt: string
  updatedAt: string
}

interface EventDriveSnapshotEntry {
  id: string
  label: string
  world: WorldLandTransferPayload | null
  chatInput: string
  chatMessages: ChatMessage[]
  timeline: TimelineState | null
  createdAt: string
}
```

#### localStorage 键

| 键名                                  | 用途             |
| ------------------------------------- | ---------------- |
| `event-drive-world-chat-archive-json` | 聊天存档         |
| `event-drive-snapshot-history-json`   | 快照历史         |
| `event-drive-selected-snapshot-id`    | 当前快照 ID      |
| `event-drive-last-world-key`          | 最后使用的世界键 |
| `event-drive-chat-window-draft`       | 聊天输入草稿     |
| `event-drive-world-package-json`      | 世界数据包       |
| `event-drive-world-json`              | 世界 JSON        |
| `event-drive-world-land-json`         | 国土 JSON        |
| `event-drive-fresh-session`           | 新会话标记       |

> 归档条目与快照条目都额外保存 `timeline`（`TimelineState`），时间线页直接复用，不需要新的存储键。

#### 常量

```typescript
const LIVE_SESSION_SNAPSHOT_ID = '__live__' // 表示实时会话
```

---

### 7. 时间线页面 (pages/timeline)

**路由**: `/pages/timeline`  
**用途**: 把事件驱动页产生的指标变动与政权兴亡按时间铺开，展示继承者分叉

页面只读取事件驱动页的当前存档（`readActiveEventDriveSave`：选中的快照优先，其次上次打开的世界键对应的归档条目，最后是当前世界包），不修改任何数据。旧存档没有 `timeline` 字段时，会用当前世界重建一条从第 0 天开始的基线。

#### 数据模型

```typescript
interface TimelineState {
  version: 1
  scenarioName: string
  startTimeText: string
  startEpochMs: number | null
  currentDay: number // 距离开局的天数
  turn: number // 已执行的时间推进次数
  initialCountries: TimelineRegimeSeed[]
  events: TimelineEvent[]
}
```

`TimelineEvent.kind`:

| 类型        | 含义                | 画法                     |
| ----------- | ------------------- | ------------------------ |
| `indicator` | 三国力指标变化      | 实心圆点                 |
| `reform`    | 政治制度 / 经济状况 | 菱形                     |
| `create`    | 政权建立            | 三角                     |
| `destroy`   | 政权灭亡            | 叉号，有继承者时向下分叉 |
| `rename`    | 政权更名            | 空心菱形 + 虚线接续      |
| `transfer`  | 两个政权间领土划转  | 方块                     |

#### 时间推进

`parseTimeAdvanceInstruction(text)` 只接受整条消息就是推进指令：
`时间推进12年`、`推进时间 3 个月`、`推进7天`（可带「请 / 帮我」和句末标点）。
日 / 周 / 月 / 年分别换算为 1 / 7 / 30 / 365 天；事件触发、故事与提问不推进时钟。
指标与政权变更会在推进后的当天写入时间线。

#### 布局

`buildTimelineLayout(state, currentRegimes)` 是纯函数：

- 开局政权与 `create` 事件生成泳道起点；
- `destroy` 结束泳道；`successors` 非空时为每个继承者生成向下分叉，颜色取继承国代表色；
- `rename` 用虚线把旧名称接到新名称；
- 先访问没有父政权的泳道，再深度优先访问继承者子树，保证继承者始终排在父政权下面且相邻；
- `buildTimelineTicks(startEpochMs, startDay, endDay, maxTicks)` 优先落在真实年 / 月边界，开局时间不可解析时退回「开局 + N 天」。

#### 图表组件

`src/components/timeline-chart/timeline-chart.vue`：

- SVG 渲染，横轴按天映射到像素，纵轴一行一个政权；
- 滚轮以光标为锚点缩放、拖拽平移、双击 / 「重置视图」恢复完整范围；
- 事件点悬停时用 HTML 浮层显示时间、事件概述、指标旧值 → 新值、继承国、指令与原因；
- 分叉线从灭亡点弯向继承者泳道，颜色使用继承国代表色。

---

## 可组合函数 (Composables)

### ai-settings.ts

用途: 管理 AI 提供商、API密钥和模型选择的全局状态

#### `useAiSettings()`

返回的响应式对象：

```typescript
interface UseAiSettingsReturn {
  apiValue: Ref<string> // API 密钥
  selectedProvider: Ref<Provider> // 当前提供商
  selectedModel: Ref<string> // 当前模型
  modelOptions: ComputedRef<string[]> // 当前提供商的模型列表
  providerOptions: readonly Provider[] // 所有提供商
  saveAiSettings(): void // 保存设置到 localStorage
}
```

#### 提供商和模型支持

```typescript
const providerOptions = ['OpenAI', 'DeepSeek', 'Qwen', 'Anthropic', 'OpenCode Go'] as const

const modelOptionsMap = {
  OpenAI: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
  DeepSeek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  Qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  Anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  'OpenCode Go': [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'glm-5.3',
    'glm-5.3-flash',
    'kimi-k3',
    'kimi-k2.7-code',
    'qwen3.8-max',
    'qwen3.8-flash',
    'minimax-m3.1-flash',
    'hy4',
  ],
}

// OpenCode Go 的 OpenAI 兼容网关（官方文档：https://opencode.ai/docs/console/go）
const openCodeGoBaseUrl = 'https://opencode.ai/inference/go/openai/v1'
```

#### 存储键

- `localStorage` 键: `ai-settings`

---

### prompt-defaults.ts

用途: 提供 AI 提示词的默认模板

#### `defaultTextToJsonPrompt`

- **类型**: string 常量
- **用途**: 文本转 JSON 的系统提示词模板
- **内容**: 包含输出 JSON 结构规范、字段要求、类型检查等详细指令

#### `defaultEventDrivePrompt`

- **类型**: string 常量
- **用途**: 事件驱动推演的系统提示词模板
- **内容**:
  - 角色定义：架空历史事件叙述者
  - 指令类型：时间推进、事件触发、故事发展、讲述故事、提问
  - 核心约束：连贯性、合理性、无自相矛盾
  - 内容长度限制：故事 ≤500字，单国描述 ≤100字

#### `defaultScenarioReviewPrompt`

- **类型**: string 常量
- **用途**: 剧本编辑页「发送至 AI」的系统提示词模板
- **内容**:
  - 说明剧本 JSON 结构与 `AI控制` 的含义
  - 要求按「开局概览 → 阻断问题 → 数据一致性 → 历史与逻辑合理性 → 改进建议 → 开局推演」输出
  - 只依据收到的 JSON 分析，缺失信息标记为「未填写」

---

### timezone.ts

用途: 管理时区设置与显示

#### 主要导出

```typescript
const selectedTimezone: Ref<number> // 当前时区（-12 到 +14）
const timezoneOptions: number[] // 所有时区选项
const storageKey: string // localStorage 键

function formatTimezoneLabel(tz: number): string // 格式化时区为可读文本
```

---

## 工具函数 (Utils)

### submit-commition.ts

用途: 调用 AI 模型的完整工作流程

#### `readAiSettingsFromStorage(): AiSettings | null`

- **用途**: 从 localStorage 读取 AI 配置
- **参数**: 无
- **返回值**: 配置对象或 null
- **验证**: 检查必需字段存在性和类型

#### `submitPreparedPrompt(prepared: PreparedPrompt): Promise<string | null>`

- **用途**: 向 AI 模型提交已准备的提示词并返回响应文本
- **参数**:
  ```typescript
  interface PreparedPrompt {
    provider?: string
    model?: string
    messages: Array<{ role: string; content: string }>
  }
  ```
- **返回值**: Promise<响应文本或 null>

##### 提供商支持

**OpenAI**

- 端点: `https://api.openai.com/v1/chat/completions`
- 优先使用官方 SDK，失败时使用 REST fallback
- 需要 Bearer token 认证

**DeepSeek**

- 端点: `https://api.deepseek.com/chat/completions`
- 兼容 OpenAI API 格式
- 支持 SDK 和 REST 两种方式

**OpenCode Go**

- 网关: `https://opencode.ai/inference/go`（Go 订阅专属，OpenAI 兼容）
- 端点: `https://opencode.ai/inference/go/openai/v1/chat/completions`
- 请求头额外携带 `x-opencode-session`（按浏览器标签页生成，存于 `sessionStorage` 的
  `opencode-go-session-id`），便于网关路由与提示词缓存
- API Key 在 [OpenCode Console](https://opencode.ai/console) 创建，形如 `oc_sk_...`
- 支持 SDK 和 REST 两种方式；模型列表可用 `GET https://opencode.ai/inference/go/v1/models` 查询
- 与应用内其它提供商一样由浏览器直接请求，需要网关允许跨域（CORS）；被拦截时会提示发送失败

**响应解析**

- 支持 `choices[].message.content` (OpenAI/DeepSeek 格式)
- 支持 `choices[].text` (部分提供商)
- 支持 `output` 和 `result` 字段
- 多个 choices 自动连接（使用 `\n` 分隔）

---

### preloadPrompt.ts

用途: 预加载和准备提示词消息

#### `PreparedPrompt` 类型

```typescript
interface PreparedPrompt {
  provider?: string // 模型提供商（可选）
  model?: string // 模型名称（可选）
  messages: Array<{
    // 消息数组
    role: string
    content: string
  }>
}
```

---

## 数据模型

### 类型定义文件

**country.ts** - 国家数据结构

```typescript
interface CountryData {
  国家名称: string
  人口: {
    总数: number
    种族比例: Record<string, string>
  }
  政治制度: string
  经济状况: string
  城市: Array<{
    名称: string
    简介: string
    人口比例: Record<string, string>
    经济状况: string
    政治状况: string
  }>
  国歌: string
  货币: string
  武装力量: {
    名称: string
    规模: string
    兵役制度: string
    军种: string[]
  }
  武装力量法: string
  宗教信仰: string
  名词定义: Array<{
    术语: string
    定义: string
  }>
  政治: {
    政党: Party[]
    联盟: Array<{
      联盟名称: string
      政党: Party[]
    }>
    政治状况: Record<string, string>
  }
  科技: {
    重工业: string
    轻工业: string
    第三产业: string
    航天工业: string
    信息产业: string
    农业: string
  }
  种族: Array<{
    名称: string
    简介: string
    文化: string
    宗教: string
  }>
}

interface Party {
  名称: string
  简介: string
  主要人物: Record<string, string>
}
```

**scenario.ts** - 剧本与政权数据结构

```typescript
interface ScenarioData {
  剧本名称: string
  开局时间: string
  存在国家: RegimeData[]
}

interface RegimeData extends CountryData {
  代表色: string
  政体: string
  领导人: LeaderData[]
  领土: TerritoryData[]
  初始国家力量: CountryIndicatorData
}

interface LeaderData {
  姓名: string
  职位: string
  简介: string
}

interface TerritoryData {
  名称: string
  代码?: string // 地区编号：ISO3 / 中国 adcode / ISO 3166-2
  国家代码?: string // 下级行政区所属国家 ISO3
  级别?: 'country' | 'adm1' | 'adm2' | 'adm3'
  区域?: Area[] // 自定义多边形，[经度, 纬度]
}
```

**world.ts** - 世界数据结构

```typescript
interface WorldData {
  countries: CountryData[]
  worldMapImage?: unknown
  [key: string]: unknown
}
```

**land.ts** - 国土数据结构

```typescript
interface LandData {
  // 具体字段根据四叉树结构定义
  [key: string]: unknown
}
```

---

## 工作流程流图

```
┌─────────────────────────────────────────────────────────────────┐
│                    推荐使用顺序流程                              │
└─────────────────────────────────────────────────────────────────┘

第1步：首页 (index)
   └─→ 阅读教程，了解流程

第2步：设置 (local-setting)
   └─→ 配置模型提供商、API、模型
   └─→ 编辑提示词模板

第3步：文本转 JSON (text-to-json)
   └─→ 导入原始文本/文件
   └─→ 确认提示词
   └─→ 提交到 AI 模型
   └─→ JSON 结构校验
   └─→ 导出结构化国家数据

第4步：世界观生成器 (world-generator)
   ├─→ 导入第3步得到的国家 JSON
   ├─→ 导入世界地图图片
   ├─→ 编辑国家信息
   ├─→ 划分地盘（四叉树）
   ├─→ 调整国家颜色
   └─→ 传递到事件驱动页面

第5步：剧本编辑 (scenario-editor)
   ├─→ 填写剧本名称与开局时间
   ├─→ 配置政权代表色 / 政体 / 领导人 / 初始国家力量
   ├─→ 放大到 2.4 倍后点击单个地区划入或移出
   ├─→ 导入文章转 JSON 的国家档案
   ├─→ 导出剧本.json
   └─→ 发送至推演（写入 event-drive-scenario-json 后跳转）

第6步：事件驱动 (event-drive)
   ├─→ 确认世界数据或剧本已加载
   ├─→ 多轮对话推演事件
   ├─→ 创建快照存档
   └─→ 导出聊天记录
```

---

## 关键数据流

### 文本转JSON流程

```
文件导入 → 内容解析(OfficeConverter) → 提示词准备(PreparedPrompt)
  → 提交到AI(submitPreparedPrompt) → JSON 输出 → 规范化(normalizeJsonText)
  → 结构校验(validateCountry) → 导出JSON
```

### 世界生成流程

```
国家JSON导入 → 解析和规范化 → 地图图片导入
  → Canvas 纹理生成 → 四叉树陆地掩码 → 颜色分配
  → 球体3D渲染 → 交互式旋转拖拽 → 导出世界数据
```

### 剧本编辑流程

```
世界草稿/国家JSON → normalizeScenarioData → 政权表单
  → 低倍率点击国家（ISO3）或放大后点击行政区（地区编号）
  → 或世界国土转换（墨卡托 [u,v] → [经度, 纬度]）
  → 自动保存草稿（localStorage）→ 导出 剧本.json
```

### 剧本到事件驱动交接流程

```
剧本编辑「发送至推演」→ createScenarioTransferPayload
  → 写入 event-drive-scenario-json + event-drive-fresh-session
  → router.push(event-drive)
  → parseScenarioTransferPayload → compactRegimeForEventDrive
  → WorldLandTransferPayload{ scenarioName, scenarioStartTime, countries }
  → toBriefCountry 生成国家简报（每轮）
  → matchCountryNamesInText + toDetailCountry 生成本轮详情
  → 世界上下文消息（JSON 包成 world.countries）
  → 存档 / 快照 / 后续对话
```

### 事件推演流程

```
世界数据加载 → 系统提示词初始化 → 用户输入消息
  → 上下文编排(世界+历史消息) → 提交到AI
  → 模型响应 → 消息历史更新 → 快照保存
  → 存档保存 → 显示回复
```

---

## 常见 localStorage 键值总结

| 模块     | 键名                                  | 说明                       |
| -------- | ------------------------------------- | -------------------------- |
| AI设置   | `ai-settings`                         | 提供商、API、模型          |
| 提示词   | `prompt-text-to-json`                 | 文本转JSON提示词           |
| 提示词   | `prompt-event-drive`                  | 事件驱动提示词             |
| 时区     | 动态键                                | 时区选择                   |
| 世界生成 | `worldDataDraft`                      | 世界数据草稿               |
| 剧本编辑 | `scenario-editor-draft`               | 剧本草稿（自动保存）       |
| 剧本编辑 | `scenario-editor-import`              | 文章转 JSON 的交接数据     |
| 剧本编辑 | `event-drive-scenario-json`           | 发送至推演的剧本交接数据   |
| 剧本编辑 | `worldDataDraft`                      | 读取世界生成草稿并转换领土 |
| 事件驱动 | `event-drive-world-chat-archive-json` | 聊天存档                   |
| 事件驱动 | `event-drive-snapshot-history-json`   | 快照历史                   |
| 事件驱动 | `event-drive-selected-snapshot-id`    | 当前快照ID                 |

---

## API 调用示例

### 调用 AI 模型

```typescript
import { submitPreparedPrompt } from '@/utils/submit-commition'

const result = await submitPreparedPrompt({
  provider: 'OpenAI',
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello' },
  ],
})
```

### 获取AI设置

```typescript
import { useAiSettings } from '@/composables/ai-settings'

export default {
  setup() {
    const { selectedProvider, selectedModel, apiValue } = useAiSettings()

    return { selectedProvider, selectedModel, apiValue }
  },
}
```

### 世界数据管理

```typescript
// 获取国土数据
const landData = getCountryLand('France')

// 设置国土数据
setCountryLand('France', newLandData)

// 设置国家颜色
setCountryColor('France', '#FF5733')

// 获取国家颜色
const color = getCountryColor('France')

// 列出所有国土数据
const allLands = listCountryLands()
```

---

## 版本信息

- **框架**: Vue 3
- **语言**: TypeScript
- **构建工具**: Vite
- **测试**: Vitest + Playwright
- **包管理**: pnpm

---

## 许可证

参见项目根目录 LICENSE 文件
