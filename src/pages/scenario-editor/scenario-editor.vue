<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import {
  useTerritoryMap,
  type TerritoryAreaGroup,
  type TerritoryAssignment,
} from '@/composables/territory-map'
import { defaultScenarioReviewPrompt } from '@/composables/prompt-defaults'
import { readAiSettingsFromStorage, submitPreparedPrompt } from '@/utils/submit-commition'
import {
  getFeatureTerritoryCode,
  getFeatureTerritoryKey,
  makeTerritoryKey,
  normalizeTerritoryCode,
} from '@/lib/map/territory-code'
import type { WorldMapFeature } from '@/types/geo'
import type { RegimeData, ScenarioData, TerritoryData, TerritoryLevel } from '@/types/scenario'
import {
  DEFAULT_REGIME_COLOR,
  createEmptyLeaderData,
  createEmptyRegimeData,
  createEmptyScenarioData,
  formatDateTimeLocal,
  governmentFormOptions,
  regimeColorPresets,
} from '@/types/scenario'
import { isRecord } from '@/utils/country-data'
import {
  applyCountryArchive,
  createNextRegime,
  createScenarioFromWorldData,
  normalizeHexColor,
  normalizeRegimeData,
  normalizeScenarioData,
  pickUnusedRegimeColor,
  getTerritoryKey,
  safeFileName,
  serializeRegimeForExport,
  serializeScenarioForExport,
  toColorInputValue,
  toCountryData,
} from '@/utils/scenario-data'
import { buildIndexedRegimes, type RegimeSortMode } from '@/utils/regime-sort'
import { buildScenarioAiPayload } from '@/utils/scenario-ai'
import {
  EVENT_DRIVE_FRESH_SESSION_KEY,
  SCENARIO_TRANSFER_KEY,
  createScenarioTransferPayload,
} from '@/utils/scenario-transfer'

defineOptions({
  name: 'ScenarioEditorPage',
})

type EditorTab = 'regime' | 'territory' | 'archive'
type PowerKey = '政治稳定' | '经济发展' | '国际影响'
type MessageLevel = 'info' | 'error'
type IssueLevel = 'error' | 'warning'

interface ScenarioIssue {
  level: IssueLevel
  message: string
}

const DRAFT_KEY = 'scenario-editor-draft'
const HANDOFF_KEY = 'scenario-editor-import'
const WORLD_DRAFT_KEY = 'worldDataDraft'

const powerKeys: PowerKey[] = ['政治稳定', '经济发展', '国际影响']

const powerHints: Record<PowerKey, string> = {
  政治稳定: '负值代表内乱风险，低于 -30 时可能触发内战判定。',
  经济发展: '负值代表衰退，会拖累政治稳定与国际影响。',
  国际影响: '负值代表缺乏国际话语权，0 为地区影响力。',
}

const scenario = ref<ScenarioData>(createEmptyScenarioData())
const currentIndex = ref(0)
const activeTab = ref<EditorTab>('regime')
const regimeSortMode = ref<RegimeSortMode>('pinyin')
const statusMessage = ref('')
const errorMessage = ref('')
const lastSavedAt = ref<Date | null>(null)
const draftPersistFailed = ref(false)
const jsonPanelOpen = ref(false)

const router = useRouter()

const isSendingToAi = ref(false)
const aiPanelOpen = ref(false)
const aiReplyText = ref('')
const aiErrorText = ref('')
const aiModelLabel = ref('')
const aiInputChars = ref(0)
const aiInputTokens = ref(0)
const aiPanelRef = ref<HTMLElement | null>(null)

/** 精简审核版仍超过这个值时，直接提示分批，避免把必然超上下文的请求发出去。 */
const MAX_AI_INPUT_TOKENS = 100_000
const SUPPORTED_AI_PROVIDERS = new Set(['OpenAI', 'DeepSeek', 'OpenCode Go'])

const scenarioFileInput = ref<HTMLInputElement | null>(null)
const worldFileInput = ref<HTMLInputElement | null>(null)
const archiveFileInput = ref<HTMLInputElement | null>(null)

const archiveText = ref('')
const archiveError = ref('')
const archiveMessage = ref('')

const currentRegime = computed<RegimeData>(
  () => scenario.value.存在国家[currentIndex.value] ?? createEmptyRegimeData(),
)
const hasCurrentRegime = computed(() => Boolean(scenario.value.存在国家[currentIndex.value]))
const regimeCount = computed(() => scenario.value.存在国家.length)

/**
 * 「玩家操控国家」复选框：勾选表示玩家操控，对应 JSON 里 `AI控制: false`。
 * 事件驱动提示词按 `AI控制` 判断哪些国家交给 AI 推演，所以这里只做一次取反。
 */
const isPlayerControlled = computed({
  get: () => !currentRegime.value.AI控制,
  set: (value: boolean) => {
    currentRegime.value.AI控制 = !value
  },
})

const playerControlledCount = computed(
  () => scenario.value.存在国家.filter((regime) => !regime.AI控制).length,
)
const aiControlledCount = computed(() => regimeCount.value - playerControlledCount.value)

const territoryTotal = computed(() =>
  scenario.value.存在国家.reduce((total, regime) => total + regime.领土.length, 0),
)
const leaderTotal = computed(() =>
  scenario.value.存在国家.reduce((total, regime) => total + regime.领导人.length, 0),
)
const sortedRegimes = computed(() =>
  buildIndexedRegimes(scenario.value.存在国家, regimeSortMode.value),
)
const regimeListRef = ref<HTMLElement | null>(null)

const currentColorPickerValue = computed(() => toColorInputValue(currentRegime.value.代表色))
const currentColorIsHex = computed(() => normalizeHexColor(currentRegime.value.代表色) !== null)

const colorConflicts = computed<string[][]>(() => {
  const groups = new Map<string, string[]>()

  for (const regime of scenario.value.存在国家) {
    const key = toColorInputValue(regime.代表色)
    const names = groups.get(key) ?? []
    names.push(regime.国家名称.trim() || '未命名政权')
    groups.set(key, names)
  }

  return [...groups.values()].filter((names) => names.length > 1)
})

const scenarioIssues = computed<ScenarioIssue[]>(() => {
  const issues: ScenarioIssue[] = []

  if (!scenario.value.开局时间.trim()) {
    issues.push({ level: 'error', message: '缺少开局时间。' })
  }

  if (!scenario.value.存在国家.length) {
    issues.push({ level: 'error', message: '剧本至少需要一个政权。' })
  }

  const nameCounts = new Map<string, number>()

  for (const regime of scenario.value.存在国家) {
    const name = regime.国家名称.trim()

    if (!name) {
      issues.push({ level: 'error', message: '存在未命名政权。' })
    } else {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }

    if (!regime.代表色.trim()) {
      issues.push({ level: 'error', message: `「${name || '未命名政权'}」缺少代表色。` })
    }

    if (!regime.政体.trim()) {
      issues.push({ level: 'warning', message: `「${name || '未命名政权'}」没有填写政体。` })
    }

    if (!regime.领土.length) {
      issues.push({ level: 'warning', message: `「${name || '未命名政权'}」没有领土。` })
    }
  }

  for (const [name, count] of nameCounts) {
    if (count > 1) {
      issues.push({ level: 'warning', message: `政权名称重复：${name}（${count} 个）。` })
    }
  }

  if (colorConflicts.value.length) {
    issues.push({
      level: 'warning',
      message: `有 ${colorConflicts.value.length} 组政权使用了相同代表色。`,
    })
  }

  return issues
})

const errorCount = computed(
  () => scenarioIssues.value.filter((issue) => issue.level === 'error').length,
)
const warningCount = computed(
  () => scenarioIssues.value.filter((issue) => issue.level === 'warning').length,
)

const lastSavedLabel = computed(() => {
  if (draftPersistFailed.value) {
    return '草稿过大，自动保存失败，请导出 JSON'
  }

  if (!lastSavedAt.value) {
    return '本地草稿未保存'
  }

  return `已自动保存 ${lastSavedAt.value.toLocaleTimeString('zh-CN', { hour12: false })}`
})

const scenarioExportText = computed(() =>
  JSON.stringify(serializeScenarioForExport(scenario.value), null, 2),
)

const countryArchiveJson = computed(() =>
  JSON.stringify(toCountryData(currentRegime.value), null, 2),
)

/* ---------- 领土地图 ---------- */

const assignmentMap = computed<Record<string, TerritoryAssignment>>(() => {
  const assignments: Record<string, TerritoryAssignment> = {}

  for (const regime of scenario.value.存在国家) {
    for (const territory of regime.领土) {
      const code = normalizeTerritoryCode(territory.代码 ?? '')
      if (!code) {
        continue
      }

      const key = getTerritoryKey(territory)
      if (!key) {
        continue
      }

      assignments[key] = {
        key,
        code,
        name: territory.名称 || code,
        color: toColorInputValue(regime.代表色),
        level: territory.级别,
        countryCode: territory.国家代码,
      }
    }
  }

  return assignments
})

const areaGroups = computed<TerritoryAreaGroup[]>(() =>
  scenario.value.存在国家.flatMap((regime) => {
    const areas = regime.领土.flatMap((territory) => territory.区域 ?? [])
    return areas.length ? [{ color: regime.代表色, areas }] : []
  }),
)

const currentTerritoryCodes = computed(() =>
  currentRegime.value.领土
    .map((territory) => normalizeTerritoryCode(territory.代码 ?? ''))
    .filter((code) => code.length > 0),
)

