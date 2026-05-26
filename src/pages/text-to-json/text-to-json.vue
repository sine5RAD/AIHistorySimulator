<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
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

const validationErrors = ref<string[]>([])
const validationPassed = ref<boolean | null>(null)

const isString = (v: unknown) => typeof v === 'string'
const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const isRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)

const getProp = (obj: unknown, key: string): unknown =>
  isRecord(obj) ? (obj as Record<string, unknown>)[key] : undefined

const validatePopulation = (p: unknown, path = '人口') => {
  const errs: string[] = []
  if (!isRecord(p)) {
    errs.push(`${path} 应为对象`)
    return errs
  }

  const total = getProp(p, '总数')
  if (!isNumber(total)) errs.push(`${path}.总数 应为 number`)

  const ratio = getProp(p, '种族比例')
  if (!isRecord(ratio)) errs.push(`${path}.种族比例 应为键值对对象`)

  return errs
}

const validateCity = (c: unknown, path = '城市[]') => {
  const errs: string[] = []
  if (!isRecord(c)) {
    errs.push(`${path} 的项应为对象`)
    return errs
  }

  if (!isString(getProp(c, '名称'))) errs.push(`${path}.名称 应为字符串`)
  if (!isString(getProp(c, '简介'))) errs.push(`${path}.简介 应为字符串`)
  if (!isRecord(getProp(c, '人口比例'))) errs.push(`${path}.人口比例 应为键值对对象`)
  if (!isString(getProp(c, '经济状况'))) errs.push(`${path}.经济状况 应为字符串`)
  if (!isString(getProp(c, '政治状况'))) errs.push(`${path}.政治状况 应为字符串`)

  return errs
}

const validateMilitary = (m: unknown, path = '武装力量') => {
  const errs: string[] = []
  if (!isRecord(m)) {
    errs.push(`${path} 应为对象`)
    return errs
  }

  if (!isString(getProp(m, '名称'))) errs.push(`${path}.名称 应为字符串`)
  if (!isString(getProp(m, '规模'))) errs.push(`${path}.规模 应为字符串`)
  if (!isString(getProp(m, '兵役制度'))) errs.push(`${path}.兵役制度 应为字符串`)
  if (!Array.isArray(getProp(m, '军种'))) errs.push(`${path}.军种 应为数组`)

  return errs
}

const validateDefinition = (d: unknown, path = '名词定义[]') => {
  const errs: string[] = []
  if (!isRecord(d)) {
    errs.push(`${path} 的项应为对象`)
    return errs
  }

  if (!isString(getProp(d, '术语'))) errs.push(`${path}.术语 应为字符串`)
  if (!isString(getProp(d, '定义'))) errs.push(`${path}.定义 应为字符串`)

  return errs
}

const validateAlliance = (a: unknown, path = '政治.联盟[]') => {
  const errs: string[] = []
  if (!isRecord(a)) {
    errs.push(`${path} 的项应为对象`)
    return errs
  }

  if (!isString(getProp(a, '联盟名称'))) errs.push(`${path}.联盟名称 应为字符串`)
  if (!Array.isArray(getProp(a, '政党'))) errs.push(`${path}.政党 应为数组`)

  return errs
}

const validatePolitical = (p: unknown, path = '政治') => {
  const errs: string[] = []
  if (!isRecord(p)) {
    errs.push(`${path} 应为对象`)
    return errs
  }

  if (!Array.isArray(getProp(p, '政党'))) errs.push(`${path}.政党 应为数组`)
  if (!Array.isArray(getProp(p, '联盟'))) errs.push(`${path}.联盟 应为数组`)

  // 政治状况 应为键值对对象
  if (!isRecord(getProp(p, '政治状况'))) errs.push(`${path}.政治状况 应为键值对对象`)

  const alliances = getProp(p, '联盟')
  if (Array.isArray(alliances)) {
    for (let i = 0; i < alliances.length; i++) {
      errs.push(...validateAlliance(alliances[i], `${path}.联盟[${i}]`))
    }
  }

  return errs
}

const validateTechnology = (t: unknown, path = '科技') => {
  const errs: string[] = []
  if (!isRecord(t)) {
    errs.push(`${path} 应为对象`)
    return errs
  }

  const keys = ['重工业', '轻工业', '第三产业', '航天工业', '信息产业', '农业']
  for (const k of keys) {
    if (!isString(getProp(t, k))) errs.push(`${path}.${k} 应为字符串`)
  }

  return errs
}

const validateEthnicGroup = (e: unknown, path = '种族[]') => {
  const errs: string[] = []
  if (!isRecord(e)) {
    errs.push(`${path} 的项应为对象`)
    return errs
  }

  if (!isString(getProp(e, '名称'))) errs.push(`${path}.名称 应为字符串`)
  if (!isString(getProp(e, '简介'))) errs.push(`${path}.简介 应为字符串`)
  if (!isString(getProp(e, '文化'))) errs.push(`${path}.文化 应为字符串`)
  if (!isString(getProp(e, '宗教'))) errs.push(`${path}.宗教 应为字符串`)

  return errs
}

