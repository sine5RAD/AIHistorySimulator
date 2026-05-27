<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'

import { createEmptyWorldData, type WorldData } from '@/types/world'
import type { CountryData, Party } from '../../types/country'

const worldData = ref<WorldData>(createEmptyWorldData())
const countryJsonError = ref('')
const worldJsonError = ref('')
const countryJsonInput = ref<HTMLInputElement | null>(null)
const worldJsonInput = ref<HTMLInputElement | null>(null)
const SESSION_DRAFT_KEY = 'worldDataDraft'
const currentCountryIndex = ref(0)
const currentCountry = computed(
  () => worldData.value.countries[currentCountryIndex.value] ?? createNormalizedCountry(),
)

const isRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
const getProp = (obj: unknown, key: string): unknown =>
  isRecord(obj) ? (obj as Record<string, unknown>)[key] : undefined

const createEmptyCityData = () => ({
  名称: '',
  简介: '',
  人口比例: {} as Record<string, string>,
  经济状况: '',
  政治状况: '',
})

const createEmptyDefinitionData = () => ({
  术语: '',
  定义: '',
})

const createEmptyAllianceData = () => ({
  联盟名称: '',
  政党: [] as Party[],
})

const createEmptyPartyData = (): Party => ({
  名称: '',
  简介: '',
  主要人物: {},
})

const createEmptyEthnicGroupData = () => ({
  名称: '',
  简介: '',
  文化: '',
  宗教: '',
})

const createNormalizedCountry = (country: Partial<CountryData> = {}): CountryData => ({
  国家名称: country.国家名称 ?? '',
  人口: {
    总数: country.人口?.总数 ?? 0,
    种族比例: { ...country.人口?.种族比例 },
  },
  政治制度: country.政治制度 ?? '',
  经济状况: country.经济状况 ?? '',
  城市: (country.城市 ?? []).map((city) => ({
    名称: city?.名称 ?? '',
    简介: city?.简介 ?? '',
    人口比例: { ...city?.人口比例 },
    经济状况: city?.经济状况 ?? '',
    政治状况: city?.政治状况 ?? '',
  })),
  国歌: country.国歌 ?? '',
  货币: country.货币 ?? '',
  武装力量: {
    名称: country.武装力量?.名称 ?? '',
    规模: country.武装力量?.规模 ?? '',
    兵役制度: country.武装力量?.兵役制度 ?? '',
    军种: [...(country.武装力量?.军种 ?? [])],
  },
  武装力量法: country.武装力量法 ?? '',
  宗教信仰: country.宗教信仰 ?? '',
  名词定义: (country.名词定义 ?? []).map((definition) => ({
    术语: definition?.术语 ?? '',
    定义: definition?.定义 ?? '',
  })),
  政治: {
    政党: (country.政治?.政党 ?? []).map((party) => ({
      名称: party?.名称 ?? '',
      简介: party?.简介 ?? '',
      主要人物: { ...party?.主要人物 },
    })),
    联盟: (country.政治?.联盟 ?? []).map((alliance) => ({
      联盟名称: alliance?.联盟名称 ?? '',
      政党: (alliance?.政党 ?? []).map((party) => ({
        名称: party?.名称 ?? '',
        简介: party?.简介 ?? '',
        主要人物: { ...party?.主要人物 },
      })),
    })),
    政治状况: country.政治?.政治状况 ? { ...country.政治.政治状况 } : {},
  },
  科技: {
    重工业: country.科技?.重工业 ?? '',
    轻工业: country.科技?.轻工业 ?? '',
    第三产业: country.科技?.第三产业 ?? '',
    航天工业: country.科技?.航天工业 ?? '',
    信息产业: country.科技?.信息产业 ?? '',
    农业: country.科技?.农业 ?? '',
  },
  种族: (country.种族 ?? []).map((ethnicGroup) => ({
    名称: ethnicGroup?.名称 ?? '',
    简介: ethnicGroup?.简介 ?? '',
    文化: ethnicGroup?.文化 ?? '',
    宗教: ethnicGroup?.宗教 ?? '',
  })),
})

