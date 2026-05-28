<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { useAiSettings } from '@/composables/ai-settings'
import { defaultEventDrivePrompt } from '@/composables/prompt-defaults'
import { submitPreparedPrompt } from '@/utils/submit-commition'

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
  chatInput: string
  chatMessages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

type EventDriveArchive = Record<string, EventDriveArchiveEntry>

const EVENT_DRIVE_ARCHIVE_KEY = 'event-drive-world-chat-archive-json'
const EVENT_DRIVE_LAST_WORLD_KEY = 'event-drive-last-world-key'
const CHAT_WINDOW_DRAFT_KEY = 'event-drive-chat-window-draft'
const WORLD_PACKAGE_TRANSFER_KEY = 'event-drive-world-package-json'
const WORLD_JSON_TRANSFER_KEY = 'event-drive-world-json'
const WORLD_LAND_TRANSFER_KEY = 'event-drive-world-land-json'

const router = useRouter()
const { apiValue, selectedModel, selectedProvider } = useAiSettings()

const chatInput = ref('')
const chatMessages = ref<ChatMessage[]>([])
const hiddenPromptMessages = ref<PromptMessage[]>([])
const worldContextMessage = ref<PromptMessage | null>(null)
const activeWorldPayload = ref<WorldLandTransferPayload | null>(null)
const activeWorldKey = ref('')
const isSending = ref(false)
const errorText = ref('')
const chatListRef = ref<HTMLElement | null>(null)
const archiveImportInputRef = ref<HTMLInputElement | null>(null)
const pendingWorldLandPayload = ref<WorldLandTransferPayload | null>(null)
const pendingWorldLandSource = ref<'session' | 'local' | null>(null)

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
    chatInput: chatInput.value,
    chatMessages: chatMessages.value,
    createdAt: existingEntry?.createdAt ?? now,
    updatedAt: now,
  }

  activeWorldKey.value = archiveKey
  window.localStorage.setItem(EVENT_DRIVE_LAST_WORLD_KEY, archiveKey)
  writeEventDriveArchive(archive)
}

const setActiveWorldContext = (payload: WorldLandTransferPayload) => {
  activeWorldPayload.value = payload
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
  chatMessages.value = []
  chatInput.value = ''
  errorText.value = ''

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
  loadChatWindowDraft()

  const worldLandState = readWorldLandPayload()
  const archive = readEventDriveArchive()
  const selectedArchiveKey = resolveArchiveKey(worldLandState?.payload ?? null, archive)

  if (selectedArchiveKey && archive[selectedArchiveKey]) {
    applyArchiveEntry(selectedArchiveKey, archive[selectedArchiveKey])
  } else if (worldLandState) {
    pendingWorldLandPayload.value = worldLandState.payload
    pendingWorldLandSource.value = worldLandState.source
    setActiveWorldContext(worldLandState.payload)
  } else if (Object.keys(archive).length === 1) {
    const [singleWorldKey] = Object.keys(archive)

    if (singleWorldKey && archive[singleWorldKey]) {
      applyArchiveEntry(singleWorldKey, archive[singleWorldKey])
    }
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
              <button class="ghost-button" type="button" @click="triggerArchiveImport">
                导入存档
              </button>
              <button class="ghost-button" type="button" @click="exportEventDriveArchive">
                导出存档
              </button>
              <button class="ghost-button" type="button" @click="resetChat">清空对话</button>
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

  .primary-button,
  .secondary-button,
  .ghost-button {
    width: 100%;
  }
}
</style>