const validateCountry = (c: unknown, path = 'Country') => {
  const errs: string[] = []
  if (!isRecord(c)) {
    errs.push(`${path} 应为对象`)
    return errs
  }

  if (!isString(getProp(c, '国家名称'))) errs.push(`${path}.国家名称 应为字符串`)

  errs.push(...validatePopulation(getProp(c, '人口'), `${path}.人口`))

  if (!isString(getProp(c, '政治制度'))) errs.push(`${path}.政治制度 应为字符串`)
  if (!isString(getProp(c, '经济状况'))) errs.push(`${path}.经济状况 应为字符串`)

  const cities = getProp(c, '城市')
  if (!Array.isArray(cities)) errs.push(`${path}.城市 应为数组`)
  else {
    for (let i = 0; i < cities.length; i++) {
      errs.push(...validateCity(cities[i], `${path}.城市[${i}]`))
    }
  }

  if (!isString(getProp(c, '国歌'))) errs.push(`${path}.国歌 应为字符串`)
  if (!isString(getProp(c, '货币'))) errs.push(`${path}.货币 应为字符串`)

  errs.push(...validateMilitary(getProp(c, '武装力量'), `${path}.武装力量`))

  if (!isString(getProp(c, '武装力量法'))) errs.push(`${path}.武装力量法 应为字符串`)
  if (!isString(getProp(c, '宗教信仰'))) errs.push(`${path}.宗教信仰 应为字符串`)

  const defs = getProp(c, '名词定义')
  if (!Array.isArray(defs)) errs.push(`${path}.名词定义 应为数组`)
  else {
    for (let i = 0; i < defs.length; i++) {
      errs.push(...validateDefinition(defs[i], `${path}.名词定义[${i}]`))
    }
  }

  errs.push(...validatePolitical(getProp(c, '政治'), `${path}.政治`))

  errs.push(...validateTechnology(getProp(c, '科技'), `${path}.科技`))

  const ethnic = getProp(c, '种族')
  if (!Array.isArray(ethnic)) errs.push(`${path}.种族 应为数组`)
  else {
    for (let i = 0; i < ethnic.length; i++) {
      errs.push(...validateEthnicGroup(ethnic[i], `${path}.种族[${i}]`))
    }
  }

  return errs
}

const validateResultJson = () => {
  validationErrors.value = []
  validationPassed.value = null

  if (!resultText.value.trim()) {
    validationErrors.value.push('没有模型结果可供校验。')
    validationPassed.value = false
    return
  }

  const jsonText = normalizeJsonText(resultText.value)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    validationErrors.value.push('结果不是有效的 JSON。')
    validationPassed.value = false
    return
  }

  const candidates: unknown[] = []
  if (Array.isArray(parsed)) {
    candidates.push(...parsed)
  } else if (parsed && typeof parsed === 'object' && Array.isArray(getProp(parsed, 'countries'))) {
    candidates.push(...(getProp(parsed, 'countries') as unknown[]))
  } else {
    candidates.push(parsed)
  }

  for (let i = 0; i < candidates.length; i++) {
    const errs = validateCountry(candidates[i], `Country[${i}]`)
    if (errs.length) {
      validationErrors.value.push(...errs)
    }
  }

  if (validationErrors.value.length) {
    validationPassed.value = false
  } else {
    validationPassed.value = true
  }
}

const router = useRouter()

const sendToWorld = () => {
  // Ensure validation has been run and passed before sending
  if (!validationPassed.value) {
    validateResultJson()
    if (!validationPassed.value) return
  }

  const jsonText = normalizeJsonText(resultText.value)

  try {
    // store raw JSON text for world-generator to import
    window.localStorage.setItem('copiedCountryJson', jsonText)
    router.push({ name: 'world-generator' })
  } catch (err) {
    validationErrors.value = ['发送失败，请稍后重试。']
    validationPassed.value = false
    console.error('sendToWorld error', err)
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
          <button type="button" class="submit-button" @click="validateResultJson">
            校验 JSON 合法性
          </button>
          <button
            v-if="validationPassed === true"
            type="button"
            class="submit-button"
            @click="sendToWorld"
          >
            发送至世界
          </button>
        </div>
        <div v-if="validationPassed === true" class="success-text">
          JSON 校验通过，结构与 `CountryData` 匹配。
        </div>
        <div v-else-if="validationPassed === false" class="error-text">
          JSON 校验未通过：
          <ul>
            <li v-for="(err, idx) in validationErrors" :key="idx">{{ err }}</li>
          </ul>
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
