<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { useAiSettings } from '@/composables/ai-settings'
import { defaultEventDrivePrompt } from '@/composables/prompt-defaults'
import {
  EVENT_DRIVE_ACTIONS,
  EVENT_DRIVE_TIME_UNITS,
  buildEventDrivePrompt,
  createEmptyEventDriveActionInput,
  isEventDrivePromptComplete,
  sanitizeTimeDigits,
  sortCountryNamesByPinyin,
  type EventDriveActionInput,
  type EventDriveActionKind,
} from '@/utils/event-drive-actions'
import { submitPreparedPrompt } from '@/utils/submit-commition'
import { extractJsonFromText, stripJsonFromText } from '@/utils/ai-json'
import { matchCountryNamesInText } from '@/utils/country-mentions'
import { buildBriefCountries, buildDetailCountries } from '@/utils/event-drive-context'
import { compactRegimeForEventDrive, estimateTextTokens } from '@/utils/scenario-ai'
import {
  applyRegimeChanges,
  findCountryIndex,
  splitAssistantChangePayload,
} from '@/utils/regime-change'
import {
  advanceTimelineClock,
  createTimelineState,
  formatGameDate,
  normalizeTimelineState,
  parseTimeAdvanceInstruction,
  recordIndicatorChange,
  recordReformChange,
  recordRegimeTimelineEvents,
} from '@/utils/timeline'
import { CODE_LEVELS, countTerritoryBuckets, readTerritoryBuckets } from '@/utils/territory-summary'
import {
  MAX_TERRITORY_QUERY_ROUNDS,
  buildTerritoryQueryReply,
  parseTerritoryQuery,
} from '@/utils/territory-query'
import {
  EVENT_DRIVE_FRESH_SESSION_KEY,
  SCENARIO_TRANSFER_KEY,
  parseScenarioTransferPayload,
  type ScenarioTransferPayload,
} from '@/utils/scenario-transfer'
import FloatingCountrySidebar, {
  type FloatingCountrySidebarEditStatPayload,
  type FloatingCountrySidebarItem,
} from '@/components/floating-country-sidebar/floating-country-sidebar.vue'
import type { CountryIndicatorData } from '@/types/country'
import type { AppliedRegimeChange, RegimeChangeData, RegimeTerritorySummary } from '@/types/regime'
import type { TimelineState } from '@/types/timeline'
import type { TerritoryCodeLevel } from '@/utils/territory-summary'

type ChatRole = 'user' | 'assistant'

type PromptRole = ChatRole | 'system'

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
  scenarioName?: string
  scenarioStartTime?: string
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
  /**
   * 地区编号 → 地区名称。
   *
   * 只用于本地展示（「领土划转」面板）与给 AI 的详情档，
   * 不进入每轮国家简报，因此不影响上下文预算。
   */
  territoryNames?: Record<string, string>
  /**
   * 地区编号 → 所属国家 ISO3。
   *
   * 只供世界地图按存档复原国界时精确匹配 `N/A` 这类重复编号；
   * 不进入每轮简报，也不影响 AI 上下文。
   */
  territoryCountries?: Record<string, string>
}

interface WorldLandTransferState {
  payload: WorldLandTransferPayload
  source: 'session' | 'local'
}

/** 剧本编辑页交接来的世界包用 source / scenarioName 标记。 */
const isScenarioTransferPayload = (payload: WorldLandTransferPayload | null): boolean =>
  !!payload && (payload.source === 'scenario-editor' || typeof payload.scenarioName === 'string')

interface EventDriveArchiveEntry {
  world: WorldLandTransferPayload
  countryIndicators: Record<string, CountryIndicatorData>
  chatInput: string
  chatMessages: ChatMessage[]
  /** 与这份世界一起保存的时间线。 */
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

type EventDriveArchive = Record<string, EventDriveArchiveEntry>
type EventDriveSnapshotHistory = EventDriveSnapshotEntry[]

const EVENT_DRIVE_ARCHIVE_KEY = 'event-drive-world-chat-archive-json'
const EVENT_DRIVE_SNAPSHOT_HISTORY_KEY = 'event-drive-snapshot-history-json'
const EVENT_DRIVE_SELECTED_SNAPSHOT_KEY = 'event-drive-selected-snapshot-id'
const EVENT_DRIVE_LAST_WORLD_KEY = 'event-drive-last-world-key'
const CHAT_WINDOW_DRAFT_KEY = 'event-drive-chat-window-draft'
const WORLD_PACKAGE_TRANSFER_KEY = 'event-drive-world-package-json'
const WORLD_JSON_TRANSFER_KEY = 'event-drive-world-json'
const WORLD_LAND_TRANSFER_KEY = 'event-drive-world-land-json'
const LIVE_SESSION_SNAPSHOT_ID = '__live__'

const router = useRouter()
const { apiValue, selectedModel, selectedProvider } = useAiSettings()

const chatInput = ref('')
const chatMessages = ref<ChatMessage[]>([])
const hiddenPromptMessages = ref<PromptMessage[]>([])
const worldContextMessage = ref<PromptMessage | null>(null)
const activeWorldPayload = ref<WorldLandTransferPayload | null>(null)
const activeCountryIndicators = ref<Record<string, CountryIndicatorData>>({})
/** 当前世界的时间线；与存档、快照一起持久化。 */
const activeTimeline = ref<TimelineState | null>(null)
const activeWorldKey = ref('')
const isSending = ref(false)
const errorText = ref('')
const chatListRef = ref<HTMLElement | null>(null)
const archiveImportInputRef = ref<HTMLInputElement | null>(null)
const snapshotHistory = ref<EventDriveSnapshotHistory>([])
const selectedSnapshotId = ref(LIVE_SESSION_SNAPSHOT_ID)
const snapshotMenuOpen = ref(false)
const pendingWorldLandPayload = ref<WorldLandTransferPayload | null>(null)
const pendingWorldLandSource = ref<'session' | 'local' | null>(null)
const actionMenuOpen = ref(false)
const activeActionKind = ref<EventDriveActionKind | null>(null)
const actionInput = ref<EventDriveActionInput>(createEmptyEventDriveActionInput())
const actionPickerRef = ref<HTMLElement | null>(null)

/** 「政权管理」面板的新建表单；数值留空时按 0 处理。 */
const regimeDraft = ref({
  国家名称: '',
  政体: '',
  取代政权: '',
  政治稳定: 0,
  经济发展: 0,
  国际影响: 0,
  玩家操控: false,
})

/** 「政权管理」面板的灭亡表单；继承国为空表示领土无主。 */
const destroyDraft = ref({
  政权名称: '',
  继承国: '',
})

/** 「领土划转」面板：来源政权 → 勾选地区 → 接收方。 */
const transferDraft = ref({
  来源政权: '',
  接收方: '',
  关键词: '',
  /** 已勾选的地区编号。 */
  选中: [] as string[],
})

const formatIndicatorValue = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0'
  }

  return Number.isInteger(value) ? `${value}` : value.toFixed(2)
}

const formatBriefSummary = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return '暂无可展示的简略信息'
  }

  const record = value as Record<string, unknown>
  const pieces: string[] = []

  if (typeof record.国歌 === 'string' && record.国歌.trim()) {
    pieces.push(`国歌：${record.国歌.trim()}`)
  }

  if (typeof record.货币 === 'string' && record.货币.trim()) {
    pieces.push(`货币：${record.货币.trim()}`)
  }

  return pieces.length ? pieces.join(' · ') : '暂无可展示的简略信息'
}

const getTrimmedTextField = (record: Record<string, unknown>, key: string) => {
  const value = record[key]

  return typeof value === 'string' && value.trim() ? value.trim() : '暂无'
}

const getCountriesFromPayload = (payload: WorldLandTransferPayload | null): unknown[] => {
  if (!payload || typeof payload !== 'object') {
    return []
  }

  if (Array.isArray(payload.countries)) {
    return payload.countries
  }

  if (payload.world && typeof payload.world === 'object') {
    const nestedWorld = payload.world as { countries?: unknown }

    if (Array.isArray(nestedWorld.countries)) {
      return nestedWorld.countries
    }
  }

  return []
}

const getCountryColorMapFromPayload = (
  payload: WorldLandTransferPayload | null,
): Record<string, string> => {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const extractColorMap = (value: unknown) => {
    if (!isRecord(value)) {
      return {}
    }

    const colorMap: Record<string, string> = {}

    for (const [countryName, colorValue] of Object.entries(value)) {
      if (typeof colorValue === 'string' && countryName.trim() && colorValue.trim()) {
        colorMap[countryName.trim()] = colorValue.trim()
      }
    }

    return colorMap
  }

  const topLevelColorMap = extractColorMap(payload.countryColorMap)
  if (Object.keys(topLevelColorMap).length > 0) {
    return topLevelColorMap
  }

  if (payload.world && typeof payload.world === 'object') {
    const nestedWorld = payload.world as { countryColorMap?: unknown }
    const nestedColorMap = extractColorMap(nestedWorld.countryColorMap)

    if (Object.keys(nestedColorMap).length > 0) {
      return nestedColorMap
    }
  }

  return {}
}

/** 地区编号 → 地区名称；剧本交接时由剧本编辑器写入，老存档可能没有。 */
const getTerritoryNamesFromPayload = (
  payload: WorldLandTransferPayload | null,
): Record<string, string> => {
  if (!payload || !isRecord(payload.territoryNames)) {
    return {}
  }

  const names: Record<string, string> = {}

  for (const [rawCode, rawName] of Object.entries(payload.territoryNames)) {
    const code = rawCode.trim()
    const name = typeof rawName === 'string' ? rawName.trim() : ''

    if (code && name) {
      names[code] = name
    }
  }

  return names
}

/** 地区名称 → 编号：让 `领土` 里写地区名也能落地。 */
const territoryNameIndex = computed(() => {
  const index: Record<string, string> = {}

  for (const [code, name] of Object.entries(
    getTerritoryNamesFromPayload(activeWorldPayload.value),
  )) {
    if (!index[name]) {
      index[name] = code
    }
  }

  return index
})

const countrySidebarItems = computed<FloatingCountrySidebarItem[]>(() => {
  const countries = getCountriesFromPayload(activeWorldPayload.value)

  if (!countries.length) {
    return []
  }

  return countries.map((country, index) => {
    const record = isRecord(country) ? country : {}
    const countryName =
      typeof record.国家名称 === 'string' && record.国家名称.trim()
        ? record.国家名称.trim()
        : `未命名国家 ${index + 1}`
    const indicators = activeCountryIndicators.value[countryName]
    const colorMap = getCountryColorMapFromPayload(activeWorldPayload.value)

    return {
      id: countryName,
      name: countryName,
      color: colorMap[countryName],
      stats: [
        { label: '政治制度', value: getTrimmedTextField(record, '政治制度') },
        { label: '经济制度', value: getTrimmedTextField(record, '经济制度') },
        {
          label: '政治稳定',
          value: indicators ? formatIndicatorValue(indicators.政治稳定) : '暂无',
        },
        {
          label: '经济状况',
          value: indicators ? formatIndicatorValue(indicators.经济发展) : '暂无',
        },
        {
          label: '国际影响',
          value: indicators ? formatIndicatorValue(indicators.国际影响) : '暂无',
        },
        {
          label: '领土',
          value: `${countTerritoryBuckets(readTerritoryBuckets(record.领土))}`,
        },
      ],
      summary: formatBriefSummary(record),
    }
  })
})

const activeScenarioSummary = computed(() => {
  const payload = activeWorldPayload.value

  if (!isScenarioTransferPayload(payload)) {
    return null
  }

  const countries = getCountriesFromPayload(payload)

  return {
    name: payload?.scenarioName?.trim() || '未命名剧本',
    startTime: payload?.scenarioStartTime?.trim() || '未填写',
    countryCount: countries.length,
    playerControlledCount: getPlayerControlledCountryNames(payload).length,
    briefTokens: worldContextMessage.value
      ? estimateTextTokens(worldContextMessage.value.content)
      : 0,
  }
})

const systemPrompt = defaultEventDrivePrompt

const currentCountryNames = computed(() =>
  sortCountryNamesByPinyin(
    getCountriesFromPayload(activeWorldPayload.value)
      .map((country) =>
        isRecord(country) && typeof country.国家名称 === 'string' ? country.国家名称.trim() : '',
      )
      .filter((name) => name.length > 0),
  ),
)

const activeActionOption = computed(
  () => EVENT_DRIVE_ACTIONS.find((option) => option.kind === activeActionKind.value) ?? null,
)

const activeActionLabel = computed(() => activeActionOption.value?.label ?? '选择指令')

const activeActionNeedsCountry = computed(
  () => activeActionKind.value === 'event' || activeActionKind.value === 'story',
)

const hasCurrentCountries = computed(() => currentCountryNames.value.length > 0)

const actionPrompt = computed(() =>
  activeActionKind.value ? buildEventDrivePrompt(activeActionKind.value, actionInput.value) : '',
)

const actionPromptReady = computed(() =>
  activeActionKind.value
    ? isEventDrivePromptComplete(activeActionKind.value, actionInput.value)
    : false,
)

