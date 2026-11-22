<!-- 点击国家后出现的信息面板：国家名 + 国家代码 + 预留的情报位 -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    name: string
    code: string
    /** 附加说明：国家显示英文名，市级行政区显示所属省份 */
    detail?: string
    /** 强调色：存档模式下跟随所点地块的政权代表色 */
    accent?: string
    x: number
    y: number
    /** 预留的情报列表，后续接 AI 接口时填入 */
    news?: { id: string | number; title: string; url: string }[]
  }>(),
  { detail: '', accent: '', news: () => [] },
)

const emit = defineEmits<{
  (event: 'height-change', height: number): void
}>()

const rootEl = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null

/** 面板被内容撑高后，连接线终点要跟着挪，所以把高度播报给地图 */
function reportHeight(): void {
  const height = rootEl.value?.offsetHeight
  if (height) {
    emit('height-change', height)
  }
}

function stopObserve(): void {
  observer?.disconnect()
  observer = null
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      stopObserve()
      return
    }
    // v-if 是可见后才创建节点，等 DOM 更新完再测高
    await nextTick()
    reportHeight()
    if (rootEl.value && typeof ResizeObserver !== 'undefined') {
      stopObserve()
      observer = new ResizeObserver(reportHeight)
      observer.observe(rootEl.value)
    }
  },
  { immediate: true },
)

onBeforeUnmount(stopObserve)

function openUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <div
    v-if="props.visible"
    ref="rootEl"
    class="info-panel"
    :style="{
      left: `${props.x}px`,
      top: `${props.y}px`,
      borderLeftColor: props.accent || undefined,
      borderLeftWidth: props.accent ? '3px' : undefined,
    }"
  >
    <div class="info-name">{{ props.name }}</div>
    <div class="info-code">{{ props.code }}</div>
    <div v-if="props.detail" class="info-detail">{{ props.detail }}</div>
    <!-- 战争威胁 / AI 情报，后续接接口 -->
    <div class="info-war-threat" />
    <div v-for="item in props.news" :key="item.id" class="info-news">
      <button type="button" class="info-news-title" @click="openUrl(item.url)">
        {{ item.title }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.info-panel {
  position: absolute;
  z-index: 10;
  min-width: 120px;
  min-height: 120px;
  padding: 8px 14px;
  border: 1px solid rgba(59, 130, 246, 0.5);
  border-radius: 8px;
  background: rgba(10, 14, 20, 0.9);
  box-shadow: 0 0 20px rgba(59, 130, 246, 0.15);
  backdrop-filter: blur(8px);
  pointer-events: none;
}

.info-name {
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
  white-space: nowrap;
}

.info-code {
  margin-top: 2px;
  max-width: 190px;
  overflow: hidden;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: rgba(148, 163, 184, 0.8);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-detail {
  margin-top: 4px;
  font-size: 11px;
  color: rgba(148, 163, 184, 0.62);
}

.info-news-title {
  padding: 0;
  border: none;
  background: none;
  color: #93c5fd;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
}

.info-news-title:hover {
  text-decoration: underline;
}
</style>
