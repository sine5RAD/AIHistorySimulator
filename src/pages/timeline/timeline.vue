<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import TimelineChart from '@/components/timeline-chart/timeline-chart.vue'
import { isRecord, normalizeCountryIndicators } from '@/utils/country-data'
import {
  EVENT_DRIVE_SAVE_STORAGE_KEYS,
  readActiveEventDriveSave,
  type EventDriveSaveSnapshot,
} from '@/utils/event-drive-save'
import {
  buildTimelineLayout,
  createTimelineState,
  formatGameDate,
  readWorldColorMap,
  readWorldCountries,
  type TimelineRegimeSnapshot,
} from '@/utils/timeline'
import type { TimelineState } from '@/types/timeline'

/**
 * 时间线页。
 *
 * 只读取事件驱动页保存的当前存档（归档条目或选中的快照），
 * 不参与推演；事件驱动页在指标 / 政权变更时写入时间线。
 */

defineOptions({
  name: 'TimelinePage',
})

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const activeSave = ref<EventDriveSaveSnapshot | null>(null)
const timeline = ref<TimelineState | null>(null)

const buildStateFromSave = (save: EventDriveSaveSnapshot): TimelineState =>
  createTimelineState({
    countries: readWorldCountries(save.world),
    colorMap: readWorldColorMap(save.world),
    scenarioName: readText(save.world.scenarioName),
    startTimeText: readText(save.world.scenarioStartTime) || readText(save.world.generatedAt),
  })

const currentRegimes = computed<TimelineRegimeSnapshot[]>(() => {
  const save = activeSave.value

  if (!save) {
    return []
  }

  const colorMap = readWorldColorMap(save.world)
  const regimes: TimelineRegimeSnapshot[] = []

  for (const country of readWorldCountries(save.world)) {
    if (!isRecord(country)) {
      continue
    }

    const name = readText(country.国家名称)

    if (!name) {
      continue
    }

    const indicatorValue = country.国家指标 ?? country.初始国家力量
    const fallbackColor = readText(country.代表色)

    regimes.push({
      name,
      color: colorMap[name] ?? (fallbackColor || undefined),
      indicators: isRecord(indicatorValue) ? normalizeCountryIndicators(indicatorValue) : undefined,
    })
  }

  return regimes
})

const loadTimeline = () => {
  const save = readActiveEventDriveSave()

  activeSave.value = save
  timeline.value = save ? (save.timeline ?? buildStateFromSave(save)) : null
}

const layout = computed(() =>
  timeline.value ? buildTimelineLayout(timeline.value, currentRegimes.value) : null,
)

const hasRecordedEvents = computed(() => (timeline.value?.events.length ?? 0) > 0)
const aliveCount = computed(
  () => layout.value?.lanes.filter((lane) => lane.endKind === 'alive').length ?? 0,
)
const currentTimeLabel = computed(() =>
  timeline.value ? formatGameDate(timeline.value.startEpochMs, timeline.value.currentDay) : '—',
)
const startTimeLabel = computed(() => timeline.value?.startTimeText || '未填写')

const handleStorage = (event: StorageEvent) => {
  if (
    event.key === null ||
    (EVENT_DRIVE_SAVE_STORAGE_KEYS as readonly string[]).includes(event.key)
  ) {
    loadTimeline()
  }
}

onMounted(() => {
  loadTimeline()
  window.addEventListener('storage', handleStorage)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', handleStorage)
})
</script>

<template>
  <main class="timeline-page">
    <header class="timeline-header">
      <div class="timeline-header__copy">
        <p class="timeline-kicker">世界线</p>
        <h1 class="timeline-title">时间线</h1>
        <p class="timeline-description">
          横轴为时间，纵轴为政权，线条颜色取自政权代表色。国家指标因回合推进或事件触发而变化时，会在对应政权的时间线上记录事件点；鼠标悬停可查看事件概述。政权灭亡时，如果存在继承者，时间线会从灭亡事件向下分叉到继承国，颜色切换为继承国的代表色；没有继承者则时间线在此中断。
        </p>
      </div>

      <dl class="timeline-stats">
        <div class="timeline-stat">
          <dt>当前存档</dt>
          <dd>{{ activeSave?.label || '未加载' }}</dd>
        </div>
        <div class="timeline-stat">
          <dt>游戏内时间</dt>
          <dd>{{ currentTimeLabel }}</dd>
        </div>
        <div class="timeline-stat">
          <dt>事件 / 回合</dt>
          <dd>{{ layout?.eventCount ?? 0 }} / {{ timeline?.turn ?? 0 }}</dd>
        </div>
        <div class="timeline-stat">
          <dt>现存 / 灭亡</dt>
          <dd>{{ aliveCount }} / {{ layout?.destroyedCount ?? 0 }}</dd>
        </div>
      </dl>
    </header>

    <section v-if="activeSave && timeline && layout" class="timeline-panel">
      <div class="timeline-toolbar">
        <div class="timeline-toolbar__info">
          <strong>{{ activeSave.label }}</strong>
          <span
            >开局：{{ startTimeLabel }} · 当前：{{ currentTimeLabel }} · 第
            {{ timeline.turn }} 回合</span
          >
        </div>
        <div class="timeline-toolbar__actions">
          <button class="timeline-button" type="button" @click="loadTimeline">刷新</button>
          <router-link class="timeline-button" :to="{ name: 'event-drive' }">
            回到事件驱动
          </router-link>
        </div>
      </div>

      <p v-if="!hasRecordedEvents" class="timeline-notice">
        还没有记录到变动。在事件驱动页发送「时间推进」或「事件触发」后，国家指标变化与政权兴亡会显示在这里。
      </p>

      <TimelineChart
        :lanes="layout.lanes"
        :forks="layout.forks"
        :start-epoch-ms="timeline.startEpochMs"
        :current-day="timeline.currentDay"
        :last-day="layout.lastDay"
      />

      <div class="timeline-legend" aria-label="图例">
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--dot" />指标变动
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--diamond" />制度调整
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--square" />领土划转
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--triangle" />政权建立
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--cross" />政权灭亡
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--rename" />政权更名
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--line" />存续区间（颜色＝代表色）
        </span>
        <span class="timeline-legend__item">
          <i class="timeline-legend__shape timeline-legend__shape--fork" />继承者分叉
        </span>
      </div>
    </section>

    <section v-else class="timeline-empty">
      <h2>还没有可追踪的世界</h2>
      <p>
        请先在「事件驱动」页加载剧本并开始推演。时间线会随世界存档一起保存，之后回到这里即可查看。
      </p>
      <router-link class="timeline-button timeline-button--primary" :to="{ name: 'event-drive' }">
        前往事件驱动
      </router-link>
    </section>
  </main>