const currentTerritoryKeys = computed(() =>
  currentRegime.value.领土
    .map((territory) => getTerritoryKey(territory))
    .filter((key) => key.length > 0),
)

const currentRegimeColor = computed(() => currentRegime.value.代表色 || DEFAULT_REGIME_COLOR)

const territoryHint =
  '只能按地区选择：放大到 2.4 倍后点击具体的下级行政区，即可划入或移出当前政权；从导入数据继承的整国编号领土仍会显示在列表里，可单独删除。'

const {
  containerRef: territoryMapContainer,
  canvasRef: territoryMapCanvas,
  loadState: territoryMapState,
  loadError: territoryMapError,
  hoverName: territoryMapHoverName,
  featureCount: territoryMapFeatureCount,
  adminFeatureCount: territoryAdminFeatureCount,
  regionMode: territoryRegionMode,
  regionLoading: territoryRegionLoading,
  zoomLevel: territoryZoomLevel,
  zoomIn: zoomTerritoryIn,
  zoomOut: zoomTerritoryOut,
  resetView: resetTerritoryView,
  focusOnTerritory,
  retry: retryTerritoryMap,
} = useTerritoryMap({
  assignments: assignmentMap,
  areaGroups,
  selectedKeys: currentTerritoryKeys,
  currentColor: currentRegimeColor,
  onToggle: (feature) => toggleTerritory(feature),
})

/* ---------- 提示与持久化 ---------- */

let messageTimer: number | null = null
let saveTimer: number | null = null

const showMessage = (message: string, level: MessageLevel = 'info') => {
  if (messageTimer !== null) {
    window.clearTimeout(messageTimer)
  }

  if (level === 'error') {
    errorMessage.value = message
    statusMessage.value = ''
  } else {
    statusMessage.value = message
    errorMessage.value = ''
  }

  messageTimer = window.setTimeout(() => {
    statusMessage.value = ''
    errorMessage.value = ''
    messageTimer = null
  }, 4500)
}

const persistDraft = () => {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(scenario.value))
    lastSavedAt.value = new Date()
    draftPersistFailed.value = false
  } catch (error) {
    draftPersistFailed.value = true
    console.error('Failed to persist scenario draft', error)
  }
}

const schedulePersist = () => {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
  }

  saveTimer = window.setTimeout(() => {
    saveTimer = null
    persistDraft()
  }, 400)
}

watch(scenario, schedulePersist, { deep: true })

watch(currentIndex, () => {
  archiveText.value = ''
  archiveError.value = ''
  archiveMessage.value = ''
})

/* ---------- 剧本级操作 ---------- */

const loadScenarioFromValue = (value: unknown, sourceLabel: string) => {
  const next = normalizeScenarioData(value)
  scenario.value = next
  currentIndex.value = 0
  activeTab.value = 'regime'
  resetAiReview()

  showMessage(
    next.存在国家.length
      ? `已载入「${next.剧本名称}」，共 ${next.存在国家.length} 个政权（${sourceLabel}）。`
      : `已载入「${next.剧本名称}」，但其中没有政权（${sourceLabel}）。`,
    next.存在国家.length ? 'info' : 'error',
  )
}

const triggerScenarioImport = () => {
  scenarioFileInput.value?.click()
}

const handleScenarioFileImport = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) {
    return
  }

  try {
    const content = await file.text()
    loadScenarioFromValue(JSON.parse(content), file.name)
  } catch (error) {
    console.error('Failed to import scenario json', error)
    showMessage('剧本 JSON 读取失败，请确认文件内容是有效的 JSON。', 'error')
  } finally {
    input.value = ''
  }
}

const createNewScenario = () => {
  if (scenario.value.存在国家.length && !window.confirm('新建剧本会清空当前内容，确定继续吗？')) {
    return
  }

  scenario.value = createEmptyScenarioData()
  currentIndex.value = 0
  activeTab.value = 'regime'
  resetAiReview()
  showMessage('已新建空剧本。')
}

const setStartTimeNow = () => {
  scenario.value.开局时间 = formatDateTimeLocal(new Date())
  showMessage('开局时间已设为当前本地时间。')
}

const exportScenario = () => {
  const fileName = `${safeFileName(scenario.value.剧本名称, '剧本')}.json`
  downloadText(scenarioExportText.value, fileName)
  showMessage(`已导出「${fileName}」。`)
}

/**
 * 把当前剧本交给事件驱动页作为开局世界。
 *
 * 交接内容写在 `event-drive-scenario-json`：事件驱动页读取后会转成自己的世界包，
 * 因此不需要用户先导出文件再手动导入。`event-drive-fresh-session` 让推演页忽略
 * 上一局的聊天草稿与快照，避免旧对话污染新剧本。
 */
const sendScenarioToEventDrive = () => {
  if (!scenario.value.存在国家.length) {
    showMessage('剧本里还没有政权，先新建或导入政权再发送到推演页。', 'error')
    return
  }

  try {
    const payload = createScenarioTransferPayload(scenario.value)
    const transferJson = JSON.stringify(payload)

    window.sessionStorage.setItem(SCENARIO_TRANSFER_KEY, transferJson)
    window.sessionStorage.setItem(EVENT_DRIVE_FRESH_SESSION_KEY, 'true')
    persistDraft()
    void router.push({ name: 'event-drive' })
  } catch (error) {
    console.error('Failed to send scenario to event drive', error)

    // 写入中途失败时清掉半成品，避免下次打开推演页误加载旧剧本。
    try {
      window.sessionStorage.removeItem(SCENARIO_TRANSFER_KEY)
      window.localStorage.removeItem(SCENARIO_TRANSFER_KEY)
      window.sessionStorage.removeItem(EVENT_DRIVE_FRESH_SESSION_KEY)
    } catch {
      // 存储不可用时无需再处理。
    }

    showMessage('发送至推演失败，请检查浏览器存储空间后重试。', 'error')
  }
}

const exportRegime = () => {
  if (!hasCurrentRegime.value) {
    return
  }

  const fileName = `${safeFileName(currentRegime.value.国家名称, '政权')}.regime.json`
  downloadText(JSON.stringify(serializeRegimeForExport(currentRegime.value), null, 2), fileName)
  showMessage(`已导出「${fileName}」。`)
}

const copyScenarioJson = async () => {
  try {
    await navigator.clipboard.writeText(scenarioExportText.value)
    showMessage('剧本 JSON 已复制。')
  } catch (error) {
    console.error('Failed to copy scenario json', error)
    showMessage('复制失败，请在文本框中手动选择复制。', 'error')
  }
}

