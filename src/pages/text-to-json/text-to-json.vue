<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { OfficeConverter } from 'officeparser'

import { defaultTextToJsonPrompt } from '@/composables/prompt-defaults'
import { submitPreparedPrompt } from '@/utils/submit-commition'

const textToJsonPromptKey = 'prompt-text-to-json'

const promptText = ref(defaultTextToJsonPrompt)
const selectedFile = ref<File | null>(null)
const fileContent = ref('')
const filePreview = ref('')
const resultText = ref('')
const errorText = ref('')
const isSubmitting = ref(false)

const createJsonFileName = () => {
  const baseName = selectedFile.value?.name.replace(/\.[^.]+$/, '') || 'result'

  return `${baseName}.json`
}

const normalizeJsonText = (text: string) => {
  const trimmed = text.trim()
  const codeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = codeFenceMatch?.[1]?.trim() || trimmed

  try {
    return JSON.stringify(JSON.parse(candidate), null, 2)
  } catch {
    return candidate
  }
}

const downloadResultAsJson = () => {
  if (!resultText.value.trim()) {
    errorText.value = '没有可下载的模型结果。'
    return
  }

  const jsonText = normalizeJsonText(resultText.value)
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = createJsonFileName()
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

const isOfficeFile = (file: File) => {
  return (
    file.name.toLowerCase().endsWith('.doc') ||
    file.name.toLowerCase().endsWith('.docx') ||
    file.name.toLowerCase().endsWith('.pdf')
  )
}

const readFileContent = async (file: File) => {
  if (isOfficeFile(file)) {
    const arrayBuffer = await file.arrayBuffer()
    const { value } = await OfficeConverter.convert(new Uint8Array(arrayBuffer), 'text')

    return typeof value === 'string' ? value : String(value)
  }

  return file.text()
}

const handleFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  selectedFile.value = file
  fileContent.value = ''
  filePreview.value = ''
  resultText.value = ''
  errorText.value = ''

  if (!file) {
    return
  }

  try {
    fileContent.value = await readFileContent(file)
    filePreview.value = fileContent.value.slice(0, 1000)
  } catch (error) {
    selectedFile.value = null
    errorText.value = isOfficeFile(file)
      ? 'Office 文件解析失败，请确认文件是有效的 .doc / .docx / .pdf 文件。'
      : '文件读取失败，请确认文件是可直接读取的文本内容。'
    console.error('Failed to read file', error)
  }
}

const submitToModel = async () => {
  if (!selectedFile.value) {
    errorText.value = '请先上传文件。'
    return
  }

  if (!fileContent.value.trim()) {
    errorText.value = '文件内容为空或无法读取。'
    return
  }

  isSubmitting.value = true
  errorText.value = ''
  resultText.value = ''

  try {
    const preparedPrompt = {
      messages: [
        {
          role: 'system' as const,
          content: promptText.value,
        },
        {
          role: 'user' as const,
          content: `下面是需要转换的文件内容，文件名：${selectedFile.value.name}\n\n${fileContent.value}`,
        },
      ],
    }

    const response = await submitPreparedPrompt(preparedPrompt)

    if (!response) {
      errorText.value = '模型没有返回有效结果。'
      return
    }

    resultText.value = response
  } catch (error) {
    errorText.value = '提交失败，请稍后重试。'
    console.error('Failed to submit prompt and file', error)
  } finally {
    isSubmitting.value = false
  }
}

onMounted(() => {
  const savedPrompt = window.localStorage.getItem(textToJsonPromptKey)
  promptText.value = savedPrompt || defaultTextToJsonPrompt
})
</script>

<template>
  <main class="page-shell">
    <section class="page-card">
      <h1 class="page-title">文章转 JSON</h1>
      <p class="page-description">先发送提示词，再发送文件内容到模型，最后显示远端返回的结果。</p>

      <div class="field-group">
        <label class="field-label" for="text-to-json-prompt">提示词</label>
        <textarea
          id="text-to-json-prompt"
          v-model="promptText"
          class="prompt-textarea"
          rows="6"
          placeholder="请输入文章转 JSON 的提示词"
        />
      </div>

      <div class="field-group">
        <label class="field-label" for="file-upload">文件上传</label>
        <input id="file-upload" class="file-input" type="file" @change="handleFileChange" />
        <p class="file-hint" v-if="selectedFile">已选择：{{ selectedFile.name }}</p>
      </div>

      <div v-if="filePreview" class="result-panel">
        <h2 class="result-title">文件预览</h2>
        <pre class="result-text">{{ filePreview }}</pre>
      </div>

      <div class="action-row">
        <button type="button" class="submit-button" :disabled="isSubmitting" @click="submitToModel">
          {{ isSubmitting ? '提交中...' : '提交' }}
        </button>
      </div>

      <p v-if="errorText" class="error-text">{{ errorText }}</p>

      <div v-if="resultText" class="result-panel">
        <h2 class="result-title">模型返回结果</h2>
        <pre class="result-text">{{ resultText }}</pre>
        <div class="action-row">
          <button type="button" class="submit-button" @click="downloadResultAsJson">
            下载 JSON
          </button>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  padding: 24px;
}

.page-card {
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.page-title {
  margin: 0;
  font-size: 24px;
  color: var(--color-text);
}

.page-description {
  margin: 0;
  color: var(--color-text);
  opacity: 0.8;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 14px;
  color: var(--color-text);
}

.prompt-textarea {
  width: 100%;
  min-height: 180px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  resize: vertical;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.file-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
}

.file-hint {
  margin: 0;
  font-size: 14px;
  color: var(--color-text);
  opacity: 0.75;
}

.action-row {
  display: flex;
  align-items: center;
}

.submit-button {
  min-width: 120px;
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
}

.submit-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error-text {
  margin: 0;
  color: #d92d20;
}

.result-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
}

.result-title {
  margin: 0;
  font-size: 18px;
  color: var(--color-text);
}

.result-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text);
}
</style>