watch(
  currentCountryNames,
  (names) => {
    if (!names.includes(actionInput.value.country)) {
      actionInput.value.country = names[0] ?? ''
    }
  },
  { immediate: true },
)

const hasApiKey = computed(() => apiValue.value.trim().length > 0)
const settingsSummary = computed(() => {
  const provider = selectedProvider.value || '未选择提供商'
  const model = selectedModel.value || '未选择模型'

  return `${provider} / ${model}`
})

const scrollToBottom = async () => {
  await nextTick()

  chatListRef.value?.scrollTo({
    top: chatListRef.value.scrollHeight,
    behavior: 'smooth',
  })
}

const goToSetting = () => {
  router.push({ name: 'setting' })
}

const goToTimeline = () => {
  router.push({ name: 'timeline' })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const getPlayerControlledCountryNames = (payload: WorldLandTransferPayload | null): string[] =>
  getCountriesFromPayload(payload)
    .filter((country): country is Record<string, unknown> => isRecord(country))
    .filter((country) => country.AI控制 === false)
    .map((country) => (typeof country.国家名称 === 'string' ? country.国家名称.trim() : ''))
    .filter((name) => name.length > 0)

const isCountryIndicatorData = (value: unknown): value is CountryIndicatorData =>
  isRecord(value) &&
  typeof value.政治稳定 === 'number' &&
  typeof value.经济发展 === 'number' &&
  typeof value.国际影响 === 'number'

const normalizeCountryIndicators = (value: unknown): Record<string, CountryIndicatorData> => {
  if (!isRecord(value)) {
    return {}
  }

  const indicators: Record<string, CountryIndicatorData> = {}

  for (const [countryName, indicatorValue] of Object.entries(value)) {
    if (!countryName.trim() || !isCountryIndicatorData(indicatorValue)) {
      continue
    }

    indicators[countryName.trim()] = {
      政治稳定: indicatorValue.政治稳定,
      经济发展: indicatorValue.经济发展,
      国际影响: indicatorValue.国际影响,
    }
  }

  return indicators
}

const resolveCountryIndicators = (entryValue: unknown, payload: WorldLandTransferPayload) => {
  const normalizedIndicators = normalizeCountryIndicators(entryValue)

  return Object.keys(normalizedIndicators).length > 0
    ? normalizedIndicators
    : extractCountryIndicatorsFromWorld(payload)
}

const extractCountryIndicatorsFromWorld = (
  payload: WorldLandTransferPayload | null,
): Record<string, CountryIndicatorData> => {
  const countries = getCountriesFromPayload(payload)

  if (!countries.length) {
    return {}
  }

  const indicators: Record<string, CountryIndicatorData> = {}

  for (const countryValue of countries) {
    if (!isRecord(countryValue)) {
      continue
    }

    const countryName =
      typeof countryValue.国家名称 === 'string' ? countryValue.国家名称.trim() : ''
    const indicatorValue = countryValue.国家指标

    if (!countryName || !isCountryIndicatorData(indicatorValue)) {
      continue
    }

    indicators[countryName] = {
      政治稳定: indicatorValue.政治稳定,
      经济发展: indicatorValue.经济发展,
      国际影响: indicatorValue.国际影响,
    }
  }

  return indicators
}

/* ------------------------------------------------------------------ *
 * 时间线
 *
 * 每轮推演都会把「指标变动 / 政权建立 / 灭亡 / 更名 / 领土划转」写进一条
 * 世界内时间线；时间线随归档、快照与导出 JSON 一起持久化，
 * 时间线页只读取它，不参与推演。
 * ------------------------------------------------------------------ */

const buildTimelineForPayload = (payload: WorldLandTransferPayload): TimelineState =>
  createTimelineState({
    countries: getCountriesFromPayload(payload),
    colorMap: getCountryColorMapFromPayload(payload),
    indicators: activeCountryIndicators.value,
    scenarioName: payload.scenarioName,
    startTimeText: payload.scenarioStartTime?.trim() || payload.generatedAt?.trim() || '',
  })

/** 保证当前世界有一条时间线；旧存档没有时间线字段时按当前世界补一条。 */
const ensureActiveTimeline = (): TimelineState => {
  if (!activeTimeline.value) {
    activeTimeline.value = activeWorldPayload.value
      ? buildTimelineForPayload(activeWorldPayload.value)
      : createTimelineState()
  }

  return activeTimeline.value
}

const recordIndicatorTimelineEvent = (input: {
  country: string
  indicators: CountryIndicatorData
  previous?: CountryIndicatorData
  description?: string
  source: 'ai' | 'manual'
  trigger?: string
  /** AI 返回的事件具体日期；手动修改时为空，落在当前回合。 */
  timeText?: string
  politicalSystemChange?: string
  economicStatusChange?: string
}) => {
  if (!activeWorldPayload.value) {
    return
  }

  const state = ensureActiveTimeline()
  const color = getCountryColorMapFromPayload(activeWorldPayload.value)[input.country]

  activeTimeline.value = recordIndicatorChange(state, { ...input, color })
}

const recordReformTimelineEvent = (input: {
  country: string
  label: string
  value: string
  previousValue?: string
  source: 'ai' | 'manual'
  trigger?: string
}) => {
  if (!activeWorldPayload.value) {
    return
  }

  const state = ensureActiveTimeline()
  const color = getCountryColorMapFromPayload(activeWorldPayload.value)[input.country]

  activeTimeline.value = recordReformChange(state, { ...input, color })
}

const recordRegimeTimelineChanges = (
  result: { applied: string[]; appliedChanges: AppliedRegimeChange[] },
  source: 'ai' | 'manual',
  trigger: string,
) => {
  if (!activeWorldPayload.value || !result.appliedChanges.length) {
    return
  }

  const state = ensureActiveTimeline()

  activeTimeline.value = recordRegimeTimelineEvents(state, {
    changes: result.appliedChanges,
    messages: result.applied,
    source,
    trigger,
  })
}

/** 三项指标完全没变时不记事件点，避免时间线被空转的回合塞满。 */
const hasIndicatorChange = (
  previous: CountryIndicatorData | undefined,
  next: CountryIndicatorData,
): boolean =>
  !previous ||
  previous.政治稳定 !== next.政治稳定 ||
  previous.经济发展 !== next.经济发展 ||
  previous.国际影响 !== next.国际影响

/** 「时间推进 N 日/月/年」在本地推进世界内时钟；事件触发只记录不推进。 */
const advanceGameClock = (days: number) => {
  if (!activeWorldPayload.value || days <= 0) {
    return
  }

  const state = ensureActiveTimeline()
  activeTimeline.value = advanceTimelineClock(state, days)
}

const getWorldArchiveKey = (payload: WorldLandTransferPayload | null) => {
  if (!payload) {
    return ''
  }

  const scenarioName = payload.scenarioName?.trim()

  if (scenarioName) {
    const startTime = payload.scenarioStartTime?.trim()
    return startTime ? `剧本 · ${scenarioName} · ${startTime}` : `剧本 · ${scenarioName}`
  }

  const currentName = payload.currentCountryName?.trim()

  if (currentName) {
    return currentName
  }

  if (payload.generatedAt?.trim()) {
    return `未命名世界_${payload.generatedAt}`
  }

  return '未命名世界'
}

const readEventDriveArchive = (): EventDriveArchive => {
  try {
    const cachedArchive = window.localStorage.getItem(EVENT_DRIVE_ARCHIVE_KEY)

    if (!cachedArchive) {
      return {}
    }

    const parsedArchive = JSON.parse(cachedArchive)

    if (!isRecord(parsedArchive)) {
      return {}
    }

    const archive: EventDriveArchive = {}

    for (const [worldKey, entryValue] of Object.entries(parsedArchive)) {
      if (!isRecord(entryValue)) {
        continue
      }

      const world = entryValue.world
      const chatMessagesValue = entryValue.chatMessages

      if (!isRecord(world) || !Array.isArray(chatMessagesValue)) {
        continue
      }

      const chatMessages = chatMessagesValue.filter(
        (message): message is ChatMessage =>
          isRecord(message) &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string',
      )

      archive[worldKey] = {
        world: world as WorldLandTransferPayload,
        countryIndicators: resolveCountryIndicators(
          entryValue.countryIndicators,
          world as WorldLandTransferPayload,
        ),
        chatInput: typeof entryValue.chatInput === 'string' ? entryValue.chatInput : '',
        chatMessages,
        timeline: normalizeTimelineState(entryValue.timeline),
        createdAt:
          typeof entryValue.createdAt === 'string'
            ? entryValue.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof entryValue.updatedAt === 'string'
            ? entryValue.updatedAt
            : new Date().toISOString(),
      }
    }

    return archive
  } catch (error) {
    console.error('Failed to read event-drive archive', error)
    return {}
  }
}

const writeEventDriveArchive = (archive: EventDriveArchive) => {
  window.localStorage.setItem(EVENT_DRIVE_ARCHIVE_KEY, JSON.stringify(archive))
}

const readSnapshotHistory = (): EventDriveSnapshotHistory => {
  try {
    const cachedHistory = window.localStorage.getItem(EVENT_DRIVE_SNAPSHOT_HISTORY_KEY)

    if (!cachedHistory) {
      return []
    }

    const parsedHistory = JSON.parse(cachedHistory)

    if (!Array.isArray(parsedHistory)) {
      return []
    }

    return parsedHistory
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => {
        const chatMessagesValue = entry.chatMessages
        const worldValue = entry.world

        return {
          id: typeof entry.id === 'string' ? entry.id : `snapshot-${new Date().toISOString()}`,
          label: typeof entry.label === 'string' ? entry.label : '未命名快照',
          world: isRecord(worldValue) ? (worldValue as WorldLandTransferPayload) : null,
          chatInput: typeof entry.chatInput === 'string' ? entry.chatInput : '',
          chatMessages: Array.isArray(chatMessagesValue)
            ? chatMessagesValue.filter(
                (message): message is ChatMessage =>
                  isRecord(message) &&
                  (message.role === 'user' || message.role === 'assistant') &&
                  typeof message.content === 'string',
              )
            : [],
          timeline: normalizeTimelineState(entry.timeline),
          createdAt:
            typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        }
      })
  } catch (error) {
    console.error('Failed to read snapshot history', error)
    return []
  }
}

const writeSnapshotHistory = (history: EventDriveSnapshotHistory) => {
  window.localStorage.setItem(EVENT_DRIVE_SNAPSHOT_HISTORY_KEY, JSON.stringify(history))
}

const getSnapshotLabel = (world: WorldLandTransferPayload | null, createdAt: string) => {
  const worldName = world?.scenarioName?.trim() || world?.currentCountryName?.trim() || '未命名世界'
  const timestamp = createdAt.replace('T', ' ').slice(0, 19)

  return `${worldName} · ${timestamp}`
}