const downloadText = (content: string, fileName: string) => {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

/* ---------- 发送至 AI ---------- */

/** 用于丢弃「切换剧本后才返回」的旧请求结果。 */
let aiRequestId = 0

const resetAiReview = () => {
  aiRequestId += 1
  isSendingToAi.value = false
  aiPanelOpen.value = false
  aiReplyText.value = ''
  aiErrorText.value = ''
  aiModelLabel.value = ''
  aiInputChars.value = 0
  aiInputTokens.value = 0
}

const sendScenarioToAi = async () => {
  if (isSendingToAi.value) {
    return
  }

  if (!scenario.value.存在国家.length) {
    showMessage('剧本里还没有政权，先新建或导入政权再发送给 AI。', 'error')
    return
  }

  const settings = readAiSettingsFromStorage()

  if (!settings || !settings.api.trim()) {
    showMessage('还没有配置 API，请先到「设置」页填写提供商、API 与模型。', 'error')
    return
  }

  if (!SUPPORTED_AI_PROVIDERS.has(settings.provider)) {
    showMessage(
      `当前提供商「${settings.provider}」尚未接入。请在设置页改用 OpenAI / DeepSeek / OpenCode Go。`,
      'error',
    )
    return
  }

  // 完整剧本 JSON 可能超过模型上下文，这里始终发送精简审核版。
  const payload = buildScenarioAiPayload(scenario.value)

  aiModelLabel.value = `${settings.provider} / ${settings.model}`
  aiInputChars.value = payload.chars
  aiInputTokens.value = payload.tokens
  aiReplyText.value = ''
  aiErrorText.value = ''
  aiPanelOpen.value = true

  if (payload.tokens > MAX_AI_INPUT_TOKENS) {
    aiErrorText.value = `精简审核版仍约 ${payload.tokens.toLocaleString()} tokens，超过安全上限 ${MAX_AI_INPUT_TOKENS.toLocaleString()}。请减少剧本内容或分批分析。`
    return
  }

  const requestId = (aiRequestId += 1)
  isSendingToAi.value = true
  const errorDetails: string[] = []

  try {
    const response = await submitPreparedPrompt(
      {
        messages: [
          { role: 'system' as const, content: defaultScenarioReviewPrompt },
          {
            role: 'user' as const,
            content: [
              `下面是当前剧本的精简审核版 JSON（共 ${payload.regimeCount} 个政权、${payload.territoryCount} 块领土，约 ${payload.tokens} tokens；其中玩家操控 ${playerControlledCount.value} 个），请按系统提示分析：`,
              '',
              '```json',
              payload.text,
              '```',
            ].join('\n'),
          },
        ],
      },
      {
        onError: (message) => {
          errorDetails.push(message)
        },
      },
    )

    // 请求期间切到别的剧本时，旧结果直接丢弃。
    if (requestId !== aiRequestId) {
      return
    }

    if (!response?.trim()) {
      const detail = errorDetails.join('；').slice(0, 600)
      aiErrorText.value = detail
        ? `模型没有返回有效内容：${detail}`
        : `模型没有返回有效内容（已发送约 ${payload.tokens.toLocaleString()} tokens）。请检查模型上下文是否足够、API Key/模型名是否正确；详细错误见浏览器控制台。`
      return
    }

    aiReplyText.value = response.trim()

    await nextTick()
    aiPanelRef.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  } catch (error) {
    if (requestId === aiRequestId) {
      const detail = errorDetails.join('；').slice(0, 600)
      aiErrorText.value = detail
        ? `发送失败：${detail}`
        : '发送失败，请检查网络、API 与模型后重试。'
    }
    console.error('Failed to send scenario to AI', error)
  } finally {
    if (requestId === aiRequestId) {
      isSendingToAi.value = false
    }
  }
}

const copyAiReply = async () => {
  if (!aiReplyText.value) {
    return
  }

  try {
    await navigator.clipboard.writeText(aiReplyText.value)
    showMessage('AI 回复已复制。')
  } catch (error) {
    console.error('Failed to copy AI reply', error)
    showMessage('复制失败，请在回复面板里手动选择复制。', 'error')
  }
}

/* ---------- 政权级操作 ---------- */

const selectRegime = (index: number) => {
  currentIndex.value = index
}

const scrollActiveRegimeIntoView = async () => {
  await nextTick()
  const active = regimeListRef.value?.querySelector<HTMLElement>('.regime-item.is-active')
  active?.scrollIntoView?.({ block: 'nearest' })
}

const createNewRegimeName = (): string => {
  const used = new Set(scenario.value.存在国家.map((regime) => regime.国家名称.trim()))
  let index = 1

  while (used.has(`新政权 ${index}`)) {
    index += 1
  }

  return `新政权 ${index}`
}

const makeUniqueRegimeName = (base: string): string => {
  const cleaned = base.trim() || '未命名政权'
  const used = new Set(scenario.value.存在国家.map((regime) => regime.国家名称.trim()))

  if (!used.has(cleaned)) {
    return cleaned
  }

  let index = 2
  while (used.has(`${cleaned} ${index}`)) {
    index += 1
  }

  return `${cleaned} ${index}`
}

const addRegime = () => {
  const regime = createNextRegime(
    scenario.value.存在国家.length,
    pickUnusedRegimeColor(scenario.value.存在国家),
  )

  regime.国家名称 = createNewRegimeName()
  scenario.value.存在国家.push(regime)
  currentIndex.value = scenario.value.存在国家.length - 1
  activeTab.value = 'regime'
  void scrollActiveRegimeIntoView()
  showMessage(`已新建「${regime.国家名称}」，默认由 AI 操控；勾选「玩家操控国家」可交给玩家。`)
}

const duplicateRegime = () => {
  if (!hasCurrentRegime.value) {
    return
  }

  const source = currentRegime.value
  const cloneValue = JSON.parse(JSON.stringify(source)) as unknown
  const clone = normalizeRegimeData(cloneValue, scenario.value.存在国家.length)

  clone.国家名称 = makeUniqueRegimeName(`${source.国家名称.trim() || '未命名政权'} 副本`)
  clone.代表色 = pickUnusedRegimeColor(scenario.value.存在国家)

  scenario.value.存在国家.push(clone)
  currentIndex.value = scenario.value.存在国家.length - 1
  void scrollActiveRegimeIntoView()
  showMessage(`已复制「${source.国家名称 || '未命名政权'}」。`)
}

const removeRegime = (index: number) => {
  const regime = scenario.value.存在国家[index]
  if (!regime) {
    return
  }

  const name = regime.国家名称.trim() || '未命名政权'
  if (!window.confirm(`确定删除政权「${name}」吗？`)) {
    return
  }

  scenario.value.存在国家.splice(index, 1)

  if (!scenario.value.存在国家.length) {
    currentIndex.value = 0
  } else if (currentIndex.value > index) {
    currentIndex.value -= 1
  } else if (currentIndex.value === index) {
    currentIndex.value = Math.min(index, scenario.value.存在国家.length - 1)
  }

  showMessage(`已删除「${name}」。`)
}

watch(
  () => scenario.value.存在国家.length,
  (length) => {
    if (!length) {
      currentIndex.value = 0
      return
    }
    if (currentIndex.value >= length) {
      currentIndex.value = length - 1
    }
  },
)

/* ---------- 代表色 / 政体 / 领导人 / 国家力量 ---------- */

const handleColorPicker = (event: Event) => {
  const nextColor = (event.target as HTMLInputElement).value
  currentRegime.value.代表色 = nextColor
}

const handleColorText = (event: Event) => {
  const input = event.target as HTMLInputElement
  const normalized = normalizeHexColor(input.value)

  if (!normalized) {
    input.value = currentRegime.value.代表色
    showMessage('代表色请使用 #RRGGBB 格式，例如 #3b82f6。', 'error')
    return
  }

  currentRegime.value.代表色 = normalized
}

const applyColorPreset = (color: string) => {
  currentRegime.value.代表色 = color
  showMessage(`已将「${currentRegime.value.国家名称 || '当前政权'}」的代表色设为 ${color}。`)
}

const addLeader = () => {
  currentRegime.value.领导人.push(createEmptyLeaderData())
}

const removeLeader = (index: number) => {
  if (!currentRegime.value.领导人[index]) {
    return
  }
  currentRegime.value.领导人.splice(index, 1)
}

const moveLeader = (index: number, offset: number) => {
  const leaders = currentRegime.value.领导人
  const target = index + offset
  if (target < 0 || target >= leaders.length) {
    return
  }

  const [leader] = leaders.splice(index, 1)
  if (!leader) {
    return
  }
  leaders.splice(target, 0, leader)
}

const setPower = (key: PowerKey, rawValue: number) => {
  const numeric = Number.isFinite(rawValue) ? rawValue : 0
  const value = Math.max(-100, Math.min(100, Math.round(numeric * 10) / 10))
  currentRegime.value.初始国家力量[key] = value
  currentRegime.value.国家指标[key] = value
}

const powerTone = (value: number): 'positive' | 'negative' | 'neutral' => {
  if (value > 0) {
    return 'positive'
  }
  if (value < 0) {
    return 'negative'
  }
  return 'neutral'
}

/* ---------- 领土编辑 ---------- */

const COUNTRY_CODE_PATTERN = /^[A-Z]{3}$/

const territoryLevelLabels: Record<string, string> = {
  country: '国家',
  adm1: '一级行政区',
  adm2: '二级行政区',
  adm3: '三级行政区',
}

const territoryCode = (territory: TerritoryData): string =>
  normalizeTerritoryCode(territory.代码 ?? '')

const resolveTerritoryLevel = (territory: TerritoryData): TerritoryLevel | '' => {
  if (territory.级别) {
    return territory.级别
  }
  return COUNTRY_CODE_PATTERN.test(territoryCode(territory)) ? 'country' : ''
}

const removeTerritories = (
  regime: RegimeData,
  predicate: (territory: TerritoryData) => boolean,
): number => {
  let removed = 0

  for (let index = regime.领土.length - 1; index >= 0; index -= 1) {
    const territory = regime.领土[index]
    if (territory && predicate(territory)) {
      regime.领土.splice(index, 1)
      removed += 1
    }
  }

  return removed
}

function toggleTerritory(feature: WorldMapFeature) {
  if (!hasCurrentRegime.value) {
    showMessage('请先新建或选择一个政权。', 'error')
    return
  }

  // 只支持地区粒度：点到国家只给出提示，不再整国选中
  if (feature.level === 'country') {
    showMessage(
      territoryRegionMode.value
        ? `「${feature.name || '该国家'}」没有可用的下级行政区数据，无法按地区选择。`
        : '只能选择地区：请把地图放大到 2.4 倍以上，再点击具体的下级行政区。',
    )
    return
  }

  const regime = currentRegime.value
  const code = getFeatureTerritoryCode(feature)
  const countryCode = (feature.iso || '').trim().toUpperCase()
  const name = feature.name || code
  const featureKey = getFeatureTerritoryKey(feature)
  const legacyKey = makeTerritoryKey(code)

  if (!code) {
    showMessage('这个地区没有可用编号。', 'error')
    return
  }

  // 同时兼容旧数据里没有国家代码、只按代码记录的领土。
  const matchesFeature = (territory: TerritoryData) => {
    const key = getTerritoryKey(territory)
    return key === featureKey || key === legacyKey
  }

  // 再次点击同一块地区 -> 移出当前政权
  const ownIndex = regime.领土.findIndex(matchesFeature)
  if (ownIndex >= 0) {
    regime.领土.splice(ownIndex, 1)
    showMessage(`已将「${name}」移出「${regime.国家名称 || '当前政权'}」。`)
    return
  }

  // 同一块地区只属于一个政权：从其他政权转交过来
  let transferredFrom = ''
  for (const target of scenario.value.存在国家) {
    if (target === regime) {
      continue
    }
    if (removeTerritories(target, matchesFeature)) {
      transferredFrom = target.国家名称 || '另一政权'
    }
  }

  regime.领土.push({
    名称: name,
    代码: code,
    国家代码: countryCode,
    级别: feature.level as TerritoryLevel,
  })

  showMessage(
    `已将「${name}」划入「${regime.国家名称 || '当前政权'}」${
      transferredFrom ? `（从「${transferredFrom}」转交）` : ''
    }。`,
  )
}

const removeTerritory = (index: number) => {
  const territory = currentRegime.value.领土[index]
  if (!territory) {
    return
  }

  currentRegime.value.领土.splice(index, 1)
  showMessage(`已删除领土「${territory.名称 || '未命名领土'}」。`)
}

const clearTerritories = () => {
  if (!hasCurrentRegime.value || !currentRegime.value.领土.length) {
    return
  }

  const name = currentRegime.value.国家名称 || '当前政权'
  if (!window.confirm(`清空「${name}」的全部领土？`)) {
    return
  }

  currentRegime.value.领土 = []
  showMessage(`已清空「${name}」的领土。`)
}

const territoryKindLabel = (territory: TerritoryData): string => {
  const level = resolveTerritoryLevel(territory)
  if (level) {
    return territoryLevelLabels[level] ?? '地区'
  }

  if (territory.区域?.length) {
    const vertexCount = territory.区域.reduce((total, area) => total + area.vertices.length, 0)
    return `自定义区域 · ${vertexCount} 顶点`
  }

  return territory.代码 ? '地区' : '名称条目'
}

const locateTerritory = (territory: TerritoryData) => {
  if (!territory.代码) {
    showMessage('自定义区域暂时不能定位到地图。', 'info')
    return
  }

  if (!focusOnTerritory(territory.代码, territory.国家代码)) {
    showMessage('该地区的地图数据尚未加载，请稍后重试或继续放大地图。', 'info')
  }
}

const copyCurrentTerritoryCodes = async () => {
  const codes = currentTerritoryCodes.value
  if (!codes.length) {
    showMessage('当前政权还没有可复制的地区编号。', 'info')
    return
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(codes, null, 2))
    showMessage(`已复制 ${codes.length} 个地区编号。`)
  } catch (error) {
    console.error('Failed to copy territory codes', error)
    showMessage('复制失败，请在领土列表中手动选择。', 'error')
  }
}

