<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

import {
  formatTimezoneLabel,
  selectedTimezone,
  storageKey,
  timezoneOptions,
} from '../../composables/timezone'
import { useAiSettings } from '@/composables/ai-settings'
import { defaultTextToJsonPrompt } from '@/composables/prompt-defaults'

const { apiValue, modelOptions, providerOptions, saveAiSettings, selectedModel, selectedProvider } =
  useAiSettings()

const textToJsonPromptKey = 'prompt-text-to-json'
const importWorldPromptKey = 'prompt-import-world'
const eventDrivePromptKey = 'prompt-event-drive'

const textToJsonPrompt = ref('')
const importWorldPrompt = ref('')
const eventDrivePrompt = ref('')
const textToJsonPromptRef = ref<HTMLTextAreaElement | null>(null)
const importWorldPromptRef = ref<HTMLTextAreaElement | null>(null)
const eventDrivePromptRef = ref<HTMLTextAreaElement | null>(null)

const defaultImportWorldPrompt =
  '请将以下信息导入当前世界观：提取关键实体、设定、关系与重要时间点，并在后续调用中记住这些设定。'
const defaultEventDrivePrompt =
  '基于当前世界观，生成下一步事件，包含事件描述、触发原因、主要参与者与可能后果，输出结构化要点列表。'

function savePrompts() {
  try {
    window.localStorage.setItem(textToJsonPromptKey, textToJsonPrompt.value)
    window.localStorage.setItem(importWorldPromptKey, importWorldPrompt.value)
    window.localStorage.setItem(eventDrivePromptKey, eventDrivePrompt.value)
  } catch (err) {
    console.error('Failed to save prompts', err)
  }
}

function resetTextToJsonPrompt() {
  textToJsonPrompt.value = defaultTextToJsonPrompt
  void nextTick(() => resizeTextarea(textToJsonPromptRef.value))
}

function resetImportWorldPrompt() {
  importWorldPrompt.value = defaultImportWorldPrompt
  void nextTick(() => resizeTextarea(importWorldPromptRef.value))
}

function resetEventDrivePrompt() {
  eventDrivePrompt.value = defaultEventDrivePrompt
  void nextTick(() => resizeTextarea(eventDrivePromptRef.value))
}

function resizeTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return

  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

onMounted(() => {
  window.localStorage.setItem(storageKey, selectedTimezone.value.toString())

  // load saved prompt templates
  const t1 = window.localStorage.getItem(textToJsonPromptKey)
  if (t1) textToJsonPrompt.value = t1
  else textToJsonPrompt.value = defaultTextToJsonPrompt

  const t2 = window.localStorage.getItem(importWorldPromptKey)
  if (t2) importWorldPrompt.value = t2
  else importWorldPrompt.value = defaultImportWorldPrompt

  const t3 = window.localStorage.getItem(eventDrivePromptKey)
  if (t3) eventDrivePrompt.value = t3
  else eventDrivePrompt.value = defaultEventDrivePrompt

  void nextTick(() => {
    resizeTextarea(textToJsonPromptRef.value)
    resizeTextarea(importWorldPromptRef.value)
    resizeTextarea(eventDrivePromptRef.value)
  })
})

watch(selectedTimezone, (value) => {
  window.localStorage.setItem(storageKey, value.toString())
})

watch(textToJsonPrompt, () => {
  void nextTick(() => resizeTextarea(textToJsonPromptRef.value))
})

watch(importWorldPrompt, () => {
  void nextTick(() => resizeTextarea(importWorldPromptRef.value))
})

watch(eventDrivePrompt, () => {
  void nextTick(() => resizeTextarea(eventDrivePromptRef.value))
})
</script>

