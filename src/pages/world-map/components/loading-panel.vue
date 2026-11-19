<!-- 点开国家后播放的“入侵当地网络”过场动画 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{
  (event: 'loading-end'): void
}>()

interface LoadingText {
  text: string
  prop: number
}

const loadingTextList: LoadingText[] = [
  { text: '接入当地互联网', prop: 0.11 },
  { text: '爬取媒体数据', prop: 0.11 },
  { text: '去除假情报', prop: 0.11 },
  { text: '收买政府官员', prop: 0.11 },
  { text: '骇入证券交易所', prop: 0.11 },
  { text: '标记高价值目标', prop: 0.11 },
  { text: '植入后门', prop: 0.11 },
  { text: '走私武器', prop: 0.11 },
  { text: '迎接2026年的世界', prop: 0.11 },
  { text: '为乌干达的儿童捐款', prop: 0.01 },
]

function pickByWeight(list: LoadingText[]): string {
  const totalWeight = list.reduce((sum, item) => sum + item.prop, 0)
  let random = Math.random() * totalWeight
  for (const item of list) {
    random -= item.prop
    if (random <= 0) {
      return item.text
    }
  }
  return list[list.length - 1]?.text ?? '这是一个bug'
}

/** 走完整个过场的时间：先显示进度文案，再淡出 */
const TICK_MS = 50
const TOTAL_MS = 6000
const FADE_MS = 1500
const DOT_INTERVAL_MS = 500

const text = ref(pickByWeight(loadingTextList))
const elapsed = ref(0)
let timer: number | null = null

const dots = computed(() => '.'.repeat(Math.floor(elapsed.value / DOT_INTERVAL_MS) % 4))
const alpha = computed(() => {
  const fadeStart = TOTAL_MS - FADE_MS
  if (elapsed.value <= fadeStart) {
    return 1
  }
  return Math.max(0, 1 - (elapsed.value - fadeStart) / FADE_MS)
})

onMounted(() => {
  timer = window.setInterval(() => {
    elapsed.value += TICK_MS
    if (elapsed.value >= TOTAL_MS && timer !== null) {
      window.clearInterval(timer)
      timer = null
      emit('loading-end')
    }
  }, TICK_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="loading-panel" :style="{ opacity: alpha }">
    <div class="loading-spinner" />
    <div class="loading-text">{{ text }}{{ dots }}</div>
  </div>
</template>

<style scoped>
.loading-panel {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 18px;
  background-color: #000;
  transition: opacity 0.1s linear;
}

.loading-spinner {
  width: 46px;
  height: 46px;
  border: 3px solid rgba(59, 130, 246, 0.25);
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: loading-spin 0.9s linear infinite;
}

.loading-text {
  font-family: 'Fira Code', Consolas, 'Courier New', monospace;
  font-size: 15px;
  letter-spacing: 0.08em;
  color: #e2e8f0;
  text-shadow: 0 0 12px rgba(59, 130, 246, 0.6);
}

@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