/* ---------- 从世界生成导入 ---------- */

const importWorldFromSession = () => {
  let draft: string | null = null

  try {
    draft = window.sessionStorage.getItem(WORLD_DRAFT_KEY)
  } catch (error) {
    console.error('Failed to read world draft', error)
  }

  if (!draft) {
    showMessage('没有找到世界生成草稿，请选择导出的世界 JSON 文件。')
    worldFileInput.value?.click()
    return
  }

  try {
    applyWorldData(JSON.parse(draft), '世界生成草稿')
  } catch (error) {
    console.error('Failed to parse world draft', error)
    showMessage('世界生成草稿不是有效的 JSON。', 'error')
  }
}

const handleWorldFileImport = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) {
    return
  }

  try {
    const content = await file.text()
    applyWorldData(JSON.parse(content), file.name.replace(/\.[^.]+$/, ''))
  } catch (error) {
    console.error('Failed to import world json', error)
    showMessage('世界 JSON 读取失败，请确认文件内容有效。', 'error')
  } finally {
    input.value = ''
  }
}

function applyWorldData(value: unknown, sourceLabel: string) {
  const next = createScenarioFromWorldData(value, `剧本 · ${sourceLabel}`)

  if (!next.存在国家.length) {
    showMessage('世界数据里没有读到国家或国土，无法生成剧本。', 'error')
    return
  }

  if (
    scenario.value.存在国家.length &&
    !window.confirm(
      `将用「${sourceLabel}」重建剧本，当前 ${scenario.value.存在国家.length} 个政权会被替换。继续吗？`,
    )
  ) {
    return
  }

  scenario.value = next
  currentIndex.value = 0
  activeTab.value = 'territory'
  jsonPanelOpen.value = false
  resetAiReview()
  showMessage(`已从「${sourceLabel}」生成 ${next.存在国家.length} 个政权。`)
}

/* ---------- 国家档案 ---------- */

const triggerArchiveFileImport = () => {
  archiveFileInput.value?.click()
}

const handleArchiveFileImport = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) {
    return
  }

  try {
    archiveText.value = await file.text()
    applyArchiveText()
  } catch (error) {
    console.error('Failed to read country archive', error)
    archiveError.value = '国家档案文件读取失败。'
  } finally {
    input.value = ''
  }
}

const applyArchiveText = () => {
  archiveError.value = ''
  archiveMessage.value = ''

  if (!hasCurrentRegime.value) {
    archiveError.value = '请先选择一个政权。'
    return
  }

  const raw = archiveText.value.trim()
  if (!raw) {
    archiveError.value = '请先粘贴国家 JSON，或选择一个 JSON 文件。'
    return
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    archiveError.value = '内容不是有效的 JSON。'
    return
  }

  if (isRecord(parsed) && Array.isArray(parsed.存在国家)) {
    archiveError.value = '这是剧本 JSON，请使用页面顶部的「导入剧本 JSON」。'
    return
  }

  let candidate: unknown = parsed

  if (Array.isArray(parsed)) {
    candidate = parsed[0]
  } else if (isRecord(parsed) && Array.isArray(parsed.countries)) {
    candidate = parsed.countries[0]
  }

  if (!isRecord(candidate) || !Object.keys(candidate).length) {
    archiveError.value = '没有读到可用的国家档案。'
    return
  }

  const next = applyCountryArchive(currentRegime.value, candidate)
  scenario.value.存在国家.splice(currentIndex.value, 1, next)
  archiveMessage.value = `已应用「${next.国家名称 || '当前政权'}」的国家档案，并同步初始国家力量。`
  showMessage(archiveMessage.value)
}

const exportCountryArchive = () => {
  if (!hasCurrentRegime.value) {
    return
  }

  const fileName = `${safeFileName(currentRegime.value.国家名称, '国家')}.json`
  downloadText(countryArchiveJson.value, fileName)
  showMessage(`已导出「${fileName}」。`)
}

const copyCountryJson = async () => {
  try {
    await navigator.clipboard.writeText(countryArchiveJson.value)
    showMessage('国家档案 JSON 已复制。')
  } catch (error) {
    console.error('Failed to copy country json', error)
    showMessage('复制失败，请在预览框里手动选择复制。', 'error')
  }
}

/* ---------- 生命周期 ---------- */

/**
 * 文章转 JSON 的「发送至剧本」交接：
 * 已有剧本时追加为新政权，不覆盖当前内容；空剧本时直接载入。
 */
function importHandoff(raw: string) {
  const next = normalizeScenarioData(JSON.parse(raw) as unknown)

  if (!next.存在国家.length) {
    showMessage('发送内容里没有读到国家档案。', 'error')
    return
  }

  if (scenario.value.存在国家.length) {
    for (const regime of next.存在国家) {
      regime.国家名称 = makeUniqueRegimeName(regime.国家名称 || '导入政权')
      regime.代表色 = pickUnusedRegimeColor(scenario.value.存在国家)
      scenario.value.存在国家.push(regime)
    }

    currentIndex.value = scenario.value.存在国家.length - 1
    activeTab.value = 'regime'
    showMessage(`已从文章转 JSON 追加 ${next.存在国家.length} 个政权。`)
    return
  }

  scenario.value = next
  currentIndex.value = 0
  activeTab.value = 'regime'
  resetAiReview()
  showMessage(`已从文章转 JSON 载入 ${next.存在国家.length} 个政权。`)
}

onMounted(() => {
  let handoff: string | null = null
  let draft: string | null = null

  try {
    handoff = window.localStorage.getItem(HANDOFF_KEY)
    draft = window.localStorage.getItem(DRAFT_KEY)
  } catch (error) {
    console.error('Failed to read scenario storage', error)
  }

  if (draft) {
    try {
      scenario.value = normalizeScenarioData(JSON.parse(draft))
      currentIndex.value = 0
    } catch (error) {
      console.error('Failed to restore scenario draft', error)
    }
  }

  if (!handoff) {
    return
  }

  try {
    importHandoff(handoff)
  } catch (error) {
    console.error('Failed to load scenario handoff', error)
    showMessage('文章转 JSON 交接内容读取失败。', 'error')
  } finally {
    try {
      window.localStorage.removeItem(HANDOFF_KEY)
    } catch (error) {
      console.error('Failed to clear scenario handoff', error)
    }
  }
})

onBeforeUnmount(() => {
  if (messageTimer !== null) {
    window.clearTimeout(messageTimer)
    messageTimer = null
  }

  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }

  persistDraft()
})
</script>

