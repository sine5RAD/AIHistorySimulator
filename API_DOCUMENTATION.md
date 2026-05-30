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
  - `provider`: 模型提供商（OpenAI / DeepSeek / Qwen / Anthropic）
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
  provider: 'OpenAI' | 'DeepSeek' | 'Qwen' | 'Anthropic'
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

### 5. 事件驱动页面 (pages/event-drive)
**路由**: `/pages/event-drive`  
**用途**: 在世界背景下进行连续多轮对话，推演历史事件发展，支持存档与快照

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
  chatInput: string
  chatMessages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

interface EventDriveSnapshotEntry {
  id: string
  label: string
  world: WorldLandTransferPayload | null
  chatInput: string
  chatMessages: ChatMessage[]
  createdAt: string
}
```

#### localStorage 键

| 键名 | 用途 |
|-----|------|
| `event-drive-world-chat-archive-json` | 聊天存档 |
| `event-drive-snapshot-history-json` | 快照历史 |
| `event-drive-selected-snapshot-id` | 当前快照 ID |
| `event-drive-last-world-key` | 最后使用的世界键 |
| `event-drive-chat-window-draft` | 聊天输入草稿 |
| `event-drive-world-package-json` | 世界数据包 |
| `event-drive-world-json` | 世界 JSON |
| `event-drive-world-land-json` | 国土 JSON |
| `event-drive-fresh-session` | 新会话标记 |

#### 常量

```typescript
const LIVE_SESSION_SNAPSHOT_ID = '__live__' // 表示实时会话
```

---

## 可组合函数 (Composables)

### ai-settings.ts

用途: 管理 AI 提供商、API密钥和模型选择的全局状态

#### `useAiSettings()`

返回的响应式对象：

```typescript
interface UseAiSettingsReturn {
  apiValue: Ref<string>           // API 密钥
  selectedProvider: Ref<Provider> // 当前提供商
  selectedModel: Ref<string>      // 当前模型
  modelOptions: ComputedRef<string[]> // 当前提供商的模型列表
  providerOptions: readonly Provider[] // 所有提供商
  saveAiSettings(): void          // 保存设置到 localStorage
}
```

#### 提供商和模型支持

```typescript
const providerOptions = ['OpenAI', 'DeepSeek', 'Qwen', 'Anthropic'] as const

const modelOptionsMap = {
  OpenAI: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
  DeepSeek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  Qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  Anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
}
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

---

### timezone.ts

用途: 管理时区设置与显示

#### 主要导出

```typescript
const selectedTimezone: Ref<number>        // 当前时区（-12 到 +14）
const timezoneOptions: number[]            // 所有时区选项
const storageKey: string                   // localStorage 键

function formatTimezoneLabel(tz: number): string  // 格式化时区为可读文本
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
  provider?: string        // 模型提供商（可选）
  model?: string          // 模型名称（可选）
  messages: Array<{       // 消息数组
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

第5步：事件驱动 (event-drive)
   ├─→ 确认世界数据已加载
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

### 事件推演流程
```
世界数据加载 → 系统提示词初始化 → 用户输入消息 
  → 上下文编排(世界+历史消息) → 提交到AI
  → 模型响应 → 消息历史更新 → 快照保存
  → 存档保存 → 显示回复
```

---

## 常见 localStorage 键值总结

| 模块 | 键名 | 说明 |
|-----|-----|------|
| AI设置 | `ai-settings` | 提供商、API、模型 |
| 提示词 | `prompt-text-to-json` | 文本转JSON提示词 |
| 提示词 | `prompt-event-drive` | 事件驱动提示词 |
| 时区 | 动态键 | 时区选择 |
| 世界生成 | `worldDataDraft` | 世界数据草稿 |
| 事件驱动 | `event-drive-world-chat-archive-json` | 聊天存档 |
| 事件驱动 | `event-drive-snapshot-history-json` | 快照历史 |
| 事件驱动 | `event-drive-selected-snapshot-id` | 当前快照ID |

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
    { role: 'user', content: 'Hello' }
  ]
})
```

### 获取AI设置

```typescript
import { useAiSettings } from '@/composables/ai-settings'

export default {
  setup() {
    const { selectedProvider, selectedModel, apiValue } = useAiSettings()
    
    return { selectedProvider, selectedModel, apiValue }
  }
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