const createSnapshotFromCurrentState = (): EventDriveSnapshotEntry => {
  const createdAt = new Date().toISOString()

  return {
    id: `snapshot-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    label: getSnapshotLabel(activeWorldPayload.value, createdAt),
    world: activeWorldPayload.value ? JSON.parse(JSON.stringify(activeWorldPayload.value)) : null,
    chatInput: chatInput.value,
    chatMessages: JSON.parse(JSON.stringify(chatMessages.value)) as ChatMessage[],
    timeline: activeTimeline.value
      ? (JSON.parse(JSON.stringify(activeTimeline.value)) as TimelineState)
      : null,
    createdAt,
  }
}

const saveSnapshotHistory = (snapshot: EventDriveSnapshotEntry) => {
  const nextHistory = [snapshot, ...readSnapshotHistory()].filter(
    (entry, index, history) =>
      history.findIndex((candidate) => candidate.id === entry.id) === index,
  )

  snapshotHistory.value = nextHistory
  writeSnapshotHistory(nextHistory)
  window.localStorage.setItem(EVENT_DRIVE_SELECTED_SNAPSHOT_KEY, snapshot.id)
  selectedSnapshotId.value = snapshot.id
}

const closeSnapshotMenu = () => {
  snapshotMenuOpen.value = false
}

const toggleSnapshotMenu = () => {
  snapshotMenuOpen.value = !snapshotMenuOpen.value
}

const selectSnapshotById = (snapshotId: string) => {
  if (snapshotId === LIVE_SESSION_SNAPSHOT_ID) {
    clearSelectedSnapshot()
    closeSnapshotMenu()
    return
  }

  const selectedSnapshot = snapshotHistory.value.find((entry) => entry.id === snapshotId)

  if (!selectedSnapshot) {
    clearSelectedSnapshot()
    closeSnapshotMenu()
    return
  }

  applySnapshotEntry(selectedSnapshot)
  closeSnapshotMenu()
}

const deleteSnapshotById = (snapshotId: string) => {
  const nextHistory = snapshotHistory.value.filter((entry) => entry.id !== snapshotId)

  snapshotHistory.value = nextHistory
  writeSnapshotHistory(nextHistory)

  if (selectedSnapshotId.value === snapshotId) {
    const fallbackSnapshot = nextHistory[0]

    if (fallbackSnapshot) {
      applySnapshotEntry(fallbackSnapshot)
    } else {
      clearSelectedSnapshot()
    }
  }

  closeSnapshotMenu()
}

const clearSelectedSnapshot = () => {
  window.localStorage.removeItem(EVENT_DRIVE_SELECTED_SNAPSHOT_KEY)
  selectedSnapshotId.value = LIVE_SESSION_SNAPSHOT_ID
}

const persistSelectedSnapshot = (snapshotId: string) => {
  if (snapshotId === LIVE_SESSION_SNAPSHOT_ID) {
    clearSelectedSnapshot()
    return
  }

  window.localStorage.setItem(EVENT_DRIVE_SELECTED_SNAPSHOT_KEY, snapshotId)
  selectedSnapshotId.value = snapshotId
}

const clearActiveWorldContext = () => {
  window.localStorage.removeItem(EVENT_DRIVE_LAST_WORLD_KEY)
  window.localStorage.removeItem(WORLD_PACKAGE_TRANSFER_KEY)
  window.sessionStorage.removeItem(WORLD_PACKAGE_TRANSFER_KEY)
  activeWorldPayload.value = null
  activeCountryIndicators.value = {}
  activeTimeline.value = null
  activeWorldKey.value = ''
  worldContextMessage.value = null
}

const applySnapshotEntry = (snapshot: EventDriveSnapshotEntry) => {
  if (snapshot.world) {
    setActiveWorldContext(snapshot.world)
    activeTimeline.value =
      normalizeTimelineState(snapshot.timeline) ?? buildTimelineForPayload(snapshot.world)
  } else {
    clearActiveWorldContext()
  }

  activeWorldKey.value = snapshot.world ? getWorldArchiveKey(snapshot.world) : ''
  chatMessages.value = snapshot.chatMessages
  chatInput.value = snapshot.chatInput
  errorText.value = ''
  hiddenPromptMessages.value = []
  pendingWorldLandPayload.value = null
  pendingWorldLandSource.value = null
  persistSelectedSnapshot(snapshot.id)
}

const saveCurrentWorldArchive = () => {
  const worldPayload = activeWorldPayload.value

  if (!worldPayload) {
    return
  }

  const archiveKey = activeWorldKey.value || getWorldArchiveKey(worldPayload)

  if (!archiveKey) {
    return
  }

  const archive = readEventDriveArchive()
  const existingEntry = archive[archiveKey]
  const now = new Date().toISOString()

  archive[archiveKey] = {
    world: worldPayload,
    countryIndicators: { ...activeCountryIndicators.value },
    chatInput: chatInput.value,
    chatMessages: chatMessages.value,
    timeline: activeTimeline.value,
    createdAt: existingEntry?.createdAt ?? now,
    updatedAt: now,
  }

  activeWorldKey.value = archiveKey
  window.localStorage.setItem(EVENT_DRIVE_LAST_WORLD_KEY, archiveKey)
  writeEventDriveArchive(archive)
}

const removeCurrentWorldArchive = (archiveKey: string) => {
  if (!archiveKey) {
    return
  }

  const archive = readEventDriveArchive()

  if (!archive[archiveKey]) {
    return
  }

  delete archive[archiveKey]
  writeEventDriveArchive(archive)
  window.localStorage.removeItem(EVENT_DRIVE_LAST_WORLD_KEY)
}

const setActiveWorldContext = (payload: WorldLandTransferPayload) => {
  activeWorldPayload.value = payload
  activeCountryIndicators.value = extractCountryIndicatorsFromWorld(payload)
  activeTimeline.value = buildTimelineForPayload(payload)
  activeWorldKey.value = getWorldArchiveKey(payload)
  refreshWorldContextMessage()

  try {
    window.localStorage.setItem(EVENT_DRIVE_LAST_WORLD_KEY, activeWorldKey.value)
    persistWorldLandPayload(payload)
  } catch (error) {
    console.error('Failed to persist active world context', error)
  }
}

const applyArchiveEntry = (worldKey: string, entry: EventDriveArchiveEntry) => {
  setActiveWorldContext(entry.world)
  activeCountryIndicators.value = resolveCountryIndicators(entry.countryIndicators, entry.world)
  activeTimeline.value =
    normalizeTimelineState(entry.timeline) ?? buildTimelineForPayload(entry.world)
  activeWorldKey.value = worldKey
  chatMessages.value = entry.chatMessages
  chatInput.value = entry.chatInput
  pendingWorldLandPayload.value = null
  pendingWorldLandSource.value = null

  try {
    window.localStorage.setItem(EVENT_DRIVE_LAST_WORLD_KEY, worldKey)
    persistWorldLandPayload(entry.world)
  } catch (error) {
    console.error('Failed to apply archive entry', error)
  }
}

const downloadTextFile = (fileName: string, text: string) => {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

const exportEventDriveArchive = () => {
  saveCurrentWorldArchive()

  const archive = readEventDriveArchive()
  const archiveJson = JSON.stringify(archive, null, 2)
  const fileName = `event-drive-archive-${new Date().toISOString().slice(0, 10)}.json`

  downloadTextFile(fileName, archiveJson)
}

const extractImportedArchive = (payload: unknown): EventDriveArchive => {
  if (!isRecord(payload)) {
    return {}
  }

  const archive: EventDriveArchive = {}

  for (const [worldKey, entryValue] of Object.entries(payload)) {
    if (!isRecord(entryValue)) {
      continue
    }

    const world = entryValue.world
    const chatMessagesValue = entryValue.chatMessages

    if (!isRecord(world) || !Array.isArray(chatMessagesValue)) {
      continue
    }

    const chatMessages = chatMessagesValue.filter(
      (message): message is ChatMessage =>
        isRecord(message) &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string',
    )

    archive[worldKey] = {
      world: world as WorldLandTransferPayload,
      countryIndicators: resolveCountryIndicators(
        entryValue.countryIndicators,
        world as WorldLandTransferPayload,
      ),
      chatInput: typeof entryValue.chatInput === 'string' ? entryValue.chatInput : '',
      chatMessages,
      timeline: normalizeTimelineState(entryValue.timeline),
      createdAt:
        typeof entryValue.createdAt === 'string' ? entryValue.createdAt : new Date().toISOString(),
      updatedAt:
        typeof entryValue.updatedAt === 'string' ? entryValue.updatedAt : new Date().toISOString(),
    }
  }

  return archive
}

const importEventDriveArchive = async (event: Event) => {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]

  if (!file) {
    return
  }

  try {
    const fileText = await file.text()
    const parsedPayload = JSON.parse(fileText)
    const importedArchive = extractImportedArchive(parsedPayload)

    if (!Object.keys(importedArchive).length) {
      errorText.value = '导入失败：JSON 中没有有效的世界名称-智能体信息键值对。'
      return
    }

    const mergedArchive = {
      ...readEventDriveArchive(),
      ...importedArchive,
    }

    writeEventDriveArchive(mergedArchive)

    const currentKey = activeWorldKey.value
    const selectedKey =
      (currentKey && mergedArchive[currentKey] && currentKey) || Object.keys(importedArchive)[0]

    if (selectedKey && mergedArchive[selectedKey]) {
      applyArchiveEntry(selectedKey, mergedArchive[selectedKey])
    }

    errorText.value = ''
    await scrollToBottom()
  } catch (error) {
    console.error('Failed to import event-drive archive', error)
    errorText.value = '导入失败：请确认 JSON 格式正确。'
  } finally {
    if (input) {
      input.value = ''
    }
  }
}

const triggerArchiveImport = () => {
  archiveImportInputRef.value?.click()
}

const persistWorldLandPayload = (payload: WorldLandTransferPayload) => {
  try {
    window.localStorage.setItem(WORLD_PACKAGE_TRANSFER_KEY, JSON.stringify(payload))
  } catch (error) {
    console.error('Failed to save world land payload to localStorage', error)
  }
}

const buildScenarioBriefMessage = (payload: WorldLandTransferPayload) => {
  const scenarioName = payload.scenarioName?.trim() || '未命名剧本'
  const startTime = payload.scenarioStartTime?.trim() || '未填写'
  const countries = buildBriefCountries(getCountriesFromPayload(payload))
  const playerControlled = getPlayerControlledCountryNames(payload)
  const aiControlledCount = Math.max(0, countries.length - playerControlled.length)
  const controlSummary = playerControlled.length
    ? `玩家操控（AI控制: false）：${playerControlled.join('、')}；AI 操控 ${aiControlledCount} 个。`
    : `全部 ${countries.length} 个政权都由 AI 推演（AI控制: true）。`
  // 提示词按 world.countries 查找国家，这里包一层，避免剧本的「存在国家」字段名对不上。
  const scenarioJson = JSON.stringify(
    {
      剧本名称: scenarioName,
      开局时间: startTime,
      world: { countries },
    },
    null,
    2,
  )

  return [
    `下面是从剧本编辑页发送来的开局剧本「${scenarioName}」，开局时间：${startTime}。这是国家简报，默认每轮发送。`,
    controlSummary,
    '如果后续指令涉及具体国家，系统会在该指令前附上该国详细档案；请优先结合详细档案推演，没有详细档案时不要虚构未提供的信息。',
    '',
    '```json',
    scenarioJson,
    '```',
  ].join('\n')
}

const buildWorldTransferMessage = (payload: WorldLandTransferPayload) => {
  if (isScenarioTransferPayload(payload)) {
    return buildScenarioBriefMessage(payload)
  }

  const prettyJson = JSON.stringify(payload, null, 2)
  const label =
    payload.world && payload.quadtree
      ? '世界观 JSON + 四叉树 JSON 包'
      : payload.tree
        ? 'image_to_quadtree.py 生成的四叉树 JSON'
        : '世界观 JSON'

  return [
    `下面是从世界生成页发送来的${label}，请基于这些数据进行分析。`,
    '',
    '```json',
    prettyJson,
    '```',
  ].join('\n')
}

const buildScenarioDetailMessage = (
  payload: WorldLandTransferPayload,
  matchedNames: readonly string[],
): PromptMessage | null => {
  const countries = buildDetailCountries(
    getCountriesFromPayload(payload),
    matchedNames,
    getTerritoryNamesFromPayload(payload),
  )

  if (!countries.length) {
    return null
  }

  return {
    role: 'user',
    content: [
      `以下是本轮消息涉及国家的详细档案（${matchedNames.join('、')}），仅作参考；国家名单与规则仍以前面的国家简报为准。`,
      '档案里的「领土」额外给出了 adm1 的编号与名称（adm2 及以下只给数量）。需要在「政权变更」里划转领土时，只能使用这里出现过的编号，也可以直接写名称，系统会反查。',
      '',
      '```json',
      JSON.stringify({ 国家: countries }, null, 2),
      '```',
    ].join('\n'),
  }
}

/** 只为本轮消息提到的国家附加详情；没有提到任何国家时返回 null。 */
const buildScenarioDetailMessageForCurrentRequest = (): PromptMessage | null => {
  const payload = activeWorldPayload.value

  if (!payload || !isScenarioTransferPayload(payload)) {
    return null
  }

  const hiddenText = hiddenPromptMessages.value
    .map((message) => message.content)
    .join('\n')
    .trim()
  const latestUserMessage = [...chatMessages.value]
    .reverse()
    .find((message) => message.role === 'user')
  const requestText = hiddenText || latestUserMessage?.content || ''

  if (!requestText.trim()) {
    return null
  }

  const countryNames = getCountriesFromPayload(payload)
    .filter((country): country is Record<string, unknown> => isRecord(country))
    .map((country) => (typeof country.国家名称 === 'string' ? country.国家名称.trim() : ''))
    .filter((name) => name.length > 0)
  const matchedNames = matchCountryNamesInText(requestText, countryNames)

  return matchedNames.length ? buildScenarioDetailMessage(payload, matchedNames) : null
}

/** 国家档案被 AI 或侧栏修改后，重新生成简报，避免下一轮还发旧指标。 */
const refreshWorldContextMessage = () => {
  const payload = activeWorldPayload.value

  worldContextMessage.value = payload
    ? {
        role: 'user',
        content: buildWorldTransferMessage(payload),
      }
    : null
}

const createWorldPayloadFromScenario = (
  transfer: ScenarioTransferPayload,
): WorldLandTransferPayload => {
  const countryColorMap: Record<string, string> = {}
  const territoryNames: Record<string, string> = {}
  const territoryCountries: Record<string, string> = {}

  for (const regime of transfer.scenario.存在国家) {
    const name = regime.国家名称.trim()

    if (name) {
      countryColorMap[name] = regime.代表色
    }

    for (const territory of regime.领土) {
      const code = territory.代码?.trim()
      const areaName = territory.名称?.trim()
      const countryCode = territory.国家代码?.trim().toUpperCase()

      if (code && areaName && areaName !== code && !territoryNames[code]) {
        territoryNames[code] = areaName
      }

      if (code && countryCode && !territoryCountries[code]) {
        territoryCountries[code] = countryCode
      }
    }
  }

  return {
    source: 'scenario-editor',
    generatedAt: transfer.sentAt,
    scenarioName: transfer.scenario.剧本名称,
    scenarioStartTime: transfer.scenario.开局时间,
    countryColorMap,
    territoryNames,
    territoryCountries,
    countries: transfer.scenario.存在国家.map(compactRegimeForEventDrive),
  }
}