<template>
  <main class="scenario-page">
    <header class="page-header">
      <div class="page-heading">
        <p class="eyebrow">SCENARIO / REGIME WORKBENCH</p>
        <h1>剧本编辑</h1>
        <p class="page-description">
          定义开局时间与存在国家，并为每个政权配置代表色、政体、领导人、领土与初始国家力量。 政权
          JSON 兼容「文章转 JSON」得到的 CountryData。
        </p>
      </div>

      <div class="page-actions">
        <button type="button" @click="createNewScenario">新建剧本</button>
        <button type="button" @click="triggerScenarioImport">导入剧本 JSON</button>
        <button type="button" class="primary" @click="exportScenario">导出剧本 JSON</button>
        <button type="button" @click="importWorldFromSession">从世界生成导入</button>
        <button
          type="button"
          class="push-action"
          title="把当前剧本 JSON 发送到事件驱动页，作为推演的开局世界"
          @click="sendScenarioToEventDrive"
        >
          发送至推演
        </button>
        <button
          type="button"
          class="ai-action"
          :disabled="isSendingToAi"
          title="把当前剧本的精简审核版发送到「设置」页配置的模型"
          @click="sendScenarioToAi"
        >
          {{ isSendingToAi ? 'AI 分析中…' : '发送至 AI' }}
        </button>
      </div>
    </header>

    <input
      ref="scenarioFileInput"
      hidden
      type="file"
      accept="application/json,.json"
      @change="handleScenarioFileImport"
    />
    <input
      ref="worldFileInput"
      hidden
      type="file"
      accept="application/json,.json"
      @change="handleWorldFileImport"
    />
    <input
      ref="archiveFileInput"
      hidden
      type="file"
      accept="application/json,.json"
      @change="handleArchiveFileImport"
    />

    <div
      v-if="statusMessage || errorMessage"
      class="toast"
      :class="{ 'toast-error': !!errorMessage }"
      role="status"
    >
      {{ errorMessage || statusMessage }}
    </div>

    <section class="scenario-meta-card" aria-label="剧本信息">
      <div class="scenario-meta-fields">
        <label class="field">
          <span>剧本名称</span>
          <input v-model="scenario.剧本名称" type="text" placeholder="例如：1945 冷战前夜" />
        </label>

        <label class="field">
          <span>开局时间</span>
          <span class="inline-input">
            <input v-model="scenario.开局时间" type="text" placeholder="例如：1945-09-02T09:00" />
            <button type="button" @click="setStartTimeNow">现在</button>
          </span>
        </label>
      </div>

      <div class="scenario-stats">
        <span
          ><strong>{{ regimeCount }}</strong> 政权</span
        >
        <span
          ><strong>{{ territoryTotal }}</strong> 领土</span
        >
        <span
          ><strong>{{ leaderTotal }}</strong> 领导人</span
        >
        <span
          ><strong>{{ playerControlledCount }}</strong> 玩家操控</span
        >
        <span
          ><strong>{{ aiControlledCount }}</strong> AI 操控</span
        >
        <span class="save-indicator">{{ lastSavedLabel }}</span>
      </div>

      <details v-if="scenarioIssues.length" class="scenario-issues">
        <summary>校验：{{ errorCount }} 项错误 / {{ warningCount }} 项提醒</summary>
        <ul>
          <li
            v-for="(issue, index) in scenarioIssues"
            :key="`${issue.level}-${index}`"
            :class="`issue-${issue.level}`"
          >
            {{ issue.message }}
          </li>
        </ul>
      </details>
    </section>

    <div v-if="colorConflicts.length" class="color-conflict-banner" role="status">
      <strong>代表色重复：</strong>
      <span v-for="(names, index) in colorConflicts" :key="index">
        {{ names.join(' / ') }}{{ index < colorConflicts.length - 1 ? '；' : '' }}
      </span>
    </div>

    <section
      v-if="aiPanelOpen"
      ref="aiPanelRef"
      class="ai-panel"
      aria-label="AI 回复"
      aria-live="polite"
    >
      <header class="ai-panel-header">
        <div>
          <p class="eyebrow">AI ANALYSIS</p>
          <h2>AI 分析结果</h2>
          <p class="ai-panel-meta">
            <span>{{ aiModelLabel || '未配置模型' }}</span>
            <span>发送 {{ aiInputChars }} 字符</span>
            <span v-if="aiInputTokens">
              约 {{ aiInputTokens.toLocaleString() }} tokens · 精简审核版
            </span>
            <span v-if="aiReplyText">回复 {{ aiReplyText.length }} 字符</span>
          </p>
          <p class="ai-panel-note">
            为控制上下文，发送的是精简审核版：省略空字段和地区名称，领土按级别只保留编号。
          </p>
        </div>
        <div class="ai-panel-actions">
          <button type="button" :disabled="!aiReplyText" @click="copyAiReply">复制回复</button>
          <button type="button" @click="aiPanelOpen = false">收起</button>
        </div>
      </header>

      <p v-if="isSendingToAi" class="ai-panel-loading">
        正在等待 {{ aiModelLabel || '模型' }} 返回，政权与领土越多耗时越长…
      </p>
      <p v-if="aiErrorText" class="inline-error">{{ aiErrorText }}</p>
      <pre v-if="aiReplyText" class="ai-reply-text">{{ aiReplyText }}</pre>
    </section>

    <div class="editor-layout">
      <aside class="regime-rail" aria-label="政权列表">
        <div class="rail-heading">
          <div>
            <p class="rail-eyebrow">REGIMES</p>
            <h2>政权列表</h2>
          </div>
          <button type="button" class="primary" @click="addRegime">+ 新建</button>
        </div>

        <div v-if="regimeCount" class="rail-sort">
          <span class="rail-sort-label">排序</span>
          <div class="rail-sort-switch" role="group" aria-label="政权排序方式">
            <button
              type="button"
              :class="{ 'is-active': regimeSortMode === 'pinyin' }"
              @click="regimeSortMode = 'pinyin'"
            >
              拼音
            </button>
            <button
              type="button"
              :class="{ 'is-active': regimeSortMode === 'created' }"
              @click="regimeSortMode = 'created'"
            >
              创建
            </button>
          </div>
        </div>

        <div v-if="!regimeCount" class="rail-empty">
          <p>还没有政权。</p>
          <p>新建一个政权，或从世界生成导入已有国家。</p>
        </div>

        <div v-else ref="regimeListRef" class="regime-list">
          <button
            v-for="(entry, displayIndex) in sortedRegimes"
            :key="`${entry.index}-${entry.name}`"
            type="button"
            class="regime-item"
            :class="{ 'is-active': entry.index === currentIndex }"
            @click="selectRegime(entry.index)"
          >
            <span
              class="regime-color"
              :style="{ background: toColorInputValue(entry.regime.代表色) }"
            ></span>
            <span class="regime-copy">
              <span class="regime-name">
                {{ entry.name }}
                <span v-if="!entry.regime.AI控制" class="regime-tag">玩家</span>
              </span>
              <span class="regime-meta">
                {{ entry.regime.政体 || '未填写政体' }} · {{ entry.regime.领土.length }} 领土 ·
                {{ entry.regime.领导人.length }} 领导人
              </span>
            </span>
            <span class="regime-order">{{ displayIndex + 1 }}</span>
          </button>
        </div>

        <div class="rail-footer">
          <button type="button" @click="importWorldFromSession">从世界生成导入政权</button>
        </div>
      </aside>

      <section v-if="hasCurrentRegime" class="editor-panel" aria-label="政权编辑">
        <header class="regime-header">
          <div class="regime-title-row">
            <span
              class="regime-color-large"
              :style="{ background: currentColorPickerValue }"
            ></span>
            <div class="regime-title-inputs">
              <input
                v-model="currentRegime.国家名称"
                class="regime-name-input"
                type="text"
                placeholder="政权 / 国家名称"
              />
              <p class="regime-subtitle">
                {{ currentRegime.政体 || '未填写政体' }} · {{ currentRegime.领土.length }} 块领土 ·
                {{ currentRegime.领导人.length }} 位领导人
              </p>
            </div>
          </div>

          <div class="regime-header-actions">
            <button type="button" @click="exportRegime">导出政权 JSON</button>
            <button type="button" @click="duplicateRegime">复制政权</button>
            <button type="button" class="danger" @click="removeRegime(currentIndex)">
              删除政权
            </button>
          </div>
        </header>

        <nav class="editor-tabs" aria-label="政权编辑分区">
          <button
            type="button"
            :class="{ 'is-active': activeTab === 'regime' }"
            @click="activeTab = 'regime'"
          >
            政权设定
          </button>
          <button
            type="button"
            :class="{ 'is-active': activeTab === 'territory' }"
            @click="activeTab = 'territory'"
          >
            领土 <span>{{ currentRegime.领土.length }}</span>
          </button>
          <button
            type="button"
            :class="{ 'is-active': activeTab === 'archive' }"
            @click="activeTab = 'archive'"
          >
            国家档案
          </button>
        </nav>

        <div v-if="activeTab === 'regime'" class="tab-panel">
          <section class="form-section">
            <div class="section-heading">
              <div>
                <h3>控制方式</h3>
                <p>勾选后，事件推演中该政权由玩家下达指令；不勾选则交给 AI 自动推演。</p>
              </div>
              <span class="section-badge" :class="{ 'is-player': isPlayerControlled }">
                {{ isPlayerControlled ? '玩家操控' : 'AI 操控' }}
              </span>
            </div>

            <label class="control-toggle">
              <input v-model="isPlayerControlled" type="checkbox" />
              <span class="control-toggle-text">玩家操控国家</span>
            </label>

            <p class="inline-hint">
              <code>"AI控制": {{ currentRegime.AI控制 }}</code>
              会写入剧本 JSON：玩家操控为 false，AI 推演为 true；新建政权默认由 AI 操控。
            </p>
          </section>

          <section class="form-section">
            <div class="section-heading">
              <div>
                <h3>代表色</h3>
                <p>用于地图着色与政权列表标识。建议同屏政权使用差异明显的颜色。</p>
              </div>
              <span class="color-value">{{ currentRegime.代表色 || '未设置' }}</span>
            </div>

            <div class="color-editor">
              <input
                class="color-picker"
                type="color"
                :value="currentColorPickerValue"
                aria-label="选择政权代表色"
                @input="handleColorPicker"
              />
              <input
                class="color-text"
                type="text"
                :value="currentRegime.代表色"
                placeholder="#3b82f6"
                @change="handleColorText"
              />
              <div class="color-presets">
                <button
                  v-for="color in regimeColorPresets"
                  :key="color"
                  type="button"
                  class="color-preset"
                  :class="{ 'is-selected': currentColorPickerValue === color }"
                  :style="{ background: color }"
                  :aria-label="`使用代表色 ${color}`"
                  @click="applyColorPreset(color)"
                />
              </div>
            </div>

            <p v-if="!currentColorIsHex" class="inline-hint">
              当前颜色不是 #RRGGBB 写法；地图会使用最接近的可用颜色，点击色块可规范化。
            </p>
          </section>

          <section class="form-section">
            <div class="section-heading">
              <div>
                <h3>政体</h3>
                <p>可以从常见政体中选择，也可以直接输入自定义政体。</p>
              </div>
            </div>

            <input
              v-model="currentRegime.政体"
              class="wide-input"
              type="text"
              list="government-form-options"
              placeholder="例如：君主立宪制、军政府、城邦制"
            />
            <datalist id="government-form-options">
              <option v-for="option in governmentFormOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </datalist>
          </section>

          <section class="form-section">
            <div class="section-heading">
              <div>
                <h3>领导人</h3>
                <p>可以记录君主、首相、总书记、最高领袖等多个职位。</p>
              </div>
              <button type="button" @click="addLeader">+ 添加领导人</button>
            </div>

            <div v-if="!currentRegime.领导人.length" class="section-empty">
              还没有领导人，点击右上角添加。
            </div>

            <div v-else class="leader-list">
              <article
                v-for="(leader, index) in currentRegime.领导人"
                :key="index"
                class="leader-card"
              >
                <header class="leader-card-header">
                  <strong>领导人 {{ index + 1 }}</strong>
                  <div class="leader-actions">
                    <button type="button" :disabled="index === 0" @click="moveLeader(index, -1)">
                      上移
                    </button>
                    <button
                      type="button"
                      :disabled="index === currentRegime.领导人.length - 1"
                      @click="moveLeader(index, 1)"
                    >
                      下移
                    </button>
                    <button type="button" class="danger" @click="removeLeader(index)">删除</button>
                  </div>
                </header>

                <div class="leader-fields">
                  <label class="field">
                    <span>姓名</span>
                    <input v-model="leader.姓名" type="text" placeholder="例如：温斯顿·丘吉尔" />
                  </label>
                  <label class="field">
                    <span>职位</span>
                    <input v-model="leader.职位" type="text" placeholder="例如：首相" />
                  </label>
                  <label class="field field-wide">
                    <span>简介</span>
                    <textarea v-model="leader.简介" rows="2" placeholder="出身、派系、执政风格……" />
                  </label>
                </div>
              </article>
            </div>
          </section>

          <section class="form-section">
            <div class="section-heading">
              <div>
                <h3>初始国家力量</h3>
                <p>范围 -100 ~ 100；保存时会同步写入 CountryData 的国家指标。</p>
              </div>
              <span class="section-badge">开局值</span>
            </div>

            <div class="power-list">
              <div
                v-for="key in powerKeys"
                :key="key"
                class="power-row"
                :class="`is-${powerTone(currentRegime.初始国家力量[key])}`"
              >
                <div class="power-copy">
                  <span class="power-name">{{ key }}</span>
                  <span class="power-hint">{{ powerHints[key] }}</span>
                </div>
                <input
                  class="power-range"
                  type="range"
                  min="-100"
                  max="100"
                  step="1"
                  :value="currentRegime.初始国家力量[key]"
                  @input="setPower(key, Number(($event.target as HTMLInputElement).value))"
                />
                <input
                  class="power-number"
                  type="number"
                  min="-100"
                  max="100"
                  step="1"
                  :value="currentRegime.初始国家力量[key]"
                  @change="setPower(key, Number(($event.target as HTMLInputElement).value))"
                />
              </div>
            </div>
          </section>
        </div>

        <div v-show="activeTab === 'territory'" class="tab-panel territory-tab">
          <div class="territory-toolbar">
            <div>
              <p class="toolbar-title">领土分配</p>
              <p class="toolbar-hint">
                {{ territoryHint }}
                滚轮或右下角按钮缩放（最高
                200×），按住左键拖拽平移。带「自定义区域」的领土来自世界生成的手绘国土。
              </p>
            </div>
            <div class="toolbar-actions">
              <button type="button" @click="copyCurrentTerritoryCodes">复制编号</button>
              <button type="button" @click="clearTerritories">清空领土</button>
              <button type="button" class="primary" @click="importWorldFromSession">
                从世界生成导入
              </button>
            </div>
          </div>

          <div class="territory-layout">
            <div class="territory-map-wrap">
              <div ref="territoryMapContainer" class="territory-map-container">
                <canvas
                  ref="territoryMapCanvas"
                  class="territory-map-canvas"
                  aria-label="领土地图：点击地区分配领土"
                />

                <div v-if="territoryMapState === 'loading'" class="map-overlay">
                  正在加载世界地图…
                </div>
                <div
                  v-else-if="territoryMapState === 'error'"
                  class="map-overlay map-overlay-error"
                >
                  <strong>地图数据加载失败</strong>
                  <p>{{ territoryMapError }}</p>
                  <button type="button" @click="retryTerritoryMap">重新加载</button>
                </div>

                <div v-if="territoryMapHoverName" class="map-hover-pill">
                  {{ territoryMapHoverName }}
                </div>
                <div class="map-mode-pill" role="status">地区选择</div>
                <div v-if="territoryRegionLoading" class="map-region-loading">
                  正在加载下级行政区…
                </div>
                <div class="map-legend">
                  <span class="legend-dot" :style="{ background: currentColorPickerValue }"></span>
                  <span>{{ currentRegime.国家名称 || '当前政权' }}</span>
                  <span class="legend-count">{{ currentRegime.领土.length }} 块领土</span>
                </div>
                <div class="map-zoom-controls" aria-label="地图缩放">
                  <button type="button" aria-label="放大" title="放大" @click="zoomTerritoryIn">
                    +
                  </button>
                  <span class="map-zoom-level">{{ territoryZoomLevel.toFixed(1) }}×</span>
                  <button type="button" aria-label="缩小" title="缩小" @click="zoomTerritoryOut">
                    −
                  </button>
                  <button
                    type="button"
                    class="map-zoom-reset"
                    title="回到世界视图"
                    @click="resetTerritoryView"
                  >
                    重置
                  </button>
                </div>
                <div class="map-feature-count">
                  已载入 {{ territoryMapFeatureCount }} 个国家
                  <span v-if="territoryRegionMode">
                    · {{ territoryAdminFeatureCount }} 个地区
                  </span>
                </div>
              </div>
            </div>

            <aside class="territory-list-card">
              <div class="territory-list-header">
                <h3>领土列表</h3>
                <span>{{ currentRegime.领土.length }}</span>
              </div>

              <div v-if="!currentRegime.领土.length" class="territory-empty">
                还没有领土。放大地图后点击地区，或从世界生成导入手绘国土。
              </div>

              <ol v-else class="territory-list">
                <li
                  v-for="(territory, index) in currentRegime.领土"
                  :key="`${territory.代码 ?? territory.名称}-${index}`"
                >
                  <span
                    class="territory-swatch"
                    :style="{ background: currentColorPickerValue }"
                  ></span>
                  <div class="territory-copy">
                    <strong>{{ territory.名称 || '未命名领土' }}</strong>
                    <small>
                      {{ territoryKindLabel(territory) }}
                      <template v-if="territory.代码"> · {{ territory.代码 }}</template>
                      <template
                        v-if="territory.级别 && territory.级别 !== 'country' && territory.国家代码"
                      >
                        · {{ territory.国家代码 }}
                      </template>
                    </small>
                  </div>
                  <div class="territory-actions">
                    <button v-if="territory.代码" type="button" @click="locateTerritory(territory)">
                      定位
                    </button>
                    <button type="button" class="danger" @click="removeTerritory(index)">
                      删除
                    </button>
                  </div>
                </li>
              </ol>
            </aside>
          </div>
        </div>

        <div v-if="activeTab === 'archive'" class="tab-panel archive-tab">
          <div class="archive-grid">
            <section class="form-card">
              <div class="form-card-header">
                <div>
                  <h3>基本国家档案</h3>
                  <p>这些字段与「文章转 JSON」的 CountryData 对齐，可直接进入事件推演。</p>
                </div>
                <button type="button" @click="exportCountryArchive">导出国家 JSON</button>
              </div>

              <div class="field-grid">
                <label class="field">
                  <span>人口总数</span>
                  <input v-model.number="currentRegime.人口.总数" type="number" min="0" />
                </label>
                <label class="field">
                  <span>国歌</span>
                  <input v-model="currentRegime.国歌" type="text" />
                </label>
                <label class="field">
                  <span>货币</span>
                  <input v-model="currentRegime.货币" type="text" />
                </label>
                <label class="field field-wide">
                  <span>政治制度</span>
                  <textarea v-model="currentRegime.政治制度" rows="3" />
                </label>
                <label class="field field-wide">
                  <span>经济状况</span>
                  <textarea v-model="currentRegime.经济状况" rows="3" />
                </label>
                <label class="field field-wide">
                  <span>宗教信仰</span>
                  <textarea v-model="currentRegime.宗教信仰" rows="2" />
                </label>
                <label class="field">
                  <span>武装力量名称</span>
                  <input v-model="currentRegime.武装力量.名称" type="text" />
                </label>
                <label class="field">
                  <span>规模</span>
                  <input v-model="currentRegime.武装力量.规模" type="text" />
                </label>
                <label class="field">
                  <span>兵役制度</span>
                  <input v-model="currentRegime.武装力量.兵役制度" type="text" />
                </label>
              </div>
            </section>

            <section class="form-card">
              <div class="form-card-header">
                <div>
                  <h3>导入国家 / 政权档案</h3>
                  <p>
                    支持文章转 JSON 得到的 CountryData、剧本里的单个政权，以及本页导出的
                    <code>.regime.json</code>。
                  </p>
                </div>
                <button type="button" @click="triggerArchiveFileImport">选择文件</button>
              </div>

              <textarea
                v-model="archiveText"
                class="archive-textarea"
                rows="8"
                placeholder='粘贴 {"国家名称": ...} 或完整 CountryData / 政权 JSON'
              ></textarea>

              <div class="archive-actions">
                <button type="button" class="primary" @click="applyArchiveText">应用档案</button>
                <button type="button" @click="archiveText = ''">清空文本</button>
              </div>

              <p v-if="archiveError" class="inline-error">{{ archiveError }}</p>
              <p v-if="archiveMessage" class="inline-success">{{ archiveMessage }}</p>

              <details class="archive-preview">
                <summary>查看当前政权的 CountryData JSON</summary>
                <pre>{{ countryArchiveJson }}</pre>
                <button type="button" @click="copyCountryJson">复制国家 JSON</button>
              </details>
            </section>
          </div>

          <p class="archive-note">
            城市、政党、联盟、种族、科技等深层字段可以继续在「世界生成」页面维护；这里导入后会整体替换
            CountryData 字段，并保留当前政权的代表色、领土与领导人（除非导入内容自带这些字段）。
            政权 JSON 就是「CountryData + 代表色 / 政体 / 领导人 / 领土 / 初始国家力量」。
          </p>
        </div>
      </section>

      <section v-else class="editor-panel editor-empty">
        <p class="eyebrow">NO REGIME YET</p>
        <h2>还没有政权</h2>
        <p>新建一个政权，或从世界生成的草稿/JSON 导入国家与手绘国土。</p>
        <div class="empty-actions">
          <button type="button" class="primary" @click="addRegime">新建第一个政权</button>
          <button type="button" @click="importWorldFromSession">从世界生成导入</button>
        </div>
      </section>
    </div>

    <section class="json-preview-card">
      <button
        type="button"
        class="json-preview-toggle"
        :aria-expanded="jsonPanelOpen"
        @click="jsonPanelOpen = !jsonPanelOpen"
      >
        <span>{{ jsonPanelOpen ? '收起剧本 JSON' : '查看剧本 JSON' }}</span>
        <span class="json-preview-hint">导出格式与「剧本.json」一致</span>
      </button>

      <div v-if="jsonPanelOpen" class="json-preview-body">
        <div class="json-preview-actions">
          <button type="button" @click="copyScenarioJson">复制 JSON</button>
          <button type="button" @click="exportScenario">下载 JSON</button>
        </div>
        <textarea readonly class="json-preview-textarea" :value="scenarioExportText"></textarea>
      </div>
    </section>
  </main>