const createNormalizedCountryFromUnknown = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return createNormalizedCountry()
  }

  return createNormalizedCountry(value as Partial<CountryData>)
}

const handleMapUpload = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) return

  const reader = new FileReader()
  reader.onload = () => {
    worldData.value.worldMapImage = String(reader.result ?? '')
  }
  reader.readAsDataURL(file)
}

const normalizeCountries = (data: unknown): CountryData[] => {
  if (Array.isArray(data)) {
    return data.map((item) => createNormalizedCountryFromUnknown(item))
  }

  if (data && typeof data === 'object') {
    const maybeWorld = data as { countries?: unknown }

    if (Array.isArray(maybeWorld.countries)) {
      return maybeWorld.countries.map((item) => createNormalizedCountryFromUnknown(item))
    }

    return [createNormalizedCountryFromUnknown(data)]
  }

  return []
}

const getCountryNameKey = (country: CountryData) => country.国家名称.trim()

const upsertCountries = (countries: CountryData[]) => {
  for (const country of countries) {
    const countryName = getCountryNameKey(country)

    if (!countryName) {
      worldData.value.countries.push(country)
      continue
    }

    const existingIndex = worldData.value.countries.findIndex(
      (existingCountry) => getCountryNameKey(existingCountry) === countryName,
    )

    if (existingIndex >= 0) {
      worldData.value.countries.splice(existingIndex, 1, country)
      continue
    }

    worldData.value.countries.push(country)
  }
}

const handleCountryJsonImport = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  countryJsonError.value = ''

  if (!file) return

  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as unknown
    const countries = normalizeCountries(parsed)

    if (!countries.length) {
      countryJsonError.value = 'JSON 内容为空或格式不正确。'
      return
    }

    upsertCountries(countries)
    input.value = ''
  } catch (error) {
    countryJsonError.value = '国家 JSON 读取失败，请确认文件内容是有效的 JSON。'
    console.error('Failed to import country json', error)
  }
}

const handleWorldJsonImport = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  worldJsonError.value = ''

  if (!file) return

  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as unknown

    const nextWorldData = createEmptyWorldData()

    if (Array.isArray(parsed)) {
      nextWorldData.countries = normalizeCountries(parsed)
    } else if (parsed && typeof parsed === 'object') {
      const maybeWorld = parsed as { countries?: unknown; worldMapImage?: unknown }

      if (Array.isArray(maybeWorld.countries)) {
        nextWorldData.countries = normalizeCountries(maybeWorld.countries)
      }

      if (typeof maybeWorld.worldMapImage === 'string') {
        nextWorldData.worldMapImage = maybeWorld.worldMapImage
      }
    }

    if (!nextWorldData.countries.length && !nextWorldData.worldMapImage) {
      worldJsonError.value = 'JSON 内容为空或格式不正确。'
      return
    }

    worldData.value = nextWorldData
    input.value = ''
  } catch (error) {
    worldJsonError.value = '世界观 JSON 读取失败，请确认文件内容是有效的 JSON。'
    console.error('Failed to import world json', error)
  }
}

const removeCountry = (index: number) => {
  worldData.value.countries.splice(index, 1)
}

const addStringItem = (items: string[]) => {
  items.push('')
}

const removeStringItem = (items: string[], index: number) => {
  items.splice(index, 1)
}

const addRecordItem = (record: Record<string, string>, defaultKey: string) => {
  let nextKey = defaultKey.trim() || '新项'
  let suffix = 1

  while (Object.prototype.hasOwnProperty.call(record, nextKey)) {
    nextKey = `${defaultKey}${suffix}`
    suffix += 1
  }

  record[nextKey] = ''
}

const removeRecordItem = (record: Record<string, string>, key: string) => {
  delete record[key]
}