<template>
  <main class="page-shell">
    <h1>设置</h1>
    <section class="setting-panel">
      <h2 class="setting-title">AI设置</h2>
      <div class="setting-field">
        <label class="setting-label" for="provider-select">模型提供商</label>
        <select id="provider-select" v-model="selectedProvider" class="setting-select">
          <option v-for="provider in providerOptions" :key="provider" :value="provider">
            {{ provider }}
          </option>
        </select>
      </div>
      <div class="setting-field">
        <label class="setting-label" for="api-input">API</label>
        <input
          id="api-input"
          v-model="apiValue"
          class="setting-input"
          type="text"
          placeholder="请输入 API"
        />
      </div>
      <div class="setting-field">
        <label class="setting-label" for="model-select">模型</label>
        <select id="model-select" v-model="selectedModel" class="setting-select">
          <option v-for="model in modelOptions" :key="model" :value="model">
            {{ model }}
          </option>
        </select>
      </div>
      <button type="button" class="setting-button" @click="saveAiSettings">保存</button>
    </section>
    <section class="setting-panel">
      <h2 class="setting-title">提示词设置</h2>
      <div class="setting-field-row">
        <div class="setting-field setting-field-grow">
          <label class="setting-label" for="prompt-text-to-json">文章转 JSON 提示词</label>
          <textarea
            id="prompt-text-to-json"
            ref="textToJsonPromptRef"
            v-model="textToJsonPrompt"
            class="setting-input setting-textarea"
            placeholder="例如：请把下面的文章转换为 JSON，保留作者、时间、要点"
            rows="1"
            @input="resizeTextarea(textToJsonPromptRef)"
          />
        </div>
        <button
          type="button"
          class="setting-button setting-reset-button"
          @click="resetTextToJsonPrompt"
        >
          重置
        </button>
      </div>
      <div class="setting-field-row">
        <div class="setting-field setting-field-grow">
          <label class="setting-label" for="prompt-import-world">导入世界观提示词</label>
          <textarea
            id="prompt-import-world"
            ref="importWorldPromptRef"
            v-model="importWorldPrompt"
            class="setting-input setting-textarea"
            placeholder="例如：请把以下信息加入世界观，记住设定和重要实体"
            rows="1"
            @input="resizeTextarea(importWorldPromptRef)"
          />
        </div>
        <button
          type="button"
          class="setting-button setting-reset-button"
          @click="resetImportWorldPrompt"
        >
          重置
        </button>
      </div>
      <div class="setting-field-row">
        <div class="setting-field setting-field-grow">
          <label class="setting-label" for="prompt-event-drive">事件驱动提示词</label>
          <textarea
            id="prompt-event-drive"
            ref="eventDrivePromptRef"
            v-model="eventDrivePrompt"
            class="setting-input setting-textarea"
            placeholder="例如：基于世界观生成下一步事件，包含动机、结果和影响"
            rows="1"
            @input="resizeTextarea(eventDrivePromptRef)"
          />
        </div>
        <button
          type="button"
          class="setting-button setting-reset-button"
          @click="resetEventDrivePrompt"
        >
          重置
        </button>
      </div>
      <div class="setting-field">
        <button type="button" class="setting-button" @click="savePrompts">保存提示词</button>
      </div>
    </section>
    <section class="setting-panel">
      <label class="setting-label" for="timezone-select">时区</label>
      <select id="timezone-select" v-model="selectedTimezone" class="setting-select">
        <option v-for="option in timezoneOptions" :key="option" :value="option">
          {{ option }}
        </option>
      </select>
      <p class="setting-hint">当前选择：{{ formatTimezoneLabel(selectedTimezone) }}</p>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  padding: 24px;
}

.setting-panel {
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.setting-title {
  margin: 0;
  font-size: 18px;
  color: var(--color-text);
}

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.setting-field-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.setting-field-grow {
  flex: 1;
}

.setting-label {
  font-size: 14px;
  color: var(--color-text);
}

.setting-select,
.setting-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
}

.setting-select:focus,
.setting-input:focus {
  outline: none;
  border-color: var(--color-border-hover);
}

.setting-button {
  width: fit-content;
  min-width: 96px;
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
}

.setting-button:hover {
  border-color: var(--color-border-hover);
}

.setting-reset-button {
  flex-shrink: 0;
  margin-bottom: 1px;
}

.setting-hint {
  font-size: 14px;
  color: var(--color-text);
}
</style>