</template>

<style scoped>
.scenario-page {
  --scenario-accent: #3b82f6;
  --scenario-accent-soft: rgba(59, 130, 246, 0.14);
  --scenario-danger: #e5484d;
  --scenario-panel: color-mix(in oklab, var(--color-background) 94%, var(--color-text) 6%);
  --scenario-panel-strong: color-mix(in oklab, var(--color-background) 86%, var(--color-text) 14%);
  max-width: 1500px;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--color-text);
}

.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.eyebrow {
  margin: 0 0 6px;
  color: var(--scenario-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.22em;
}

.page-heading h1 {
  margin: 0;
  font-size: 30px;
  letter-spacing: -0.02em;
}

.page-description {
  margin: 8px 0 0;
  max-width: 760px;
  font-size: 13px;
  line-height: 1.7;
  opacity: 0.72;
}

.page-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

button {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--scenario-panel);
  color: var(--color-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    transform 0.15s ease;
}

button:hover:not(:disabled) {
  border-color: var(--color-border-hover);
  background: var(--scenario-panel-strong);
}

button:active:not(:disabled) {
  transform: translateY(1px);
}

button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

button.primary {
  border-color: var(--scenario-accent);
  background: var(--scenario-accent);
  color: #fff;
}

button.primary:hover:not(:disabled) {
  border-color: #2563eb;
  background: #2563eb;
}

button.danger {
  border-color: color-mix(in oklab, var(--scenario-danger) 45%, var(--color-border));
  color: var(--scenario-danger);
}

button.danger:hover:not(:disabled) {
  border-color: var(--scenario-danger);
  background: color-mix(in oklab, var(--scenario-danger) 10%, var(--scenario-panel));
}

button.ai-action {
  border-color: color-mix(in oklab, var(--scenario-accent) 70%, transparent);
  background: color-mix(in oklab, var(--scenario-accent) 10%, var(--scenario-panel));
  color: var(--scenario-accent);
  font-weight: 600;
}

button.ai-action:hover:not(:disabled) {
  border-color: var(--scenario-accent);
  background: color-mix(in oklab, var(--scenario-accent) 18%, var(--scenario-panel));
}

button.push-action {
  border-color: color-mix(in oklab, #10b981 55%, transparent);
  background: color-mix(in oklab, #10b981 12%, var(--scenario-panel));
  font-weight: 600;
}

button.push-action:hover:not(:disabled) {
  border-color: #10b981;
  background: color-mix(in oklab, #10b981 20%, var(--scenario-panel));
}

.toast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 60;
  max-width: min(420px, calc(100vw - 48px));
  padding: 12px 16px;
  border: 1px solid rgba(52, 211, 153, 0.45);
  border-radius: 10px;
  background: #10231a;
  color: #d1fae5;
  font-size: 13px;
  line-height: 1.6;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
}

.toast-error {
  border-color: rgba(248, 113, 113, 0.5);
  background: #2a1112;
  color: #fecaca;
}

.scenario-meta-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--scenario-panel);
}

.scenario-meta-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.field > span {
  font-weight: 600;
  letter-spacing: 0.04em;
  opacity: 0.68;
}

.field-wide {
  grid-column: 1 / -1;
}

input[type='text'],
input[type='number'],
textarea,
select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
}