const renameRecordKey = (record: Record<string, string>, oldKey: string, event: Event) => {
  const nextKey = (event.target as HTMLInputElement).value.trim()

  if (!nextKey || nextKey === oldKey) {
    return
  }

  const value = record[oldKey] ?? ''
  delete record[oldKey]
  record[nextKey] = value
}

const setRecordValue = (record: Record<string, string>, key: string, event: Event) => {
  record[key] = (event.target as HTMLInputElement).value
}

const addCity = (country: CountryData) => {
  country.城市.push(createEmptyCityData())
}

const removeCity = (country: CountryData, index: number) => {
  country.城市.splice(index, 1)
}

const addDefinition = (country: CountryData) => {
  country.名词定义.push(createEmptyDefinitionData())
}

const removeDefinition = (country: CountryData, index: number) => {
  country.名词定义.splice(index, 1)
}

const addAlliance = (country: CountryData) => {
  country.政治.联盟.push(createEmptyAllianceData())
}

const removeAlliance = (country: CountryData, index: number) => {
  country.政治.联盟.splice(index, 1)
}

const addParty = (parties: Party[]) => {
  parties.push(createEmptyPartyData())
}

const removeParty = (parties: Party[], index: number) => {
  parties.splice(index, 1)
}

const addEthnicGroup = (country: CountryData) => {
  country.种族.push(createEmptyEthnicGroupData())
}

const removeEthnicGroup = (country: CountryData, index: number) => {
  country.种族.splice(index, 1)
}