function clearScenarioTransferPayload() {
  window.sessionStorage.removeItem(SCENARIO_TRANSFER_KEY)
  window.localStorage.removeItem(SCENARIO_TRANSFER_KEY)
}

const readScenarioTransferPayload = (): ScenarioTransferPayload | null => {
  try {
    const cachedPayload =
      window.sessionStorage.getItem(SCENARIO_TRANSFER_KEY) ??
      window.localStorage.getItem(SCENARIO_TRANSFER_KEY)

    if (!cachedPayload) {
      return null
    }

    const parsedPayload = parseScenarioTransferPayload(JSON.parse(cachedPayload) as unknown)

    if (!parsedPayload) {
      clearScenarioTransferPayload()
      return null
    }

    return parsedPayload
  } catch (error) {
    console.error('Failed to read scenario transfer payload', error)
    clearScenarioTransferPayload()
    return null
  }
}

const readWorldLandPayload = (): WorldLandTransferState | null => {
  try {
    const cachedPayload =
      window.sessionStorage.getItem(WORLD_PACKAGE_TRANSFER_KEY) ??
      window.sessionStorage.getItem(WORLD_LAND_TRANSFER_KEY) ??
      window.sessionStorage.getItem(WORLD_JSON_TRANSFER_KEY)

    if (cachedPayload) {
      const parsedPayload = JSON.parse(cachedPayload) as WorldLandTransferPayload

      if (!parsedPayload || typeof parsedPayload !== 'object') {
        return null
      }

      persistWorldLandPayload(parsedPayload)

      return {
        payload: parsedPayload,
        source: 'session',
      }
    }

    const localCachedPayload =
      window.localStorage.getItem(WORLD_PACKAGE_TRANSFER_KEY) ??
      window.localStorage.getItem(WORLD_LAND_TRANSFER_KEY) ??
      window.localStorage.getItem(WORLD_JSON_TRANSFER_KEY)

    if (!localCachedPayload) {
      return null
    }

    const parsedLocalPayload = JSON.parse(localCachedPayload) as WorldLandTransferPayload

    if (!parsedLocalPayload || typeof parsedLocalPayload !== 'object') {
      return null
    }

    return {
      payload: parsedLocalPayload,
      source: 'local',
    }
  } catch (error) {
    console.error('Failed to read world land payload', error)
    window.sessionStorage.removeItem(WORLD_LAND_TRANSFER_KEY)
    return null
  }
}

const resolveArchiveKey = (
  sessionPayload: WorldLandTransferPayload | null,
  archive: EventDriveArchive,
) => {
  const sessionKey = getWorldArchiveKey(sessionPayload)

  if (sessionKey && archive[sessionKey]) {
    return sessionKey
  }

  const lastWorldKey = window.localStorage.getItem(EVENT_DRIVE_LAST_WORLD_KEY)
  if (lastWorldKey && archive[lastWorldKey]) {
    return lastWorldKey
  }

  const archiveKeys = Object.keys(archive)
  if (archiveKeys.length === 1) {
    return archiveKeys[0]
  }

  return sessionKey
}

const clearWorldLandPayload = () => {
  window.sessionStorage.removeItem(WORLD_JSON_TRANSFER_KEY)
  window.sessionStorage.removeItem(WORLD_LAND_TRANSFER_KEY)
  pendingWorldLandPayload.value = null
  pendingWorldLandSource.value = null
}

const clearChatWindowDraft = () => {
  window.sessionStorage.removeItem(CHAT_WINDOW_DRAFT_KEY)
  window.localStorage.removeItem(CHAT_WINDOW_DRAFT_KEY)
}

const saveChatWindowDraft = () => {
  try {
    const draft = {
      chatInput: chatInput.value,
      chatMessages: chatMessages.value,
    }

    const draftJson = JSON.stringify(draft)

    window.sessionStorage.setItem(CHAT_WINDOW_DRAFT_KEY, draftJson)
    window.localStorage.setItem(CHAT_WINDOW_DRAFT_KEY, draftJson)
  } catch (error) {
    console.error('Failed to save event-drive chat window draft', error)
  }
}

const loadChatWindowDraft = () => {
  try {
    const cachedDraft =
      window.sessionStorage.getItem(CHAT_WINDOW_DRAFT_KEY) ??
      window.localStorage.getItem(CHAT_WINDOW_DRAFT_KEY)

    if (!cachedDraft) {
      return
    }

    const parsedDraft = JSON.parse(cachedDraft) as Partial<{
      chatInput: string
      chatMessages: ChatMessage[]
    }>

    if (Array.isArray(parsedDraft.chatMessages)) {
      chatMessages.value = parsedDraft.chatMessages.filter(
        (message): message is ChatMessage =>
          message &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string',
      )
    }

    if (typeof parsedDraft.chatInput === 'string') {
      chatInput.value = parsedDraft.chatInput
    }

    window.localStorage.setItem(CHAT_WINDOW_DRAFT_KEY, JSON.stringify(parsedDraft))
  } catch (error) {
    console.error('Failed to load event-drive chat window draft', error)
    window.sessionStorage.removeItem(CHAT_WINDOW_DRAFT_KEY)
  }
}

const submitChatContent = async (
  content: string,
  options?: { visibleInChat?: boolean; suppressAssistantReply?: boolean; modelOverride?: string },
) => {
  const visibleInChat = options?.visibleInChat ?? true
  const suppressAssistantReply = options?.suppressAssistantReply ?? false
  const modelOverride = options?.modelOverride
  const trimmedContent = content.trim()
  const hasHiddenPrompt = hiddenPromptMessages.value.length > 0
  // 只有「时间推进」会推进世界内时钟；事件触发、故事与提问只记录在当天。
  const timeAdvance = parseTimeAdvanceInstruction(trimmedContent)

  if (isSending.value || (!trimmedContent && !hasHiddenPrompt)) {
    return false
  }

  if (!hasApiKey.value) {
    errorText.value = '请先到设置页配置 AI API Key。'
    return false
  }

  if (visibleInChat && trimmedContent) {
    chatMessages.value.push({
      role: 'user',
      content: trimmedContent,
    })
    chatInput.value = ''
  }

  errorText.value = ''
  isSending.value = true

  await scrollToBottom()

  try {
    const trailingMessages: PromptMessage[] = []
    let response = ''
    let queryRounds = 0

    for (;;) {
      const rawResponse = await submitPreparedPrompt(
        buildPreparedPrompt(modelOverride, trailingMessages),
      )

      response = rawResponse?.trim() ?? ''

      if (!response) {
        break
      }

      // 模型只想要地名/编号对照表时，本地回填后直接再跑一轮，不进聊天窗口。
      const queryReply = resolveTerritoryQueryFromText(response)

      if (!queryReply) {
        break
      }

      if (queryRounds >= MAX_TERRITORY_QUERY_ROUNDS) {
        errorText.value = 'AI 连续请求查询领土超过上限，本轮没有产生变更。'
        chatMessages.value.push({
          role: 'assistant',
          content: 'AI 反复请求领土对照表，已停止本轮；请换一种说法，或直接指定地区。',
        })
        return false
      }

      queryRounds += 1
      trailingMessages.push({ role: 'assistant', content: response })
      trailingMessages.push({ role: 'user', content: queryReply })
    }

    if (!response) {
      errorText.value = '模型没有返回有效结果。'
      chatMessages.value.push({
        role: 'assistant',
        content: '暂时没有拿到回复，请稍后重试。',
      })
      return false
    }

    if (!suppressAssistantReply) {
      // 时间推进先把世界内时钟推到本轮末尾，再记录本轮产生的变化点。
      if (timeAdvance) {
        advanceGameClock(timeAdvance.days)
      }

      // 解析并应用 AI 返回的变更；变更 JSON 本身由 handleAssistantResponse
      // 转成「国家 / 时间 / 描述 / 数值增减」摘要，不再原样显示在对话框里。
      try {
        await handleAssistantResponse(response, trimmedContent)
      } catch (error) {
        console.error('处理 AI 回复中的指标变更时发生错误', error)
        chatMessages.value.push({
          role: 'assistant',
          content: '处理 AI 返回的变更时发生错误，未应用任何变更。',
        })
      }
    }

    return true
  } catch (error) {
    errorText.value = '发送失败，请稍后重试。'
    chatMessages.value.push({
      role: 'assistant',
      content: '发送失败，请稍后重试。',
    })
    console.error('Failed to send chat message', error)
    return false
  } finally {
    isSending.value = false
    hiddenPromptMessages.value = []
    await scrollToBottom()
  }
}

const resetChat = async () => {
  const currentArchiveKey = activeWorldKey.value || getWorldArchiveKey(activeWorldPayload.value)

  if (
    activeWorldPayload.value ||
    chatMessages.value.length > 0 ||
    chatInput.value.trim() ||
    hiddenPromptMessages.value.length > 0
  ) {
    saveCurrentWorldArchive()
    saveSnapshotHistory(createSnapshotFromCurrentState())
  }

  removeCurrentWorldArchive(currentArchiveKey)

  chatMessages.value = []
  chatInput.value = ''
  errorText.value = ''
  hiddenPromptMessages.value = []
  clearWorldLandPayload()
  clearChatWindowDraft()
  clearActiveWorldContext()
  clearSelectedSnapshot()

  await scrollToBottom()
}

/** 每轮附上当前世界内时间，方便 AI 把事件“时间”写在本轮推进范围内。 */
const buildTimelineContextMessage = (): PromptMessage | null => {
  const timeline = activeTimeline.value

  if (!activeWorldPayload.value || !timeline) {
    return null
  }

  const currentLabel = formatGameDate(timeline.startEpochMs, timeline.currentDay)

  return {
    role: 'user',
    content: [
      `【当前世界内时间】${currentLabel}（距开局 ${timeline.currentDay} 天，第 ${timeline.turn} 回合）。`,
      '如果本轮需要输出“时间”字段，请把事件日期写在本轮指令对应的时间范围内（“时间推进”即推进后的范围）；没有给出具体时间时按历史、政治与军事逻辑推断一个合理日期，不要省略。',
    ].join('\n'),
  }
}

const buildPreparedPrompt = (modelOverride?: string, trailingMessages: PromptMessage[] = []) => {
  const detailMessage = buildScenarioDetailMessageForCurrentRequest()
  const timelineContextMessage = buildTimelineContextMessage()

  return {
    provider: selectedProvider.value,
    model: modelOverride ?? selectedModel.value,
    messages: [
      {
        role: 'system' as const,
        content: systemPrompt,
      },
      ...(worldContextMessage.value ? [worldContextMessage.value] : []),
      ...(timelineContextMessage ? [timelineContextMessage] : []),
      ...(detailMessage ? [detailMessage] : []),
      ...hiddenPromptMessages.value,
      ...chatMessages.value.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      // 静默查询的往返消息只出现在本次请求里，不写进聊天窗口。
      ...trailingMessages,
    ],
  }
}

/**
 * 解析一段回复里的「查询领土」请求，并在本地生成对照表。
 *
 * 命中查询时返回要回填的文本，否则返回 null。
 */
const resolveTerritoryQueryFromText = (text: string): string | null => {
  const jsonText = extractJsonFromText(text)

  if (!jsonText) {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }

  const request = parseTerritoryQuery(parsed)

  if (!request) {
    return null
  }

  return buildTerritoryQueryReply(request, getCountriesFromPayload(activeWorldPayload.value), {
    names: getTerritoryNamesFromPayload(activeWorldPayload.value),
  })
}

const sendSilentInstructionToAi = async (instruction: string) => {
  hiddenPromptMessages.value = [
    {
      role: 'user',
      content: instruction,
    },
  ]

  return submitChatContent('', {
    visibleInChat: false,
    suppressAssistantReply: true,
    modelOverride: 'deepseek-chat',
  })
}

const buildPromptReinjectionMessage = () =>
  [
    '请立即重置当前会话中的提示词规则。',
    '以下内容是你接下来必须遵循的最新提示词，请将之前收到的同类约束视为已被替换。',
    '',
    '```text',
    systemPrompt,
    '```',
    '',
    '收到后请仅确认你已完成提示词替换，不要展开解释。',
  ].join('\n')

const reinjectPrompt = async () => {
  if (isSending.value) {
    return
  }

  hiddenPromptMessages.value = [
    {
      role: 'user',
      content: buildPromptReinjectionMessage(),
    },
  ]

  const sent = await submitChatContent('', { visibleInChat: false })

  if (sent) {
    errorText.value = ''
  }
}

const statLabelToIndicatorKey = (label: string) => {
  if (label === '政治稳定') return '政治稳定'
  if (label === '经济状况') return '经济发展'
  if (label === '国际影响') return '国际影响'
  return null
}