input[type='text']:focus,
input[type='number']:focus,
textarea:focus,
select:focus {
  outline: 2px solid color-mix(in oklab, var(--scenario-accent) 35%, transparent);
  outline-offset: 1px;
}

textarea {
  resize: vertical;
}

.inline-input {
  display: flex;
  gap: 6px;
}

.inline-input input {
  flex: 1;
  min-width: 0;
}

.scenario-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  opacity: 0.82;
}

.scenario-stats strong {
  margin-right: 3px;
  color: var(--scenario-accent);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.save-indicator {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.55;
}

.scenario-issues {
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
  font-size: 12px;
}

.scenario-issues summary {
  cursor: pointer;
  font-weight: 600;
}

.scenario-issues ul {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
}

.issue-error {
  color: var(--scenario-danger);
}

.issue-warning {
  color: #b7791f;
}

.color-conflict-banner {
  padding: 9px 12px;
  border: 1px solid color-mix(in oklab, #d69e2e 45%, var(--color-border));
  border-radius: 10px;
  background: color-mix(in oklab, #d69e2e 10%, var(--scenario-panel));
  font-size: 12px;
  line-height: 1.6;
}

.ai-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid color-mix(in oklab, var(--scenario-accent) 45%, var(--color-border));
  border-radius: 14px;
  background: color-mix(in oklab, var(--scenario-accent) 6%, var(--scenario-panel));
}

.ai-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ai-panel-header h2 {
  margin: 0;
  font-size: 18px;
}

.ai-panel-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.6;
}

.ai-panel-note {
  margin: 6px 0 0;
  font-size: 10.5px;
  line-height: 1.5;
  opacity: 0.5;
}

.ai-panel-actions {
  display: flex;
  gap: 8px;
}

.ai-panel-loading {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}

.ai-reply-text {
  max-height: 480px;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--scenario-panel-strong);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.editor-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.regime-rail,
.editor-panel {
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--scenario-panel);
}

.regime-rail {
  position: sticky;
  top: 80px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 104px);
  padding: 14px;
  overflow: auto;
}

.rail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rail-heading h2 {
  margin: 0;
  font-size: 16px;
}

.rail-eyebrow {
  margin: 0 0 2px;
  font-size: 10px;
  letter-spacing: 0.18em;
  opacity: 0.5;
}

.rail-sort {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px;
}

.rail-sort-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  opacity: 0.5;
}

.rail-sort-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background);
}

.rail-sort-switch button {
  padding: 3px 9px;
  border: none;
  border-radius: 999px;
  background: transparent;
  font-size: 10px;
  opacity: 0.6;
}

.rail-sort-switch button:hover:not(:disabled) {
  background: transparent;
  opacity: 0.9;
}

.rail-sort-switch button.is-active {
  background: var(--scenario-accent-soft);
  color: var(--scenario-accent);
  font-weight: 600;
  opacity: 1;
}

.rail-empty {
  padding: 14px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.65;
}

.rail-empty p {
  margin: 0 0 4px;
}

.rail-empty p:last-child {
  margin-bottom: 0;
}

.regime-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.regime-item {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  text-align: left;
}

.regime-item:hover:not(:disabled) {
  background: color-mix(in oklab, var(--scenario-accent) 7%, transparent);
}

.regime-item.is-active {
  border-color: color-mix(in oklab, var(--scenario-accent) 65%, transparent);
  background: var(--scenario-accent-soft);
}

.regime-color {
  width: 10px;
  height: 34px;
  border-radius: 6px;
}

.regime-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.regime-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.regime-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid color-mix(in oklab, #2f9e69 55%, transparent);
  border-radius: 999px;
  color: #2f9e69;
  font-size: 9px;
  font-weight: 600;
  line-height: 15px;
  vertical-align: middle;
}