const createSafeFileName = (value: string) => {
  const safeName = value.trim().replace(/[/:*?"<>|]+/g, '_')

  return safeName || 'country'
}

const downloadCountryJson = (country: CountryData) => {
  const json = JSON.stringify(country, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = `${createSafeFileName(country.国家名称)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

const downloadCountryListJson = () => {
  const json = JSON.stringify(worldData.value.countries, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = 'countries.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

const downloadWorldJson = () => {
  const json = JSON.stringify(worldData.value, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = 'world.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

const triggerCountryJsonImport = () => {
  countryJsonInput.value?.click()
}

const triggerSingleCountryJsonImport = () => {
  countryJsonInput.value?.click()
}

const triggerWorldJsonImport = () => {
  worldJsonInput.value?.click()
}

onMounted(() => {
  // Load draft from sessionStorage (persists within tab, cleared on tab close)
  try {
    const draftJson = window.sessionStorage.getItem(SESSION_DRAFT_KEY)
    if (draftJson) {
      const parsedDraft = JSON.parse(draftJson)
      // apply draft: normalize countries and map image
      if (isRecord(parsedDraft)) {
        const draftCountries = getProp(parsedDraft, 'countries')
        if (Array.isArray(draftCountries)) {
          const normalized = normalizeCountries(draftCountries)
          if (normalized.length) {
            upsertCountries(normalized)
          }
        }

        const mapImg = getProp(parsedDraft, 'worldMapImage')
        if (mapImg) {
          worldData.value.worldMapImage = String(mapImg)
        }
      }
    }
  } catch (err) {
    console.error('Failed to load world draft from sessionStorage', err)
  }

  // Also import a single copied JSON (from text-to-json) and then remove the temp key
  const json = window.localStorage.getItem('copiedCountryJson')
  if (json) {
    try {
      const parsed = JSON.parse(json)
      const countries = normalizeCountries(parsed)

      if (countries.length) {
        upsertCountries(countries)
      }
    } catch (err) {
      console.error('Failed to import copiedCountryJson', err)
    } finally {
      window.localStorage.removeItem('copiedCountryJson')
    }
  }
})

// Persist worldData to sessionStorage so it survives route navigation in the same tab
watch(
  worldData,
  (next) => {
    try {
      window.sessionStorage.setItem(SESSION_DRAFT_KEY, JSON.stringify(next))
    } catch (err) {
      console.error('Failed to save world draft to sessionStorage', err)
    }
  },
  { deep: true },
)

// Clamp currentCountryIndex when countries array changes
watch(
  () => worldData.value.countries.length,
  (len) => {
    if (!len) {
      currentCountryIndex.value = 0
      return
    }

    // wrap-around to ensure index is within bounds
    currentCountryIndex.value = ((currentCountryIndex.value % len) + len) % len
  },
)

const prevCountry = () => {
  const len = worldData.value.countries.length
  if (!len) return
  currentCountryIndex.value = (currentCountryIndex.value - 1 + len) % len
}

const nextCountry = () => {
  const len = worldData.value.countries.length
  if (!len) return
  currentCountryIndex.value = (currentCountryIndex.value + 1) % len
}
</script>

<template>
  <main class="page-shell">
    <div class="page-title-row">
      <h1>世界生成</h1>
      <div class="title-actions">
        <button type="button" @click="triggerWorldJsonImport">导入世界观 JSON</button>
        <button type="button" @click="downloadWorldJson">导出世界观 JSON</button>
      </div>
    </div>

    <section class="panel">
      <label class="label">上传世界地图（PNG/JPEG）</label>
      <input type="file" accept="image/*" @change="handleMapUpload" />
      <div v-if="worldData.worldMapImage" class="map-preview">
        <h3>地图预览</h3>
        <img :src="worldData.worldMapImage" alt="world map" />
      </div>
    </section>

    <section class="panel">
      <div class="panel-title-row">
        <h2>国家</h2>
        <div class="title-actions">
          <button type="button" @click="triggerCountryJsonImport">导入国家列表 JSON</button>
          <button type="button" @click="downloadCountryListJson">导出国家列表 JSON</button>
        </div>
      </div>
      <input
        ref="countryJsonInput"
        hidden
        type="file"
        accept="application/json,.json"
        @change="handleCountryJsonImport"
      />
      <input
        ref="worldJsonInput"
        hidden
        type="file"
        accept="application/json,.json"
        @change="handleWorldJsonImport"
      />
      <p v-if="countryJsonError" class="error-text">{{ countryJsonError }}</p>
      <p v-if="worldJsonError" class="error-text">{{ worldJsonError }}</p>

      <div class="country-export-row">
        <button type="button" @click="triggerSingleCountryJsonImport">导入单个国家 JSON</button>
        <button type="button" @click="downloadCountryJson(currentCountry)">
          导出单个国家 JSON
        </button>
      </div>

      <div class="country-list">
        <div class="country-pagination-controls">
          <button
            type="button"
            class="submit-button"
            @click="prevCountry"
            :disabled="!worldData.countries.length"
          >
            上一国
          </button>
          <span v-if="worldData.countries.length" class="pagination-indicator"
            >{{ currentCountryIndex + 1 }} / {{ worldData.countries.length }}</span
          >
          <button
            type="button"
            class="submit-button"
            @click="nextCountry"
            :disabled="!worldData.countries.length"
          >
            下一国
          </button>
        </div>

        <article v-if="worldData.countries.length" :key="currentCountryIndex" class="country-card">
          <div class="country-header">
            <div class="country-title-block">
              <label class="field-label" :for="`country-name-${currentCountryIndex}`"
                >国家名称</label
              >
              <input
                :id="`country-name-${currentCountryIndex}`"
                v-model="currentCountry.国家名称"
                class="field-input"
                type="text"
                placeholder="请输入国家名称"
              />
            </div>
            <div class="country-actions">
              <button type="button" @click="removeCountry(currentCountryIndex)">删除</button>
            </div>
          </div>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>人口</h3>
            </div>
            <div class="field-grid indent-1">
              <div class="field-block">
                <label class="field-label" :for="`country-population-${currentCountryIndex}`"
                  >总数</label
                >
                <input
                  :id="`country-population-${currentCountryIndex}`"
                  v-model.number="currentCountry.人口.总数"
                  class="field-input"
                  type="number"
                />
              </div>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>种族比例</h4>
                <button
                  type="button"
                  @click="addRecordItem(currentCountry.人口.种族比例, '新种族')"
                >
                  添加项
                </button>
              </div>
              <div
                v-if="!Object.keys(currentCountry.人口.种族比例).length"
                class="empty-hint indent-2"
              >
                暂无种族比例
              </div>
              <div
                v-for="(ratioValue, ratioKey) in currentCountry.人口.种族比例"
                :key="ratioKey"
                class="json-record-row indent-2"
              >
                <input
                  :value="ratioKey"
                  class="field-input json-key-input"
                  type="text"
                  @change="renameRecordKey(currentCountry.人口.种族比例, ratioKey, $event)"
                />
                <input
                  :value="ratioValue"
                  class="field-input"
                  type="text"
                  @input="setRecordValue(currentCountry.人口.种族比例, ratioKey, $event)"
                />
                <button
                  type="button"
                  @click="removeRecordItem(currentCountry.人口.种族比例, ratioKey)"
                >
                  删除
                </button>
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <h3>基本信息</h3>
            <div class="field-grid">
              <div class="field-block">
                <label class="field-label">政治制度</label>
                <input v-model="currentCountry.政治制度" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">经济状况</label>
                <textarea
                  v-model="currentCountry.经济状况"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">国歌</label>
                <input v-model="currentCountry.国歌" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">货币</label>
                <input v-model="currentCountry.货币" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">武装力量法</label>
                <textarea
                  v-model="currentCountry.武装力量法"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">宗教信仰</label>
                <textarea
                  v-model="currentCountry.宗教信仰"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <h3>武装力量</h3>
            <div class="field-grid indent-1">
              <div class="field-block">
                <label class="field-label">名称</label>
                <input v-model="currentCountry.武装力量.名称" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">规模</label>
                <input v-model="currentCountry.武装力量.规模" class="field-input" type="text" />
              </div>
              <div class="field-block">
                <label class="field-label">兵役制度</label>
                <input v-model="currentCountry.武装力量.兵役制度" class="field-input" type="text" />
              </div>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>军种</h4>
                <button type="button" @click="addStringItem(currentCountry.武装力量.军种)">
                  添加军种
                </button>
              </div>
              <div v-if="!currentCountry.武装力量.军种.length" class="empty-hint indent-2">
                暂无军种
              </div>
              <div
                v-for="(branch, branchIndex) in currentCountry.武装力量.军种"
                :key="branchIndex"
                class="json-array-row indent-2"
              >
                <input
                  v-model="currentCountry.武装力量.军种[branchIndex]"
                  class="field-input"
                  type="text"
                />
                <button
                  type="button"
                  @click="removeStringItem(currentCountry.武装力量.军种, branchIndex)"
                >
                  删除
                </button>
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>城市</h3>
              <button type="button" @click="addCity(currentCountry)">添加城市</button>
            </div>
            <div v-if="!currentCountry.城市.length" class="empty-hint indent-1">暂无城市</div>

            <article
              v-for="(city, cityIndex) in currentCountry.城市"
              :key="cityIndex"
              class="json-object-card indent-1"
            >
              <div class="json-object-card-header">
                <strong>城市 {{ cityIndex + 1 }}</strong>
                <button type="button" @click="removeCity(currentCountry, cityIndex)">删除</button>
              </div>
              <div class="field-grid indent-1">
                <div class="field-block">
                  <label class="field-label">名称</label>
                  <input v-model="city.名称" class="field-input" type="text" />
                </div>
                <div class="field-block">
                  <label class="field-label">简介</label>
                  <textarea v-model="city.简介" class="field-input field-textarea" rows="3" />
                </div>
                <div class="field-block">
                  <label class="field-label">经济状况</label>
                  <textarea v-model="city.经济状况" class="field-input field-textarea" rows="3" />
                </div>
                <div class="field-block">
                  <label class="field-label">政治状况</label>
                  <textarea v-model="city.政治状况" class="field-input field-textarea" rows="3" />
                </div>
              </div>

              <div class="json-section indent-1">
                <div class="json-section-header">
                  <h4>人口比例</h4>
                  <button type="button" @click="addRecordItem(city.人口比例, '新种族')">
                    添加项
                  </button>
                </div>
                <div v-if="!Object.keys(city.人口比例).length" class="empty-hint indent-2">
                  暂无人口比例
                </div>
                <div
                  v-for="(value, key) in city.人口比例"
                  :key="key"
                  class="json-record-row indent-2"
                >
                  <input
                    :value="key"
                    class="field-input json-key-input"
                    type="text"
                    @change="renameRecordKey(city.人口比例, key, $event)"
                  />
                  <input
                    :value="value"
                    class="field-input"
                    type="text"
                    @input="setRecordValue(city.人口比例, key, $event)"
                  />
                  <button type="button" @click="removeRecordItem(city.人口比例, key)">删除</button>
                </div>
              </div>
            </article>
          </section>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>名词定义</h3>
              <button type="button" @click="addDefinition(currentCountry)">添加定义</button>
            </div>
            <div v-if="!currentCountry.名词定义.length" class="empty-hint indent-1">
              暂无名词定义
            </div>
            <article
              v-for="(definition, definitionIndex) in currentCountry.名词定义"
              :key="definitionIndex"
              class="json-object-card indent-1"
            >
              <div class="json-object-card-header">
                <strong>定义 {{ definitionIndex + 1 }}</strong>
                <button type="button" @click="removeDefinition(currentCountry, definitionIndex)">
                  删除
                </button>
              </div>
              <div class="field-grid indent-1">
                <div class="field-block">
                  <label class="field-label">术语</label>
                  <input v-model="definition.术语" class="field-input" type="text" />
                </div>
                <div class="field-block">
                  <label class="field-label">定义</label>
                  <textarea v-model="definition.定义" class="field-input field-textarea" rows="3" />
                </div>
              </div>
            </article>
          </section>

          <section class="json-section indent-1">
            <h3>政治</h3>
            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>政党</h4>
                <button type="button" @click="addParty(currentCountry.政治.政党)">添加政党</button>
              </div>
              <div v-if="!currentCountry.政治.政党.length" class="empty-hint indent-2">
                暂无政党
              </div>
              <article
                v-for="(party, partyIndex) in currentCountry.政治.政党"
                :key="partyIndex"
                class="json-object-card indent-2"
              >
                <div class="json-object-card-header">
                  <strong>政党 {{ partyIndex + 1 }}</strong>
                  <button type="button" @click="removeParty(currentCountry.政治.政党, partyIndex)">
                    删除
                  </button>
                </div>
                <div class="field-grid indent-1">
                  <div class="field-block">
                    <label class="field-label">名称</label>
                    <input v-model="party.名称" class="field-input" type="text" />
                  </div>
                  <div class="field-block">
                    <label class="field-label">简介</label>
                    <textarea v-model="party.简介" class="field-input field-textarea" rows="3" />
                  </div>
                </div>
                <div class="json-section indent-1">
                  <div class="json-section-header">
                    <h5>主要人物</h5>
                    <button type="button" @click="addRecordItem(party.主要人物, '新人物')">
                      添加项
                    </button>
                  </div>
                  <div v-if="!Object.keys(party.主要人物).length" class="empty-hint indent-2">
                    暂无主要人物
                  </div>
                  <div
                    v-for="(personEthnicity, personName) in party.主要人物"
                    :key="personName"
                    class="json-record-row indent-2"
                  >
                    <input
                      :value="personName"
                      class="field-input json-key-input"
                      type="text"
                      @change="renameRecordKey(party.主要人物, personName, $event)"
                    />
                    <input
                      :value="personEthnicity"
                      class="field-input"
                      type="text"
                      @input="setRecordValue(party.主要人物, personName, $event)"
                    />
                    <button type="button" @click="removeRecordItem(party.主要人物, personName)">
                      删除
                    </button>
                  </div>
                </div>
              </article>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>联盟</h4>
                <button type="button" @click="addAlliance(currentCountry)">添加联盟</button>
              </div>
              <div v-if="!currentCountry.政治.联盟.length" class="empty-hint indent-2">
                暂无联盟
              </div>
              <article
                v-for="(alliance, allianceIndex) in currentCountry.政治.联盟"
                :key="allianceIndex"
                class="json-object-card indent-2"
              >
                <div class="json-object-card-header">
                  <strong>联盟 {{ allianceIndex + 1 }}</strong>
                  <button type="button" @click="removeAlliance(currentCountry, allianceIndex)">
                    删除
                  </button>
                </div>
                <div class="field-grid indent-1">
                  <div class="field-block">
                    <label class="field-label">联盟名称</label>
                    <input v-model="alliance.联盟名称" class="field-input" type="text" />
                  </div>
                </div>
                <div class="json-section indent-1">
                  <div class="json-section-header">
                    <h5>政党</h5>
                    <button type="button" @click="addParty(alliance.政党)">添加政党</button>
                  </div>
                  <div v-if="!alliance.政党.length" class="empty-hint indent-2">暂无政党</div>
                  <article
                    v-for="(party, partyIndex) in alliance.政党"
                    :key="partyIndex"
                    class="json-object-card indent-2"
                  >
                    <div class="json-object-card-header">
                      <strong>政党 {{ partyIndex + 1 }}</strong>
                      <button type="button" @click="removeParty(alliance.政党, partyIndex)">
                        删除
                      </button>
                    </div>
                    <div class="field-grid indent-1">
                      <div class="field-block">
                        <label class="field-label">名称</label>
                        <input v-model="party.名称" class="field-input" type="text" />
                      </div>
                      <div class="field-block">
                        <label class="field-label">简介</label>
                        <textarea
                          v-model="party.简介"
                          class="field-input field-textarea"
                          rows="3"
                        />
                      </div>
                    </div>
                    <div class="json-section indent-1">
                      <div class="json-section-header">
                        <h5>主要人物</h5>
                        <button type="button" @click="addRecordItem(party.主要人物, '新人物')">
                          添加项
                        </button>
                      </div>
                      <div v-if="!Object.keys(party.主要人物).length" class="empty-hint indent-2">
                        暂无主要人物
                      </div>
                      <div
                        v-for="(personEthnicity, personName) in party.主要人物"
                        :key="personName"
                        class="json-record-row indent-2"
                      >
                        <input
                          :value="personName"
                          class="field-input json-key-input"
                          type="text"
                          @change="renameRecordKey(party.主要人物, personName, $event)"
                        />
                        <input
                          :value="personEthnicity"
                          class="field-input"
                          type="text"
                          @input="setRecordValue(party.主要人物, personName, $event)"
                        />
                        <button type="button" @click="removeRecordItem(party.主要人物, personName)">
                          删除
                        </button>
                      </div>
                    </div>
                  </article>
                </div>
              </article>
            </div>

            <div class="json-section indent-1">
              <div class="json-section-header">
                <h4>政治状况</h4>
                <button
                  type="button"
                  @click="addRecordItem(currentCountry.政治.政治状况, '新状态')"
                >
                  添加项
                </button>
              </div>
              <div
                v-if="!Object.keys(currentCountry.政治.政治状况).length"
                class="empty-hint indent-2"
              >
                暂无政治状况
              </div>
              <div
                v-for="(statusValue, statusKey) in currentCountry.政治.政治状况"
                :key="statusKey"
                class="json-record-row indent-2"
              >
                <input
                  :value="statusKey"
                  class="field-input json-key-input"
                  type="text"
                  @change="renameRecordKey(currentCountry.政治.政治状况, statusKey, $event)"
                />
                <input
                  :value="statusValue"
                  class="field-input"
                  type="text"
                  @input="setRecordValue(currentCountry.政治.政治状况, statusKey, $event)"
                />
                <button
                  type="button"
                  @click="removeRecordItem(currentCountry.政治.政治状况, statusKey)"
                >
                  删除
                </button>
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <h3>科技</h3>
            <div class="field-grid">
              <div class="field-block">
                <label class="field-label">重工业</label>
                <textarea
                  v-model="currentCountry.科技.重工业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">轻工业</label>
                <textarea
                  v-model="currentCountry.科技.轻工业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">第三产业</label>
                <textarea
                  v-model="currentCountry.科技.第三产业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">航天工业</label>
                <textarea
                  v-model="currentCountry.科技.航天工业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">信息产业</label>
                <textarea
                  v-model="currentCountry.科技.信息产业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
              <div class="field-block">
                <label class="field-label">农业</label>
                <textarea
                  v-model="currentCountry.科技.农业"
                  class="field-input field-textarea"
                  rows="3"
                />
              </div>
            </div>
          </section>

          <section class="json-section indent-1">
            <div class="json-section-header">
              <h3>种族</h3>
              <button type="button" @click="addEthnicGroup(currentCountry)">添加种族</button>
            </div>
            <div v-if="!currentCountry.种族.length" class="empty-hint indent-1">暂无种族</div>
            <article
              v-for="(ethnicGroup, ethnicIndex) in currentCountry.种族"
              :key="ethnicIndex"
              class="json-object-card indent-1"
            >
              <div class="json-object-card-header">
                <strong>种族 {{ ethnicIndex + 1 }}</strong>
                <button type="button" @click="removeEthnicGroup(currentCountry, ethnicIndex)">
                  删除
                </button>
              </div>
              <div class="field-grid indent-1">
                <div class="field-block">
                  <label class="field-label">名称</label>
                  <input v-model="ethnicGroup.名称" class="field-input" type="text" />
                </div>
                <div class="field-block">
                  <label class="field-label">简介</label>
                  <textarea
                    v-model="ethnicGroup.简介"
                    class="field-input field-textarea"
                    rows="3"
                  />
                </div>
                <div class="field-block">
                  <label class="field-label">文化</label>
                  <textarea
                    v-model="ethnicGroup.文化"
                    class="field-input field-textarea"
                    rows="3"
                  />
                </div>
                <div class="field-block">
                  <label class="field-label">宗教</label>
                  <textarea
                    v-model="ethnicGroup.宗教"
                    class="field-input field-textarea"
                    rows="3"
                  />
                </div>
              </div>
            </article>
          </section>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  padding: 24px;
}

.page-title-row,
.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.title-actions,
.country-actions,
.country-export-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.panel {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.country-list {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.country-card {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.country-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.country-title-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.country-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.json-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}

.json-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.field-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.field-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 14px;
  color: var(--color-text);
}

.field-input {
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
}

.field-textarea {
  min-height: 96px;
  resize: vertical;
}

.json-object-card {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
}

.json-object-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.json-array-row,
.json-record-row {
  display: grid;
  gap: 8px;
  align-items: center;
  grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) auto;
  margin-top: 8px;
}

.json-key-input {
  font-weight: 600;
}

.empty-hint {
  margin-top: 8px;
  font-size: 14px;
  color: var(--color-text);
  opacity: 0.65;
}

.map-preview img {
  max-width: 100%;
  height: auto;
  display: block;
  margin-top: 8px;
}

.indent-1 {
  padding-left: 16px;
}

.indent-2 {
  padding-left: 32px;
}

.indent-3 {
  padding-left: 48px;
}
</style>