</template>

<style scoped>
.timeline-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1320px;
  margin: 0 auto;
  padding: 24px;
}

.timeline-header {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.9fr);
  gap: 24px;
  padding: 22px 24px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.timeline-header__copy {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
}

.timeline-kicker {
  margin: 0;
  color: var(--color-text);
  font-size: 13px;
  opacity: 0.7;
}

.timeline-title {
  margin: 0;
  color: var(--color-heading);
  font-size: 26px;
}

.timeline-description {
  margin: 0;
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.75;
  opacity: 0.82;
}

.timeline-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.timeline-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
}

.timeline-stat dt {
  color: var(--color-text);
  font-size: 11px;
  letter-spacing: 0.04em;
  opacity: 0.62;
}

.timeline-stat dd {
  margin: 0;
  overflow: hidden;
  color: var(--color-heading);
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 20px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.timeline-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.timeline-toolbar__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.timeline-toolbar__info strong {
  overflow: hidden;
  color: var(--color-heading);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-toolbar__info span {
  color: var(--color-text);
  font-size: 12px;
  opacity: 0.66;
}

.timeline-toolbar__actions {
  display: flex;
  gap: 8px;
}

.timeline-button {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-background);
  color: var(--color-text);
  font: inherit;
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}

.timeline-button:hover {
  border-color: var(--color-border-hover);
}

.timeline-button--primary {
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
  color: #0284c7;
}

.timeline-notice {
  margin: 0;
  padding: 9px 12px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.8;
}

.timeline-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  align-items: center;
  padding-top: 6px;
  border-top: 1px dashed var(--color-border);
  color: var(--color-text);
  font-size: 11px;
  opacity: 0.78;
}

.timeline-legend__item {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.timeline-legend__shape {
  display: inline-block;
  width: 10px;
  height: 10px;
  flex: none;
  background: currentColor;
}

.timeline-legend__shape--dot {
  border-radius: 50%;
}

.timeline-legend__shape--diamond {
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
}

.timeline-legend__shape--square {
  border-radius: 2px;
}

.timeline-legend__shape--triangle {
  width: 0;
  height: 0;
  background: transparent;
  border-right: 5px solid transparent;
  border-bottom: 9px solid currentColor;
  border-left: 5px solid transparent;
}

.timeline-legend__shape--cross {
  position: relative;
  background: transparent;
}

.timeline-legend__shape--cross::before,
.timeline-legend__shape--cross::after {
  position: absolute;
  top: 4px;
  left: -1px;
  width: 12px;
  height: 2px;
  background: currentColor;
  content: '';
}

.timeline-legend__shape--cross::before {
  transform: rotate(45deg);
}

.timeline-legend__shape--cross::after {
  transform: rotate(-45deg);
}

.timeline-legend__shape--rename {
  width: 9px;
  height: 9px;
  border: 1.6px solid currentColor;
  background: transparent;
  transform: rotate(45deg);
}

.timeline-legend__shape--line {
  width: 18px;
  height: 3px;
  border-radius: 999px;
}

.timeline-legend__shape--fork {
  position: relative;
  width: 14px;
  height: 12px;
  background: transparent;
}

.timeline-legend__shape--fork::before {
  position: absolute;
  top: 1px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  border-radius: 0 0 8px;
  content: '';
}

.timeline-empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  padding: 28px;
  border: 1px dashed var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.timeline-empty h2 {
  margin: 0;
  color: var(--color-heading);
  font-size: 18px;
}

.timeline-empty p {
  margin: 0;
  max-width: 640px;
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.8;
  opacity: 0.8;
}

@media (max-width: 900px) {
  .timeline-header {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .timeline-page {
    padding: 16px;
  }

  .timeline-stats {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