.regime-meta {
  overflow: hidden;
  font-size: 10px;
  opacity: 0.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.regime-order {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.38;
}

.rail-footer {
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
}

.rail-footer button {
  width: 100%;
  font-size: 12px;
}

.editor-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 620px;
  padding: 18px;
}

.regime-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.regime-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.regime-color-large {
  flex: 0 0 auto;
  width: 14px;
  height: 48px;
  border-radius: 8px;
}

.regime-title-inputs {
  min-width: 0;
}

.regime-title-inputs .regime-name-input {
  width: min(520px, 56vw);
  padding: 2px 4px;
  border: none;
  border-bottom: 1px dashed var(--color-border);
  border-radius: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.regime-title-inputs .regime-name-input:focus {
  outline: none;
  border-bottom-color: var(--scenario-accent);
}

.regime-subtitle {
  margin: 4px 0 0;
  font-size: 11px;
  opacity: 0.55;
}

.regime-header-actions {
  display: flex;
  gap: 8px;
}

.editor-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
}

.editor-tabs button {
  border-color: transparent;
  border-radius: 8px 8px 0 0;
  background: transparent;
  opacity: 0.62;
}

.editor-tabs button:hover:not(:disabled) {
  background: color-mix(in oklab, var(--scenario-accent) 7%, transparent);
}

.editor-tabs button.is-active {
  border-color: color-mix(in oklab, var(--scenario-accent) 55%, transparent);
  background: var(--scenario-accent-soft);
  opacity: 1;
}

.editor-tabs button span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--scenario-accent) 20%, transparent);
  font-size: 10px;
}

.tab-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: color-mix(in oklab, var(--color-background) 72%, transparent);
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.section-heading h3 {
  margin: 0;
  font-size: 15px;
}

.section-heading p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  opacity: 0.6;
}

.section-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid color-mix(in oklab, var(--scenario-accent) 45%, transparent);
  border-radius: 999px;
  color: var(--scenario-accent);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.section-empty {
  padding: 18px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  font-size: 12px;
  text-align: center;
  opacity: 0.6;
}

.color-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.color-picker {
  width: 48px;
  height: 40px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  cursor: pointer;
}

.color-editor .color-text {
  width: 140px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.color-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.color-preset {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 999px;
}

.color-preset:hover:not(:disabled) {
  transform: scale(1.08);
}

.color-preset.is-selected {
  border-color: var(--color-text);
  box-shadow: inset 0 0 0 2px var(--color-background);
}

.color-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.6;
}

.inline-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.55;
  opacity: 0.55;
}

.inline-hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--scenario-panel-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
}

.control-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: color-mix(in oklab, var(--color-background) 55%, transparent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.control-toggle:hover {
  border-color: var(--color-border-hover);
}

.control-toggle input[type='checkbox'] {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--scenario-accent);
  cursor: pointer;
}

.section-badge.is-player {
  border-color: color-mix(in oklab, #2f9e69 55%, transparent);
  color: #2f9e69;
}

.wide-input {
  max-width: 560px;
}

.leader-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.leader-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: color-mix(in oklab, var(--color-background) 55%, transparent);
}

.leader-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.leader-card-header strong {
  font-size: 12px;
}

.leader-actions {
  display: flex;
  gap: 4px;
}

.leader-actions button {
  padding: 3px 8px;
  font-size: 10px;
}

.leader-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.leader-fields .field-wide {
  grid-column: 1 / -1;
}

.power-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.power-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.1fr) minmax(120px, 2fr) 76px;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
}

.power-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.power-name {
  font-size: 13px;
  font-weight: 600;
}

.power-hint {
  font-size: 10px;
  line-height: 1.45;
  opacity: 0.52;
}

.power-range {
  width: 100%;
  accent-color: var(--scenario-accent);
}

.power-number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.power-row.is-positive .power-name {
  color: #2f9e69;
}

.power-row.is-negative .power-name {
  color: var(--scenario-danger);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.territory-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.toolbar-hint {
  max-width: 720px;
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.6;
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.territory-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: start;
  gap: 12px;
}

.territory-map-container {
  position: relative;
  height: 560px;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #070b12;
}

.territory-map-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.territory-map-canvas:active {
  cursor: grabbing;
}

.map-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  background: rgba(7, 11, 18, 0.82);
  color: #cbd5e1;
  font-size: 13px;
  text-align: center;
}

.map-overlay-error {
  color: #fca5a5;
}

.map-overlay-error p {
  max-width: 560px;
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
}

.map-hover-pill {
  position: absolute;
  top: 10px;
  left: 10px;
  padding: 4px 10px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 999px;
  background: rgba(7, 11, 18, 0.78);
  color: #e2e8f0;
  font-size: 12px;
  pointer-events: none;
}

.map-mode-pill {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 4px 10px;
  border: 1px solid rgba(59, 130, 246, 0.45);
  border-radius: 999px;
  background: rgba(7, 11, 18, 0.78);
  color: #93c5fd;
  font-size: 11px;
  pointer-events: none;
}

.map-region-loading {
  position: absolute;
  top: 44px;
  right: 10px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(7, 11, 18, 0.78);
  color: #fbbf24;
  font-size: 10px;
  pointer-events: none;
}

.map-zoom-controls {
  position: absolute;
  right: 10px;
  bottom: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  z-index: 2;
}

.map-zoom-controls button {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 7px;
  background: rgba(7, 11, 18, 0.82);
  color: #e2e8f0;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.map-zoom-controls button:hover:not(:disabled) {
  border-color: rgba(147, 197, 253, 0.8);
  background: rgba(30, 64, 175, 0.35);
}

.map-zoom-level {
  color: #93c5fd;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.map-zoom-reset {
  min-width: 34px !important;
  font-size: 9px !important;
}

.map-legend {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 999px;
  background: rgba(7, 11, 18, 0.78);
  color: #e2e8f0;
  font-size: 11px;
  pointer-events: none;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.legend-count {
  opacity: 0.6;
}

.map-feature-count {
  position: absolute;
  right: 10px;
  bottom: 10px;
  color: rgba(148, 163, 184, 0.5);
  font-size: 10px;
  pointer-events: none;
}

.territory-list-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 560px;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}

.territory-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.territory-list-header h3 {
  margin: 0;
  font-size: 14px;
}

.territory-list-header span {
  font-size: 11px;
  opacity: 0.6;
}

.territory-empty {
  padding: 18px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  opacity: 0.6;
}

.territory-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.territory-list li {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.territory-swatch {
  width: 8px;
  height: 28px;
  border-radius: 4px;
}

.territory-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.territory-copy strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.territory-copy small {
  overflow: hidden;
  font-size: 10px;
  opacity: 0.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.territory-actions {
  display: flex;
  gap: 4px;
}

.territory-actions button {
  padding: 3px 7px;
  font-size: 10px;
}

.archive-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  align-items: start;
  gap: 12px;
}

.form-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}

.form-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.form-card-header h3 {
  margin: 0;
  font-size: 15px;
}

.form-card-header p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  opacity: 0.6;
}

.archive-textarea {
  min-height: 160px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.archive-actions {
  display: flex;
  gap: 8px;
}

.archive-preview {
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
}

.archive-preview summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.archive-preview pre {
  max-height: 280px;
  margin: 8px 0;
  padding: 10px;
  overflow: auto;
  border-radius: 8px;
  background: var(--scenario-panel-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.inline-error {
  margin: 0;
  color: var(--scenario-danger);
  font-size: 12px;
}

.inline-success {
  margin: 0;
  color: #2f9e69;
  font-size: 12px;
}

.archive-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  opacity: 0.6;
}

.editor-empty {
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 420px;
  text-align: center;
}

.editor-empty h2 {
  margin: 0;
}

.editor-empty p {
  max-width: 480px;
  margin: 0;
  line-height: 1.65;
  opacity: 0.65;
}

.empty-actions {
  display: flex;
  gap: 8px;
}

.json-preview-card {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--scenario-panel);
}

.json-preview-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-radius: 0;
  background: transparent;
}

.json-preview-hint {
  font-size: 11px;
  opacity: 0.5;
}

.json-preview-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-border);
}

.json-preview-actions {
  display: flex;
  gap: 8px;
}

.json-preview-textarea {
  min-height: 320px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

@media (max-width: 1050px) {
  .editor-layout {
    grid-template-columns: 1fr;
  }

  .regime-rail {
    position: static;
    max-height: none;
  }

  .regime-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }
}

@media (max-width: 900px) {
  .territory-layout {
    grid-template-columns: 1fr;
  }

  .territory-list-card {
    max-height: 320px;
  }
}

@media (max-width: 720px) {
  .scenario-page {
    padding: 14px;
  }

  .page-heading h1 {
    font-size: 24px;
  }

  .regime-name-input {
    width: 100%;
    font-size: 20px;
  }

  .regime-header-actions {
    width: 100%;
  }

  .regime-header-actions button {
    flex: 1;
  }

  .ai-panel-actions {
    width: 100%;
  }

  .ai-panel-actions button {
    flex: 1;
  }

  .territory-map-container {
    height: 420px;
  }

  .power-row {
    grid-template-columns: 1fr 76px;
  }

  .power-copy {
    grid-column: 1 / -1;
  }

  .power-range {
    grid-column: 1;
  }

  .power-number {
    grid-column: 2;
  }

  .scenario-stats {
    gap: 10px;
    font-size: 11px;
  }

  .save-indicator {
    margin-left: 0;
    width: 100%;
  }

  .json-preview-hint {
    display: none;
  }
}
</style>