const handleEditStat = async (payload: FloatingCountrySidebarEditStatPayload) => {
  const { item, label, newValue } = payload
  const countryName = item.name

  if (!countryName || isSending.value) {
    return
  }

  const indicatorKey = statLabelToIndicatorKey(label)

  if (indicatorKey) {
    // 数值型指标字段
    const parsed = parseFloat(newValue)
    if (!Number.isFinite(parsed)) {
      errorText.value = `${label} 必须为有效数字。`
      return
    }

    const current = activeCountryIndicators.value[countryName]
    const nextIndicators: CountryIndicatorData = {
      政治稳定: current?.政治稳定 ?? 0,
      经济发展: current?.经济发展 ?? 0,
      国际影响: current?.国际影响 ?? 0,
    }
    nextIndicators[indicatorKey] = parsed
    activeCountryIndicators.value = {
      ...activeCountryIndicators.value,
      [countryName]: nextIndicators,
    }

    recordIndicatorTimelineEvent({
      country: countryName,
      indicators: nextIndicators,
      previous: current,
      description: `手动调整：${label}`,
      source: 'manual',
      trigger: '国家列表手动调整',
    })

    // 同步到 activeWorldPayload
    try {
      const countries = getCountriesFromPayload(activeWorldPayload.value)
      for (const country of countries) {
        if (!isRecord(country)) continue
        const name = typeof country.国家名称 === 'string' ? country.国家名称.trim() : ''
        if (name === countryName) {
          const existing = isCountryIndicatorData(country.国家指标)
            ? country.国家指标
            : { 政治稳定: 0, 经济发展: 0, 国际影响: 0 }
          country.国家指标 = { ...existing, [indicatorKey]: parsed }
          break
        }
      }
    } catch (error) {
      console.error('同步指标到 activeWorldPayload 失败', error)
    }

    refreshWorldContextMessage()
    saveCurrentWorldArchive()
    await sendSilentInstructionToAi(`${countryName}的${label}已变为${newValue}`)
    errorText.value = ''
  } else {
    // 文本字段 — 直接写入国家记录
    const countries = getCountriesFromPayload(activeWorldPayload.value)
    let found = false
    let previousValue = ''

    for (const country of countries) {
      if (!isRecord(country)) continue
      const name = typeof country.国家名称 === 'string' ? country.国家名称.trim() : ''
      if (name === countryName) {
        previousValue = typeof country[label] === 'string' ? String(country[label]) : ''
        country[label] = newValue
        found = true
        break
      }
    }

    if (!found) {
      errorText.value = `未找到国家 ${countryName}。`
      return
    }

    recordReformTimelineEvent({
      country: countryName,
      label,
      value: newValue,
      previousValue,
      source: 'manual',
      trigger: '国家列表手动调整',
    })

    refreshWorldContextMessage()
    saveCurrentWorldArchive()
    await sendSilentInstructionToAi(`${countryName}的${label}已变为${newValue}`)
    errorText.value = ''
  }
}

/* ------------------------------------------------------------------ *
 * 政权管理：建立 / 灭亡
 *
 * 世界包里的政权只有「名称 + 领土编号」，所以建国与灭国本质是一次编号搬迁，
 * 判定与落库规则都在 utils/regime-change.ts 里；这里只负责收集输入、
 * 写回世界包、刷新简报并落盘，保证下一轮请求带的是新的国家名单。
 * ------------------------------------------------------------------ */

/** 代表色表可能挂在顶层，也可能挂在 world 下面，写回时保持与原位置一致。 */
const writeCountryColorMap = (
  payload: WorldLandTransferPayload,
  colorMap: Record<string, string>,
) => {
  if (isRecord(payload.world) && isRecord(payload.world.countryColorMap)) {
    payload.world.countryColorMap = colorMap
    return
  }

  payload.countryColorMap = colorMap
}

/**
 * 手动执行一批政权变更（玩家在面板里点，而不是 AI 写回）。
 *
 * 手动操作允许处理玩家操控的政权，AI 写回则不允许；这条差异由
 * `allowPlayerRegime` 控制，写在纯函数里而不是靠提示词自觉。
 */
const applyManualRegimeChange = async (changes: RegimeChangeData[]): Promise<boolean> => {
  const payload = activeWorldPayload.value

  if (!payload || isSending.value || !changes.length) {
    return false
  }

  const result = applyRegimeChanges(
    getCountriesFromPayload(payload),
    activeCountryIndicators.value,
    getCountryColorMapFromPayload(payload),
    changes,
    { allowPlayerRegime: true, nameIndex: territoryNameIndex.value },
  )

  if (!result.applied.length) {
    errorText.value = result.failed.join('；') || '政权变更未生效。'
    return false
  }

  activeCountryIndicators.value = result.indicators
  writeCountryColorMap(payload, result.colorMap)
  recordRegimeTimelineChanges(result, 'manual', '手动政权变更')
  refreshWorldContextMessage()
  saveCurrentWorldArchive()

  for (const line of result.applied) {
    chatMessages.value.push({ role: 'assistant', content: `（手动）${line}` })
  }

  for (const warning of result.warnings) {
    chatMessages.value.push({ role: 'assistant', content: `⚠ ${warning}` })
  }

  errorText.value = result.failed.join('；')
  return true
}

const createRegimeFromPanel = async () => {
  const name = regimeDraft.value.国家名称.trim()

  if (!name) {
    errorText.value = '请先填写新政权名称。'
    return
  }

  const changes: RegimeChangeData[] = [
    {
      类型: '建立',
      政权名称: name,
      政体: regimeDraft.value.政体.trim() || undefined,
      AI控制: !regimeDraft.value.玩家操控,
      国家指标: {
        政治稳定: Number(regimeDraft.value.政治稳定) || 0,
        经济发展: Number(regimeDraft.value.经济发展) || 0,
        国际影响: Number(regimeDraft.value.国际影响) || 0,
      },
    },
  ]

  const replaced = regimeDraft.value.取代政权.trim()

  if (replaced) {
    // 政权更替：先建立新政权，再把被取代的政权连同全部领土交给它。
    changes.push({
      类型: '灭亡',
      政权名称: replaced,
      继承: '继承国',
      继承国: [name],
      原因: `由「${name}」取代`,
    })
  }

  const created = await applyManualRegimeChange(changes)

  if (created) {
    regimeDraft.value = {
      国家名称: '',
      政体: '',
      取代政权: '',
      政治稳定: 0,
      经济发展: 0,
      国际影响: 0,
      玩家操控: false,
    }
  }
}

/** 灭亡政权；`successor` 为空表示领土无主。 */
const destroyRegime = async (name: string, successor = ''): Promise<boolean> => {
  const target = name.trim()

  if (!target) {
    return false
  }

  const successorName = successor.trim()
  const hint = successorName ? `领土将由「${successorName}」接管。` : '领土将变为无主。'

  if (!window.confirm(`确定灭亡「${target}」吗？${hint}`)) {
    return false
  }

  return applyManualRegimeChange([
    {
      类型: '灭亡',
      政权名称: target,
      继承: successorName ? '继承国' : '无主',
      ...(successorName ? { 继承国: [successorName] } : {}),
    },
  ])
}

const destroyRegimeFromPanel = async () => {
  await destroyRegime(destroyDraft.value.政权名称, destroyDraft.value.继承国)
}

const handleSidebarDestroy = async (item: FloatingCountrySidebarItem) => {
  await destroyRegime(item.name)
}

/** 灭亡时不能把自己选成继承国。 */
const successorOptions = computed(() =>
  currentCountryNames.value.filter((name) => name !== destroyDraft.value.政权名称),
)

watch(
  currentCountryNames,
  (names) => {
    if (!names.includes(destroyDraft.value.政权名称)) {
      destroyDraft.value.政权名称 = names[0] ?? ''
    }

    if (destroyDraft.value.继承国 && !names.includes(destroyDraft.value.继承国)) {
      destroyDraft.value.继承国 = ''
    }
  },
  { immediate: true },
)

/* ------------------------------------------------------------------ *
 * 领土划转：把某个政权的若干地区挑出来交给另一个政权
 *
 * 与 AI 的 `领土` 变更是同一条底层路径，只是这里由玩家点选；
 * 边界情况（不存在、划走玩家国领土等）仍由 regime-change 里的校验兜住。
 * ------------------------------------------------------------------ */

interface TransferTerritoryRow {
  code: string
  level: TerritoryCodeLevel
  name: string
}

