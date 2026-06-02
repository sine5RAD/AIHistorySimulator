<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { useAiSettings } from '@/composables/ai-settings'
import { defaultEventDrivePrompt } from '@/composables/prompt-defaults'
import { submitPreparedPrompt } from '@/utils/submit-commition'
import FloatingCountrySidebar, {
  type FloatingCountrySidebarItem,
} from '@/components/floating-country-sidebar/floating-country-sidebar.vue'
import type { CountryIndicatorData } from '@/types/country'

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

interface WorldLandTransferState {
  payload: WorldLandTransferPayload
  source: 'session' | 'local'
}

interface EventDriveArchiveEntry {
  world: WorldLandTransferPayload
  countryIndicators: Record<string, CountryIndicatorData>
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
const EVENT_DRIVE_FRESH_SESSION_KEY = 'event-drive-fresh-session'
const LIVE_SESSION_SNAPSHOT_ID = '__live__'

const router = useRouter()
const { apiValue, selectedModel, selectedProvider } = useAiSettings()

const chatInput = ref('')
const chatMessages = ref<ChatMessage[]>([])
const hiddenPromptMessages = ref<PromptMessage[]>([])
const worldContextMessage = ref<PromptMessage | null>(null)
const activeWorldPayload = ref<WorldLandTransferPayload | null>(null)
const activeCountryIndicators = ref<Record<string, CountryIndicatorData>>({})
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
      ],
      summary: formatBriefSummary(record),
    }
  })
})

const systemPrompt = defaultEventDrivePrompt

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

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

const getWorldArchiveKey = (payload: WorldLandTransferPayload | null) => {
  if (!payload) {
    return ''
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
  const worldName = world?.currentCountryName?.trim() || '未命名世界'
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
  activeWorldKey.value = ''
  worldContextMessage.value = null
}

const applySnapshotEntry = (snapshot: EventDriveSnapshotEntry) => {
  if (snapshot.world) {
    setActiveWorldContext(snapshot.world)
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
  activeWorldKey.value = getWorldArchiveKey(payload)
  worldContextMessage.value = {
    role: 'user',
    content: buildWorldTransferMessage(payload),
  }

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

const buildWorldTransferMessage = (payload: WorldLandTransferPayload) => {
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

const submitChatContent = async (content: string, options?: { visibleInChat?: boolean }) => {
  const visibleInChat = options?.visibleInChat ?? true
  const trimmedContent = content.trim()
  const hasHiddenPrompt = hiddenPromptMessages.value.length > 0

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
    const response = await submitPreparedPrompt(buildPreparedPrompt())

    if (!response?.trim()) {
      errorText.value = '模型没有返回有效结果。'
      chatMessages.value.push({
        role: 'assistant',
        content: '暂时没有拿到回复，请稍后重试。',
      })
      return false
    }

    chatMessages.value.push({
      role: 'assistant',
      content: response.trim(),
    })

    // 尝试解析并应用 AI 在回复中包含的指标变更 JSON（如果存在）
    try {
      await handleAssistantResponse(response.trim())
    } catch (error) {
      console.error('处理 AI 回复中的指标变更时发生错误', error)
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

const buildPreparedPrompt = () => ({
  provider: selectedProvider.value,
  model: selectedModel.value,
  messages: [
    {
      role: 'system' as const,
      content: systemPrompt,
    },
    ...(worldContextMessage.value ? [worldContextMessage.value] : []),
    ...hiddenPromptMessages.value,
    ...chatMessages.value.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ],
})

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

const extractJsonFromText = (text: string): string | null => {
  // 首先尝试寻找 ```json ... ``` 区块
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i)

  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim()
  }

  // 其次尝试直接匹配包含 国家指标 的 JSON 对象
  const roughMatch = text.match(/\{[\s\S]*?"国家指标"[\s\S]*?\}/)

  if (roughMatch && roughMatch[0]) {
    return roughMatch[0]
  }

  return null
}

const handleAssistantResponse = async (responseText: string) => {
  const jsonText = extractJsonFromText(responseText)

  if (!jsonText) {
    return
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    console.error('无法解析 AI 返回的 JSON:', error)
    chatMessages.value.push({
      role: 'assistant',
      content: '警告：解析 AI 返回的 JSON 失败，未应用任何变更。',
    })
    return
  }

  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed]

  const applied: string[] = []
  const failed: string[] = []

  for (const entry of entries) {
    if (!isRecord(entry)) {
      failed.push('无效条目：不是对象')
      continue
    }

    const countryName = typeof entry.国家名称 === 'string' ? entry.国家名称.trim() : ''
    const desc = typeof entry.描述 === 'string' ? entry.描述.trim() : ''
    const indicators = (entry as Record<string, unknown>).国家指标

    if (!countryName) {
      failed.push('无效条目：缺少 国家名称')
      continue
    }

    if (!isCountryIndicatorData(indicators)) {
      failed.push(`国家 ${countryName} 的 国家指标 字段无效或缺失`)
      continue
    }

    // 本地校验：数值有限且为 number
    const checkProblems: string[] = []

    for (const key of ['政治稳定', '经济发展', '国际影响'] as const) {
      const v = (indicators as unknown as Record<string, number>)[key]

      if (!Number.isFinite(v)) {
        checkProblems.push(`${key} 不是有限数字`)
      }
    }

    if (checkProblems.length) {
      failed.push(`${countryName} 校验失败：${checkProblems.join('; ')}`)
      continue
    }

    // 获取旧值以便对比
    const old = activeCountryIndicators.value[countryName]

    // 应用变更到内存
    activeCountryIndicators.value = {
      ...activeCountryIndicators.value,
      [countryName]: {
        政治稳定: indicators.政治稳定,
        经济发展: indicators.经济发展,
        国际影响: indicators.国际影响,
      },
    }

    // 同步到 activeWorldPayload 中对应国家的 国家指标 字段（如果存在该国家）
    try {
      const countries = getCountriesFromPayload(activeWorldPayload.value)

      for (const country of countries) {
        if (!isRecord(country)) continue

        const name = typeof country.国家名称 === 'string' ? country.国家名称.trim() : ''
        if (name === countryName) {
          country.国家指标 = {
            政治稳定: indicators.政治稳定,
            经济发展: indicators.经济发展,
            国际影响: indicators.国际影响,
          }
          break
        }
      }
    } catch (error) {
      console.error('同步到 activeWorldPayload 失败', error)
    }

    applied.push(countryName)

    // 记录变更明细推送到聊天以便用户可见
    const oldSummary = old
      ? `旧值: 政治稳定=${formatIndicatorValue(old.政治稳定)}, 经济发展=${formatIndicatorValue(old.经济发展)}, 国际影响=${formatIndicatorValue(old.国际影响)}`
      : '旧值: 无'

    const newSummary = `新值: 政治稳定=${formatIndicatorValue(indicators.政治稳定)}, 经济发展=${formatIndicatorValue(
      indicators.经济发展,
    )}, 国际影响=${formatIndicatorValue(indicators.国际影响)}`

    chatMessages.value.push({
      role: 'assistant',
      content: `已应用指标变更：${countryName}；${desc || '无描述'}；${oldSummary}；${newSummary}`,
    })
  }

  // 持久化
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

const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendMessage()
  }
}

onMounted(() => {
  const isFreshSession = window.sessionStorage.getItem(EVENT_DRIVE_FRESH_SESSION_KEY) === 'true'

  if (isFreshSession) {
    window.sessionStorage.removeItem(EVENT_DRIVE_FRESH_SESSION_KEY)
    clearSelectedSnapshot()
  } else {
    loadChatWindowDraft()
  }

  snapshotHistory.value = readSnapshotHistory()

  const worldLandState = readWorldLandPayload()
  const archive = isFreshSession ? {} : readEventDriveArchive()
  const selectedArchiveKey = isFreshSession
    ? ''
    : resolveArchiveKey(worldLandState?.payload ?? null, archive)

  if (!isFreshSession && selectedArchiveKey && archive[selectedArchiveKey]) {
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
              <button class="ghost-button" type="button" @click="resetChat">重置世界</button>
              <button class="ghost-button" type="button" @click="reinjectPrompt">重新注入提示词</button>
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
          </ul>
        </aside>
      </aside>
    </div>

    <FloatingCountrySidebar
      v-if="countrySidebarItems.length"
      :items="countrySidebarItems"
      title="国家列表"
      empty-text="当前世界没有国家数据"
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

  .primary-button,
  .secondary-button,
  .ghost-button {
    width: 100%;
  }
}
</style>