/** 来源政权当前持有的全部地区，带名称与级别。 */
const transferSourceTerritories = computed<TransferTerritoryRow[]>(() => {
  const countries = getCountriesFromPayload(activeWorldPayload.value)
  const index = findCountryIndex(countries, transferDraft.value.来源政权)
  const record = index >= 0 && isRecord(countries[index]) ? countries[index] : null

  if (!record) {
    return []
  }

  const buckets = readTerritoryBuckets(record.领土)
  const names = getTerritoryNamesFromPayload(activeWorldPayload.value)
  const rows: TransferTerritoryRow[] = []

  for (const level of CODE_LEVELS) {
    for (const code of buckets.codes[level]) {
      rows.push({ code, level, name: names[code] ?? code })
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
})

const filteredTransferTerritories = computed(() => {
  const keyword = transferDraft.value.关键词.trim().toLowerCase()

  if (!keyword) {
    return transferSourceTerritories.value
  }

  return transferSourceTerritories.value.filter(
    (row) => row.name.toLowerCase().includes(keyword) || row.code.toLowerCase().includes(keyword),
  )
})

const transferRecipientOptions = computed(() =>
  currentCountryNames.value.filter((name) => name !== transferDraft.value.来源政权),
)

const transferSelectionCount = computed(() => transferDraft.value.选中.length)

const isTransferSelected = (code: string) => transferDraft.value.选中.includes(code)

const toggleTransferTerritory = (code: string) => {
  const selected = transferDraft.value.选中

  transferDraft.value.选中 = selected.includes(code)
    ? selected.filter((item) => item !== code)
    : [...selected, code]
}

const selectAllFilteredTerritories = () => {
  const merged = new Set(transferDraft.value.选中)

  for (const row of filteredTransferTerritories.value) {
    merged.add(row.code)
  }

  transferDraft.value.选中 = [...merged]
}

const clearTransferSelection = () => {
  transferDraft.value.选中 = []
}

const applyTerritoryTransfer = async () => {
  const sourceName = transferDraft.value.来源政权
  const targetName = transferDraft.value.接收方
  const selection = transferDraft.value.选中

  if (!sourceName || !targetName) {
    errorText.value = '请选择来源政权与接收方。'
    return
  }

  if (!selection.length) {
    errorText.value = '请至少勾选一个地区。'
    return
  }

  if (sourceName === targetName) {
    errorText.value = '来源政权与接收方不能是同一个。'
    return
  }

  const requested: RegimeTerritorySummary = {}

  for (const row of transferSourceTerritories.value) {
    if (!selection.includes(row.code)) {
      continue
    }

    const bucket = requested[row.level]

    if (bucket) {
      bucket.push(row.code)
    } else {
      requested[row.level] = [row.code]
    }
  }

  const transferred = await applyManualRegimeChange([
    {
      类型: '领土',
      政权名称: targetName,
      来源政权: sourceName,
      领土: requested,
    },
  ])

  if (transferred) {
    transferDraft.value.选中 = []
  }
}

watch(
  () => transferDraft.value.来源政权,
  () => {
    transferDraft.value.选中 = []
    transferDraft.value.关键词 = ''
  },
)

watch(
  currentCountryNames,
  (names) => {
    if (!names.includes(transferDraft.value.来源政权)) {
      transferDraft.value.来源政权 = ''
      transferDraft.value.选中 = []
    }

    if (transferDraft.value.接收方 && !names.includes(transferDraft.value.接收方)) {
      transferDraft.value.接收方 = ''
    }
  },
  { immediate: true },
)

/** 应用 AI 回复里的政权变更；这里不允许动玩家操控的政权。 */
const applyAssistantRegimeChanges = (regimeChanges: readonly unknown[], trigger = '') => {
  const payload = activeWorldPayload.value

  if (!payload || !regimeChanges.length) {
    return
  }

  const result = applyRegimeChanges(
    getCountriesFromPayload(payload),
    activeCountryIndicators.value,
    getCountryColorMapFromPayload(payload),
    regimeChanges,
    { nameIndex: territoryNameIndex.value },
  )

  activeCountryIndicators.value = result.indicators
  writeCountryColorMap(payload, result.colorMap)
  recordRegimeTimelineChanges(result, 'ai', trigger)

  for (const [index, line] of result.applied.entries()) {
    const timeText = result.appliedChanges[index]?.时间 ?? result.appliedChanges[index]?.日期 ?? ''

    chatMessages.value.push({
      role: 'assistant',
      content: timeText ? `【${timeText}】${line}` : line,
    })
  }

  if (result.failed.length) {
    chatMessages.value.push({
      role: 'assistant',
      content: `未应用的政权变更：${result.failed.join('；')}`,
    })
  }

  for (const warning of result.warnings) {
    chatMessages.value.push({ role: 'assistant', content: `⚠ ${warning}` })
  }
}

const INDICATOR_CHANGE_KEYS = ['政治稳定', '经济发展', '国际影响'] as const

const formatIndicatorDelta = (value: number): string => {
  const text = formatIndicatorValue(value)

  return value > 0 ? `+${text}` : text
}

const clampIndicatorValue = (value: number): number =>
  Math.round(Math.max(-100, Math.min(100, value)) * 100) / 100

/**
 * 新格式 `数值增减` 用当前值加增量；旧格式 `国家指标` 直接取变更后的绝对值。
 * 返回 null 表示两个字段都无效。
 */
const resolveNextIndicators = (
  entry: Record<string, unknown>,
  previous: CountryIndicatorData | undefined,
): { next: CountryIndicatorData; delta: CountryIndicatorData } | null => {
  const deltaValue = entry.数值增减
  const absoluteValue = entry.国家指标
  const base = previous ?? { 政治稳定: 0, 经济发展: 0, 国际影响: 0 }

  if (isCountryIndicatorData(deltaValue)) {
    if (!INDICATOR_CHANGE_KEYS.every((key) => Number.isFinite(deltaValue[key]))) {
      return null
    }

    const next: CountryIndicatorData = {
      政治稳定: clampIndicatorValue(base.政治稳定 + deltaValue.政治稳定),
      经济发展: clampIndicatorValue(base.经济发展 + deltaValue.经济发展),
      国际影响: clampIndicatorValue(base.国际影响 + deltaValue.国际影响),
    }

    return {
      next,
      delta: {
        政治稳定: next.政治稳定 - base.政治稳定,
        经济发展: next.经济发展 - base.经济发展,
        国际影响: next.国际影响 - base.国际影响,
      },
    }
  }

  if (isCountryIndicatorData(absoluteValue)) {
    if (!INDICATOR_CHANGE_KEYS.every((key) => Number.isFinite(absoluteValue[key]))) {
      return null
    }

    const next: CountryIndicatorData = {
      政治稳定: clampIndicatorValue(absoluteValue.政治稳定),
      经济发展: clampIndicatorValue(absoluteValue.经济发展),
      国际影响: clampIndicatorValue(absoluteValue.国际影响),
    }

    return {
      next,
      delta: {
        政治稳定: next.政治稳定 - base.政治稳定,
        经济发展: next.经济发展 - base.经济发展,
        国际影响: next.国际影响 - base.国际影响,
      },
    }
  }

  return null
}

const handleAssistantResponse = async (responseText: string, trigger = '') => {
  const displayResponse = (text: string) => {
    const trimmed = text.trim()

    if (trimmed) {
      chatMessages.value.push({ role: 'assistant', content: trimmed })
    }
  }

  const jsonText = extractJsonFromText(responseText)

  if (!jsonText) {
    displayResponse(responseText)

    // 只有明确像变更 JSON 的回复才警告，普通叙述不打扰用户。
    if (
      responseText.includes('"数值增减"') ||
      responseText.includes('"国家指标"') ||
      /```(?:json)?/i.test(responseText)
    ) {
      chatMessages.value.push({
        role: 'assistant',
        content: '警告：没有找到完整可解析的 JSON，未应用任何变更。',
      })
    }
    return
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    console.error('无法解析 AI 返回的 JSON:', error)
    displayResponse(responseText)
    chatMessages.value.push({
      role: 'assistant',
      content: '警告：解析 AI 返回的 JSON 失败，未应用任何变更。',
    })
    return
  }

  const { indicatorEntries, regimeChanges } = splitAssistantChangePayload(parsed)
  const entries: unknown[] = indicatorEntries
  // 普通叙述里也可能出现示例 JSON；只有带变更字段的内容才进入应用流程。
  const looksLikeChangePayload = entries.some(
    (entry) =>
      isRecord(entry) &&
      ('数值增减' in entry ||
        '国家指标' in entry ||
        '国家' in entry ||
        '国家名称' in entry ||
        '描述' in entry),
  )

  if (!looksLikeChangePayload && !regimeChanges.length) {
    // 不是变更 JSON（例如提问时夹带的示例），照常显示原文。
    displayResponse(responseText)
    return
  }

  // 变更 JSON 只给程序读：对话框里只保留 JSON 前后的叙述，变更本身
  // 用下面的「国家 / 时间 / 描述 / 数值增减」摘要展示。
  displayResponse(stripJsonFromText(responseText, jsonText))

  const applied: string[] = []
  const failed: string[] = []

  for (const entry of entries) {
    if (!isRecord(entry)) {
      failed.push('无效条目：不是对象')
      continue
    }

    const countryName = readText(entry.国家) || readText(entry.国家名称)
    const desc = readText(entry.描述)
    const timeText = readText(entry.时间) || readText(entry.日期)
    const politicalSystemChange = readText(entry.政治制度改变)
    const economicStatusChange = readText(entry.经济状况改变)

    if (!countryName) {
      failed.push('无效条目：缺少 国家')
      continue
    }

    // 获取旧值以便对比
    const old = activeCountryIndicators.value[countryName]
    const resolved = resolveNextIndicators(entry, old)

    if (!resolved) {
      failed.push(`国家 ${countryName} 的 数值增减 字段无效或缺失`)
      continue
    }

    const nextIndicators = resolved.next

    // 应用变更到内存
    activeCountryIndicators.value = {
      ...activeCountryIndicators.value,
      [countryName]: nextIndicators,
    }

    // 同步到 activeWorldPayload 中对应国家的 国家指标 字段（如果存在该国家）
    try {
      const countries = getCountriesFromPayload(activeWorldPayload.value)

      for (const country of countries) {
        if (!isRecord(country)) continue

        const name = typeof country.国家名称 === 'string' ? country.国家名称.trim() : ''
        if (name === countryName) {
          country.国家指标 = { ...nextIndicators }

          if (politicalSystemChange) {
            country.政治制度 = politicalSystemChange
          }

          if (economicStatusChange) {
            country.经济状况 = economicStatusChange
          }
          break
        }
      }
    } catch (error) {
      console.error('同步到 activeWorldPayload 失败', error)
    }

    applied.push(countryName)

    // 对话框只展示国家、时间、描述与数值增减，不展示原始 JSON 或旧值/新值字段。
    const deltaText = INDICATOR_CHANGE_KEYS.map(
      (key) => `${key} ${formatIndicatorDelta(resolved.delta[key])}`,
    ).join('、')

    chatMessages.value.push({
      role: 'assistant',
      content: `已应用指标变更：${countryName}${timeText ? `（${timeText}）` : ''}；${desc || '无描述'}；${deltaText}`,
    })

    // 时间线以 AI 给出的具体时间为准；没有给时间时才落在回合时钟上。
    if (hasIndicatorChange(old, nextIndicators) || politicalSystemChange || economicStatusChange) {
      recordIndicatorTimelineEvent({
        country: countryName,
        indicators: nextIndicators,
        previous: old,
        description: desc,
        source: 'ai',
        trigger,
        timeText,
        politicalSystemChange,
        economicStatusChange,
      })
    }
  }

  // 政权变更要在持久化之前落库，这样存档与简报拿到的是同一份世界。
  applyAssistantRegimeChanges(regimeChanges, trigger)

  // 持久化
  refreshWorldContextMessage()
  try {
    saveCurrentWorldArchive()
  } catch (error) {
    console.error('保存变更到存档失败', error)
  }

  if (applied.length && !failed.length) {
    // 全部成功
    chatMessages.value.push({
      role: 'assistant',
      content: `已成功应用 ${applied.length} 条指标变更。`,
    })
  } else if (applied.length && failed.length) {
    chatMessages.value.push({
      role: 'assistant',
      content: `部分变更已应用：成功 ${applied.join(', ')}；失败 ${failed.join('; ')}`,
    })
  } else if (failed.length) {
    chatMessages.value.push({
      role: 'assistant',
      content: `未应用任何变更，原因：${failed.join('; ')}`,
    })
  }
}

const sendMessage = async () => {
  await submitChatContent(chatInput.value)
}

const sendPendingWorldLandPayload = async () => {
  const payload = pendingWorldLandPayload.value

  if (!payload) {
    return
  }

  hiddenPromptMessages.value = [
    {
      role: 'user',
      content: buildWorldTransferMessage(payload),
    },
  ]

  const sent = await submitChatContent('', { visibleInChat: false })

  if (sent) {
    setActiveWorldContext(payload)
    saveCurrentWorldArchive()
    clearWorldLandPayload()
  }
}

const closeActionMenu = () => {
  actionMenuOpen.value = false
}

const toggleActionMenu = () => {
  actionMenuOpen.value = !actionMenuOpen.value
}

const selectAction = (kind: EventDriveActionKind) => {
  activeActionKind.value = kind
  closeActionMenu()
}

const closeActionBuilder = () => {
  activeActionKind.value = null
}

const handleDocumentPointerDown = (event: PointerEvent) => {
  if (!actionMenuOpen.value) {
    return
  }

  const picker = actionPickerRef.value
  const target = event.target

  if (picker && target instanceof Node && picker.contains(target)) {
    return
  }

  closeActionMenu()
}

const handleTimeInput = (event: Event) => {
  const target = event.target as HTMLInputElement | null

  if (!target) {
    return
  }

  const digits = sanitizeTimeDigits(target.value)
  actionInput.value.time = digits

  if (target.value !== digits) {
    target.value = digits
  }
}

const resetActionTextInputs = () => {
  actionInput.value.time = ''
  actionInput.value.event = ''
  actionInput.value.topic = ''
  actionInput.value.question = ''
  actionInput.value.setting1 = ''
  actionInput.value.setting2 = ''
}

const sendActionPrompt = async () => {
  if (!actionPromptReady.value || isSending.value) {
    return
  }

  const sent = await submitChatContent(actionPrompt.value)

  if (sent) {
    resetActionTextInputs()
  }
}

const fillActionPromptIntoComposer = () => {
  if (!actionPromptReady.value) {
    return
  }

  const existingPrompt = chatInput.value.trim()
  chatInput.value = existingPrompt ? `${existingPrompt}\n${actionPrompt.value}` : actionPrompt.value
  closeActionBuilder()
}

const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendMessage()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)

  const isFreshSession = window.sessionStorage.getItem(EVENT_DRIVE_FRESH_SESSION_KEY) === 'true'

  if (isFreshSession) {
    window.sessionStorage.removeItem(EVENT_DRIVE_FRESH_SESSION_KEY)
    clearChatWindowDraft()
    clearSelectedSnapshot()
  } else {
    loadChatWindowDraft()
  }

  snapshotHistory.value = readSnapshotHistory()

  const scenarioTransfer = readScenarioTransferPayload()
  // 剧本交接优先于世界包：同一局推演以最近一次明确发送的剧本为准。
  const worldLandState = scenarioTransfer ? null : readWorldLandPayload()
  const archive = isFreshSession ? {} : readEventDriveArchive()
  const selectedArchiveKey = isFreshSession
    ? ''
    : resolveArchiveKey(worldLandState?.payload ?? null, archive)

  if (scenarioTransfer) {
    const scenarioPayload = createWorldPayloadFromScenario(scenarioTransfer)

    // 新剧本要作为全新开局：丢掉可能残留的世界包交接，避免下次打开被旧世界覆盖。
    window.sessionStorage.removeItem(WORLD_PACKAGE_TRANSFER_KEY)
    window.sessionStorage.removeItem(WORLD_JSON_TRANSFER_KEY)
    window.sessionStorage.removeItem(WORLD_LAND_TRANSFER_KEY)
    pendingWorldLandPayload.value = null
    pendingWorldLandSource.value = null
    chatMessages.value = []
    chatInput.value = ''
    hiddenPromptMessages.value = []
    errorText.value = ''
    clearChatWindowDraft()
    setActiveWorldContext(scenarioPayload)
    saveCurrentWorldArchive()
    clearSelectedSnapshot()
    clearScenarioTransferPayload()
  } else if (!isFreshSession && selectedArchiveKey && archive[selectedArchiveKey]) {
    applyArchiveEntry(selectedArchiveKey, archive[selectedArchiveKey])
  } else if (worldLandState) {
    pendingWorldLandPayload.value = worldLandState.payload
    pendingWorldLandSource.value = worldLandState.source
    setActiveWorldContext(worldLandState.payload)
  } else if (!isFreshSession && Object.keys(archive).length === 1) {
    const [singleWorldKey] = Object.keys(archive)

    if (singleWorldKey && archive[singleWorldKey]) {
      applyArchiveEntry(singleWorldKey, archive[singleWorldKey])
    }
  }

  const persistedSnapshotId = isFreshSession
    ? null
    : window.localStorage.getItem(EVENT_DRIVE_SELECTED_SNAPSHOT_KEY)
  const selectedSnapshot =
    persistedSnapshotId && snapshotHistory.value.find((entry) => entry.id === persistedSnapshotId)

  if (selectedSnapshot) {
    applySnapshotEntry(selectedSnapshot)
  }

  void scrollToBottom()

  if (
    hasApiKey.value &&
    pendingWorldLandPayload.value &&
    pendingWorldLandSource.value === 'session'
  ) {
    void sendPendingWorldLandPayload()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
})

watch(
  [chatInput, chatMessages],
  () => {
    if (activeWorldPayload.value) {
      saveCurrentWorldArchive()
    }

    saveChatWindowDraft()
  },
  { deep: true },
)

watch(
  chatMessages,
  (messages) => {
    const lastMessage = messages[messages.length - 1]

    if (lastMessage?.role === 'assistant') {
      void scrollToBottom()
    }
  },
  { deep: true },
)

watch(hasApiKey, (ready) => {
  if (ready && pendingWorldLandPayload.value && pendingWorldLandSource.value === 'session') {
    void sendPendingWorldLandPayload()
  }
})

const selectedSnapshotLabel = computed(() => {
  if (selectedSnapshotId.value === LIVE_SESSION_SNAPSHOT_ID) {
    return '当前会话'
  }

  return (
    snapshotHistory.value.find((entry) => entry.id === selectedSnapshotId.value)?.label ||
    '当前会话'
  )
})
</script>

<template>
  <main class="page-shell">
    <div class="page-grid">
      <div class="main-column">
        <section class="page-header panel">
          <div class="page-header-copy">
            <p class="page-kicker">AI 对话</p>
            <h1 class="page-title">事件驱动</h1>
            <p class="page-description">
              围绕事件链路、消息流、状态变化和异常排查，直接和 AI 对话。
            </p>
          </div>
        </section>

        <section class="chat-panel panel">
          <div class="chat-header">
            <div>
              <h2>AI 对话框</h2>
              <p>Enter 发送，Shift + Enter 换行。</p>
            </div>

            <div class="chat-actions">
              <div class="snapshot-picker" @keydown.esc="closeSnapshotMenu">
                <button
                  class="snapshot-trigger"
                  type="button"
                  :aria-expanded="snapshotMenuOpen"
                  aria-haspopup="menu"
                  @click="toggleSnapshotMenu"
                >
                  <span>归档历史</span>
                  <strong>{{ selectedSnapshotLabel }}</strong>
                </button>

                <div v-if="snapshotMenuOpen" class="snapshot-menu" role="menu">
                  <button
                    class="snapshot-menu-item"
                    type="button"
                    role="menuitem"
                    @click="selectSnapshotById(LIVE_SESSION_SNAPSHOT_ID)"
                  >
                    <span class="snapshot-menu-label">当前会话</span>
                  </button>

                  <div v-if="snapshotHistory.length" class="snapshot-menu-divider"></div>

                  <div v-for="snapshot in snapshotHistory" :key="snapshot.id" class="snapshot-row">
                    <button
                      class="snapshot-menu-item"
                      type="button"
                      role="menuitem"
                      @click="selectSnapshotById(snapshot.id)"
                    >
                      <span class="snapshot-menu-label">{{ snapshot.label }}</span>
                    </button>

                    <button
                      class="snapshot-delete-button"
                      type="button"
                      aria-label="删除快照"
                      @click.stop="deleteSnapshotById(snapshot.id)"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
              <button class="ghost-button" type="button" @click="triggerArchiveImport">
                导入存档
              </button>
              <button class="ghost-button" type="button" @click="exportEventDriveArchive">
                导出存档
              </button>
              <button class="ghost-button" type="button" @click="goToTimeline">时间线</button>
              <button class="ghost-button" type="button" @click="resetChat">重置世界</button>
              <button class="ghost-button" type="button" @click="reinjectPrompt">
                重新注入提示词
              </button>
            </div>
          </div>

          <input
            ref="archiveImportInputRef"
            class="archive-import-input"
            type="file"
            accept="application/json,.json"
            @change="importEventDriveArchive"
          />

          <div ref="chatListRef" class="message-list" aria-live="polite">
            <article
              v-for="(message, index) in chatMessages"
              :key="index"
              class="message-item"
              :class="message.role"
            >
              <div class="message-meta">{{ message.role === 'assistant' ? 'AI' : '我' }}</div>
              <div class="message-bubble">{{ message.content }}</div>
            </article>
          </div>

          <div class="composer">
            <div class="action-toolbar">
              <div ref="actionPickerRef" class="action-picker" @keydown.esc="closeActionMenu">
                <button
                  class="action-trigger"
                  type="button"
                  :aria-expanded="actionMenuOpen"
                  aria-haspopup="menu"
                  @click="toggleActionMenu"
                >
                  <span class="action-trigger-label">事件推进</span>
                  <strong>{{ activeActionLabel }}</strong>
                  <span class="action-trigger-caret" aria-hidden="true">▾</span>
                </button>

                <div
                  v-if="actionMenuOpen"
                  class="action-menu"
                  role="menu"
                  aria-label="事件推进指令"
                >
                  <button
                    v-for="option in EVENT_DRIVE_ACTIONS"
                    :key="option.kind"
                    class="action-menu-item"
                    :class="{ 'is-active': activeActionKind === option.kind }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="activeActionKind === option.kind"
                    @click="selectAction(option.kind)"
                  >
                    <span class="action-menu-label">{{ option.label }}</span>
                    <span class="action-menu-description">{{ option.description }}</span>
                  </button>
                </div>
              </div>

              <p class="action-toolbar-hint">选择指令后按模板填写，固定文字会随指令一起发送。</p>
            </div>

            <form
              v-if="activeActionKind"
              class="action-builder"
              aria-label="事件推进指令编辑"
              @submit.prevent="sendActionPrompt"
            >
              <div class="action-builder-header">
                <div>
                  <h3 class="action-builder-title">{{ activeActionLabel }}</h3>
                  <p class="action-builder-description">{{ activeActionOption?.description }}</p>
                </div>
                <button class="action-builder-close" type="button" @click="closeActionBuilder">
                  收起
                </button>
              </div>

              <p
                v-if="activeActionNeedsCountry && !hasCurrentCountries"
                class="action-builder-empty"
              >
                当前世界还没有国家数据，请先发送世界观 JSON 后再使用该指令。
              </p>

              <div v-if="activeActionKind === 'time'" class="action-template">
                <span class="action-fixed">时间推进</span>
                <input
                  :value="actionInput.time"
                  class="action-input action-input-time"
                  type="text"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  autocomplete="off"
                  placeholder="数量"
                  aria-label="时间数量"
                  :disabled="isSending"
                  @input="handleTimeInput"
                />
                <select
                  v-model="actionInput.timeUnit"
                  class="action-select"
                  aria-label="时间单位"
                  :disabled="isSending"
                >
                  <option v-for="unit in EVENT_DRIVE_TIME_UNITS" :key="unit" :value="unit">
                    {{ unit }}
                  </option>
                </select>
              </div>

              <div v-else-if="activeActionKind === 'event'" class="action-template">
                <select
                  v-model="actionInput.country"
                  class="action-select action-select-country"
                  aria-label="国家"
                  :disabled="!hasCurrentCountries || isSending"
                >
                  <option v-if="!hasCurrentCountries" value="">暂无可选国家</option>
                  <option
                    v-for="countryName in currentCountryNames"
                    :key="countryName"
                    :value="countryName"
                  >
                    {{ countryName }}
                  </option>
                </select>
                <span class="action-fixed">发生</span>
                <input
                  v-model="actionInput.event"
                  class="action-input action-input-grow"
                  type="text"
                  placeholder="事件，例如：政变"
                  aria-label="事件内容"
                  :disabled="isSending"
                />
              </div>

              <div v-else-if="activeActionKind === 'story'" class="action-template">
                <span class="action-fixed">请讲述一个在</span>
                <select
                  v-model="actionInput.country"
                  class="action-select action-select-country"
                  aria-label="国家"
                  :disabled="!hasCurrentCountries || isSending"
                >
                  <option v-if="!hasCurrentCountries" value="">暂无可选国家</option>
                  <option
                    v-for="countryName in currentCountryNames"
                    :key="countryName"
                    :value="countryName"
                  >
                    {{ countryName }}
                  </option>
                </select>
                <span class="action-fixed">发生的，主题为</span>
                <input
                  v-model="actionInput.topic"
                  class="action-input action-input-grow"
                  type="text"
                  placeholder="主题，例如：战争"
                  aria-label="故事主题"
                  :disabled="isSending"
                />
                <span class="action-fixed">的故事</span>
              </div>

              <div v-else-if="activeActionKind === 'question'" class="action-template">
                <input
                  v-model="actionInput.question"
                  class="action-input action-input-grow"
                  type="text"
                  placeholder="问题内容，例如：某国的政治制度是什么"
                  aria-label="问题内容"
                  :disabled="isSending"
                />
                <span class="action-fixed">?</span>
              </div>

              <div v-else-if="activeActionKind === 'conflict'" class="action-template">
                <span class="action-fixed">设定</span>
                <input
                  v-model="actionInput.setting1"
                  class="action-input action-input-grow"
                  type="text"
                  placeholder="设定 1"
                  aria-label="设定 1"
                  :disabled="isSending"
                />
                <span class="action-fixed">与设定</span>
                <input
                  v-model="actionInput.setting2"
                  class="action-input action-input-grow"
                  type="text"
                  placeholder="设定 2"
                  aria-label="设定 2"
                  :disabled="isSending"
                />
                <span class="action-fixed">冲突，请给出一个合理解释或修正后一个设定</span>
              </div>

              <div class="action-preview">
                <span class="action-preview-label">将发送</span>
                <code class="action-preview-text">{{ actionPrompt }}</code>
              </div>

              <div class="action-builder-footer">
                <button
                  class="primary-button"
                  type="submit"
                  :disabled="!actionPromptReady || isSending"
                >
                  {{ isSending ? '发送中...' : '发送' }}
                </button>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!actionPromptReady || isSending"
                  @click="fillActionPromptIntoComposer"
                >
                  填入输入框
                </button>
              </div>
            </form>

            <textarea
              v-model="chatInput"
              class="composer-input"
              placeholder="输入你想问 AI 的内容，例如：如何设计事件驱动的消息重试？"
              rows="4"
              :disabled="isSending"
              @keydown="handleComposerKeydown"
            />

            <div class="composer-footer">
              <p v-if="errorText" class="error-text">{{ errorText }}</p>
              <button
                class="primary-button"
                type="button"
                :disabled="isSending || !chatInput.trim()"
                @click="sendMessage"
              >
                {{ isSending ? '发送中...' : '发送' }}
              </button>
            </div>
          </div>
        </section>
      </div>

      <aside class="side-column">
        <section v-if="activeScenarioSummary" class="status-card panel">
          <h2 class="status-title">当前剧本</h2>
          <strong>{{ activeScenarioSummary.name }}</strong>
          <p>开局时间：{{ activeScenarioSummary.startTime }}</p>
          <p>
            {{ activeScenarioSummary.countryCount }} 个政权 · 玩家操控
            {{ activeScenarioSummary.playerControlledCount }} 个
          </p>
          <p class="status-note">
            每轮发送国家简报（约
            {{ activeScenarioSummary.briefTokens.toLocaleString('zh-CN') }}
            tokens）；消息中出现国家名时自动附加该国详细档案。
          </p>
        </section>

        <section v-if="hasCurrentCountries" class="status-card panel regime-panel">
          <h2 class="status-title">政权管理</h2>
          <p class="status-note">
            推演中可以直接建立或灭亡政权。领土按编号在政权之间迁移，改动会写入存档并进入下一轮简报。
          </p>

          <form class="regime-form" aria-label="建立政权" @submit.prevent="createRegimeFromPanel">
            <label class="regime-field">
              <span class="regime-field-label">新政权名称</span>
              <input
                v-model="regimeDraft.国家名称"
                class="regime-input"
                type="text"
                placeholder="例如：波兰人民共和国"
              />
            </label>

            <label class="regime-field">
              <span class="regime-field-label">政体</span>
              <input
                v-model="regimeDraft.政体"
                class="regime-input"
                type="text"
                placeholder="例如：人民民主共和国"
              />
            </label>

            <label class="regime-field">
              <span class="regime-field-label">领土来源</span>
              <select v-model="regimeDraft.取代政权" class="regime-input">
                <option value="">暂不划入（之后让 AI 补）</option>
                <option v-for="name in currentCountryNames" :key="name" :value="name">
                  取代「{{ name }}」：它灭亡，全部领土转给新政权
                </option>
              </select>
            </label>

            <div class="regime-indicators">
              <label class="regime-field">
                <span class="regime-field-label">政治稳定</span>
                <input
                  v-model.number="regimeDraft.政治稳定"
                  class="regime-input"
                  type="number"
                  min="-100"
                  max="100"
                  step="1"
                />
              </label>
              <label class="regime-field">
                <span class="regime-field-label">经济发展</span>
                <input
                  v-model.number="regimeDraft.经济发展"
                  class="regime-input"
                  type="number"
                  min="-100"
                  max="100"
                  step="1"
                />
              </label>
              <label class="regime-field">
                <span class="regime-field-label">国际影响</span>
                <input
                  v-model.number="regimeDraft.国际影响"
                  class="regime-input"
                  type="number"
                  min="-100"
                  max="100"
                  step="1"
                />
              </label>
            </div>

            <label class="regime-checkbox">
              <input v-model="regimeDraft.玩家操控" type="checkbox" />
              <span>由玩家操控（AI控制: false）</span>
            </label>

            <button
              class="secondary-button regime-submit"
              type="submit"
              :disabled="isSending || !regimeDraft.国家名称.trim()"
            >
              建立政权
            </button>
          </form>

          <hr class="regime-divider" />

          <form class="regime-form" aria-label="灭亡政权" @submit.prevent="destroyRegimeFromPanel">
            <label class="regime-field">
              <span class="regime-field-label">要灭亡的政权</span>
              <select v-model="destroyDraft.政权名称" class="regime-input">
                <option v-for="name in currentCountryNames" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
            </label>

            <label class="regime-field">
              <span class="regime-field-label">领土继承</span>
              <select v-model="destroyDraft.继承国" class="regime-input">
                <option value="">无主（直接移除）</option>
                <option v-for="name in successorOptions" :key="name" :value="name">
                  {{ name }} 接管全部领土
                </option>
              </select>
            </label>

            <button
              class="secondary-button regime-submit regime-submit-danger"
              type="submit"
              :disabled="isSending || !destroyDraft.政权名称"
            >
              灭亡政权
            </button>
          </form>
        </section>

        <section v-if="hasCurrentCountries" class="status-card panel regime-panel">
          <h2 class="status-title">领土划转</h2>
          <p class="status-note">
            选来源政权和地区，再选接收方。地区名来自剧本，没有名称时显示编号。
          </p>

          <form class="regime-form" aria-label="领土划转" @submit.prevent="applyTerritoryTransfer">
            <label class="regime-field">
              <span class="regime-field-label">来源政权</span>
              <select v-model="transferDraft.来源政权" class="regime-input">
                <option value="">选择政权</option>
                <option v-for="name in currentCountryNames" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
            </label>

            <p v-if="transferDraft.来源政权" class="regime-note">
              共 {{ transferSourceTerritories.length }} 条领土，已选 {{ transferSelectionCount }} 条
            </p>

            <template v-if="transferSourceTerritories.length">
              <input
                v-model="transferDraft.关键词"
                class="regime-input"
                type="search"
                placeholder="搜索地区名或编号"
              />

              <div class="transfer-actions">
                <button
                  class="ghost-button transfer-action"
                  type="button"
                  @click="selectAllFilteredTerritories"
                >
                  全选搜索结果
                </button>
                <button
                  class="ghost-button transfer-action"
                  type="button"
                  @click="clearTransferSelection"
                >
                  清空选择
                </button>
              </div>

              <ul class="transfer-list">
                <li v-for="row in filteredTransferTerritories" :key="row.code">
                  <label class="transfer-option">
                    <input
                      type="checkbox"
                      :checked="isTransferSelected(row.code)"
                      @change="toggleTransferTerritory(row.code)"
                    />
                    <span class="transfer-option-name">{{ row.name }}</span>
                    <span class="transfer-option-code">{{ row.code }}</span>
                  </label>
                </li>
              </ul>

              <p v-if="!filteredTransferTerritories.length" class="regime-note">没有匹配的地区。</p>

              <label class="regime-field">
                <span class="regime-field-label">接收方</span>
                <select v-model="transferDraft.接收方" class="regime-input">
                  <option value="">选择接收政权</option>
                  <option v-for="name in transferRecipientOptions" :key="name" :value="name">
                    {{ name }}
                  </option>
                </select>
              </label>

              <button
                class="secondary-button regime-submit"
                type="submit"
                :disabled="isSending || !transferSelectionCount || !transferDraft.接收方"
              >
                划转 {{ transferSelectionCount }} 个地区
              </button>
            </template>

            <p v-else-if="transferDraft.来源政权" class="regime-note">
              这个政权没有可划转的地区编号（例如手绘国土或纯自定义多边形）。
            </p>
          </form>
        </section>

        <section class="status-card panel">
          <h2 class="status-title">当前配置</h2>
          <strong>{{ settingsSummary }}</strong>
          <p>{{ hasApiKey ? 'API Key 已就绪' : '尚未配置 API Key，请先完成设置。' }}</p>
          <p class="status-note">当前对话框支持 OpenAI 和 DeepSeek。</p>
          <button class="secondary-button" type="button" @click="goToSetting">去设置</button>
        </section>

        <aside class="tips-panel panel">
          <h3>可以问什么</h3>
          <ul>
            <li>时间推进：例如“推进时间 1 年”，让 AI 基于当前世界继续推演。</li>
            <li>事件触发：例如“某国发生政变”或“某地发生自然灾害”。</li>
            <li>故事发展：从一段日常描写里提取可能影响事件走向的线索。</li>
            <li>讲述故事：让 AI 讲某个国家、战争或时期中的人物故事。</li>
            <li>提问：例如“某国的政治制度是什么？”或“国家 A 和国家 B 是否接壤”。</li>
            <li>矛盾修正：当前后叙述冲突时，让 AI 指出矛盾并要求补充信息。</li>
            <li>也可以使用输入框上方的「事件推进」下拉菜单，按模板快速发送上述指令。</li>
          </ul>
        </aside>
      </aside>
    </div>

    <FloatingCountrySidebar
      v-if="countrySidebarItems.length"
      :items="countrySidebarItems"
      title="国家列表"
      empty-text="当前世界没有国家数据"
      :destroyable="!isSending"
      @edit-stat="handleEditStat"
      @destroy="handleSidebarDestroy"
    />
  </main>
</template>

<style scoped>
.page-shell {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 32px;
  height: calc(100vh - 64px);
  min-height: calc(100vh - 64px);
  overflow: hidden;
}

.page-grid {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.75fr);
  gap: 24px;
  align-items: stretch;
  min-height: 0;
}

.main-column,
.side-column {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.main-column {
  flex: 1;
  min-height: 0;
}

/* 侧栏卡片比主列高，单独允许滚动，避免「政权管理」被裁掉。 */
.side-column {
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.panel {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
}

.page-header {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.9fr);
  gap: 24px;
  padding: 24px;
}

.page-header-copy {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
}

.page-kicker {
  margin: 0;
  font-size: 14px;
  color: var(--color-text);
  opacity: 0.75;
}

.page-title {
  margin: 0;
  font-size: 24px;
  color: var(--color-heading);
}

.page-description {
  margin: 0;
  color: var(--color-text);
  opacity: 0.8;
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  align-self: stretch;
}

.status-title {
  margin: 0;
  font-size: 18px;
  color: var(--color-heading);
}

.status-card strong {
  font-size: 1.05rem;
  color: var(--color-text);
}

.status-card p {
  margin: 0;
  color: var(--color-text);
  opacity: 0.8;
  line-height: 1.6;
}

.regime-panel {
  gap: 14px;
}

.regime-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.regime-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.regime-field-label {
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--color-text);
  opacity: 0.72;
}

.regime-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  font: inherit;
  font-size: 13px;
}

.regime-input:focus-visible {
  outline: none;
  border-color: var(--color-heading);
}

.regime-indicators {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.regime-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text);
  opacity: 0.85;
}

.regime-submit {
  align-self: flex-start;
}

.regime-submit-danger:hover:not(:disabled) {
  border-color: #d64545;
  color: #d64545;
}

.regime-divider {
  width: 100%;
  margin: 0;
  border: 0;
  border-top: 1px dashed var(--color-border);
}

.regime-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text);
  opacity: 0.75;
}

.transfer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.transfer-action {
  padding: 6px 10px;
  font-size: 12px;
}

.transfer-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
}

.transfer-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.transfer-option:hover {
  background: color-mix(in srgb, var(--color-border) 35%, transparent);
}

.transfer-option-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transfer-option-code {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.chat-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.6fr);
  gap: 24px;
  align-items: start;
  min-height: 0;
}

.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.tips-panel {
  padding: 20px;
  min-height: 0;
}

.tips-panel h3 {
  margin: 0;
  font-size: 18px;
  color: var(--color-heading);
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--color-border);
  flex: 0 0 auto;
}

.chat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.snapshot-picker {
  position: relative;
  min-width: 240px;
}

.snapshot-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
}

.snapshot-trigger span {
  white-space: nowrap;
  opacity: 0.82;
}

.snapshot-trigger strong {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snapshot-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: min(420px, 80vw);
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.12);
}

.snapshot-menu-divider {
  height: 1px;
  margin: 8px 0;
  background: var(--color-border);
}

.snapshot-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.snapshot-menu-item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.snapshot-menu-item:hover,
.snapshot-delete-button:hover {
  background: var(--color-background-soft);
}

.snapshot-menu-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snapshot-delete-button {
  flex: 0 0 auto;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: #d92d20;
  cursor: pointer;
  font: inherit;
}

.archive-import-input {
  display: none;
}

.chat-header h2 {
  margin: 0;
  font-size: 18px;
  color: var(--color-heading);
}

.chat-header p {
  margin: 8px 0 0;
  color: var(--color-text);
  opacity: 0.75;
}

.message-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  overflow: auto;
  flex: 1;
  min-height: 0;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border-hover) var(--color-background-soft);
}

.message-list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.message-list::-webkit-scrollbar-track {
  background: var(--color-background-soft);
  border-radius: 999px;
}

.message-list::-webkit-scrollbar-thumb {
  background: var(--color-border-hover);
  border-radius: 999px;
  border: 2px solid var(--color-background-soft);
}

.message-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-border);
}

.message-item {
  display: grid;
  gap: 8px;
}

.message-item.user {
  justify-items: end;
}

.message-meta {
  font-size: 12px;
  color: var(--color-text);
  opacity: 0.75;
}

.message-bubble {
  max-width: min(72ch, 100%);
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-item.assistant .message-bubble {
  background: var(--color-background-soft);
  color: var(--color-text);
}

.message-item.user .message-bubble {
  background: var(--color-background);
  color: var(--color-text);
}

.composer {
  padding: 20px;
  border-top: 1px solid var(--color-border);
  flex: 0 0 auto;
}

.action-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.action-picker {
  position: relative;
  flex: 0 0 auto;
  min-width: 240px;
}

.action-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.action-trigger:hover {
  border-color: var(--color-border-hover);
}

.action-trigger-label {
  flex-shrink: 0;
  opacity: 0.82;
}

.action-trigger strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-trigger-caret {
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.72;
}

.action-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: min(420px, 80vw);
  max-height: 60vh;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.12);
}

.action-menu-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.action-menu-item:hover,
.action-menu-item.is-active {
  background: var(--color-background-soft);
}

.action-menu-label {
  font-weight: 700;
}

.action-menu-description {
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.75;
}

.action-toolbar-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text);
  opacity: 0.7;
}

.action-builder {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
}

.action-builder-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.action-builder-title {
  margin: 0;
  font-size: 15px;
  color: var(--color-heading);
}

.action-builder-description {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text);
  opacity: 0.78;
}

.action-builder-close {
  flex-shrink: 0;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}

.action-builder-close:hover {
  border-color: var(--color-border-hover);
}

.action-builder-empty {
  margin: 0;
  color: #d92d20;
  font-size: 13px;
  line-height: 1.6;
}

.action-template {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  line-height: 1.8;
}

.action-fixed {
  color: var(--color-text);
}

.action-input,
.action-select {
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  font: inherit;
  font-size: 14px;
}

.action-input:focus,
.action-select:focus {
  outline: none;
  border-color: var(--color-border-hover);
}

.action-input:disabled,
.action-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-input-time {
  width: 6.5em;
}

.action-input-grow {
  flex: 1 1 180px;
  min-width: 160px;
}

.action-select-country {
  min-width: 120px;
  max-width: 220px;
}

.action-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--color-border-hover);
  border-radius: 8px;
  background: var(--color-background);
}

.action-preview-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-text);
  opacity: 0.7;
}

.action-preview-text {
  color: var(--color-text);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.action-builder-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.action-builder-footer .primary-button,
.action-builder-footer .ghost-button {
  padding: 9px 18px;
}

.action-builder-footer .ghost-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-input {
  width: 100%;
  resize: vertical;
  min-height: 118px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  font: inherit;
  line-height: 1.7;
  outline: none;
}

.composer-input:focus {
  border-color: var(--color-border-hover);
}

.composer-input:disabled {
  opacity: 0.7;
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
}

.error-text {
  margin: 0;
  color: #d92d20;
  font-size: 0.92rem;
}

.tips-panel ul {
  margin: 14px 0 0;
  padding-left: 18px;
  color: var(--color-text);
  opacity: 0.8;
  line-height: 1.9;
}

.primary-button,
.secondary-button,
.ghost-button {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    opacity 0.18s ease;
  background: var(--color-background);
  color: var(--color-text);
}

.primary-button:hover:not(:disabled),
.secondary-button:hover,
.ghost-button:hover {
  transform: translateY(-1px);
}

.primary-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.primary-button {
  padding: 12px 22px;
  background: var(--color-background);
}

.secondary-button {
  padding: 11px 18px;
}

.ghost-button {
  padding: 10px 16px;
}

@media (max-width: 960px) {
  .page-shell {
    padding: 24px;
    height: calc(100vh - 48px);
    min-height: calc(100vh - 48px);
  }

  .page-grid {
    grid-template-columns: 1fr;
  }

  .chat-panel {
    min-height: 480px;
    flex: 0 0 auto;
  }
}

@media (max-width: 640px) {
  .page-shell {
    padding: 16px;
  }

  .chat-header,
  .composer,
  .tips-panel {
    padding-left: 18px;
    padding-right: 18px;
  }

  .chat-header,
  .composer-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .snapshot-picker {
    min-width: 0;
  }

  .snapshot-menu {
    width: 100%;
  }

  .action-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .action-picker {
    min-width: 0;
  }

  .action-menu {
    width: 100%;
  }

  .action-builder {
    padding: 14px;
  }

  .action-input-grow {
    flex-basis: 100%;
    min-width: 0;
  }

  .primary-button,
  .secondary-button,
  .ghost-button {
    width: 100%;
  }
}
</style>
