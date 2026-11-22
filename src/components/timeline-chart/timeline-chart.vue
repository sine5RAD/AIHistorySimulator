<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { DEFAULT_REGIME_COLOR } from '@/types/scenario'
import type { TimelineEvent, TimelineIndicators } from '@/types/timeline'
import {
  INDICATOR_KEYS,
  TIMELINE_EVENT_KIND_LABELS,
  TIMELINE_EVENT_SOURCE_LABELS,
  buildTimelineTicks,
  formatGameDate,
  formatIndicatorNumber,
  formatTimelineEventTime,
  safeTimelineColor,
  type TimelineFork,
  type TimelineLane,
} from '@/utils/timeline'

/**
 * 世界线时间线图。
 *
 * 横轴是距离开局的天数（有可解析的开局时间时显示真实日期），
 * 纵轴是一行一个政权；每一行用政权代表色画出存续区间，
 * 指标 / 制度 / 领土变动画成可悬停的点，灭亡与更名用分叉接到后续政权。
 *
 * 组件只负责画，不读写存档；缩放、平移与悬停状态都在组件内部。
 */

const props = defineProps<{
  lanes: TimelineLane[]
  forks: TimelineFork[]
  /** 开局时间可解析时的时间戳，用于把天数换算成日期。 */
  startEpochMs: number | null
  currentDay: number
  lastDay: number
}>()

const AXIS_HEIGHT = 40
const ROW_HEIGHT = 44
const LABEL_WIDTH = 176
const RIGHT_PADDING = 28
const BOTTOM_PADDING = 26

const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const width = ref(1100)

const rowsHeight = computed(() => Math.max(props.lanes.length, 1) * ROW_HEIGHT)
const svgHeight = computed(() => AXIS_HEIGHT + rowsHeight.value + BOTTOM_PADDING)
const plotLeft = LABEL_WIDTH
const plotRight = computed(() => Math.max(plotLeft + 140, width.value - RIGHT_PADDING))
const plotWidth = computed(() => plotRight.value - plotLeft)

const rows = computed(() =>
  props.lanes.map((lane, index) => ({
    lane,
    index,
    y: AXIS_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2,
  })),
)

const rowByLaneId = computed(() => new Map(rows.value.map((row) => [row.lane.id, row])))

interface HoverState {
  event: TimelineEvent
  lane: TimelineLane
  x: number
  y: number
}

const hovered = ref<HoverState | null>(null)

/* ------------------------------------------------------------------ *
 * 视口：天 -> 像素
 * ------------------------------------------------------------------ */

const domainEnd = computed(() => Math.max(props.lastDay, props.currentDay, 1))
const viewLimitEnd = computed(() => Math.max(domainEnd.value * 1.05, 7))
const minSpan = 1
const maxSpan = computed(() => Math.max(domainEnd.value * 6, 30))

const view = ref({ start: 0, span: 30 })

const resetView = () => {
  view.value = { start: 0, span: Math.max(domainEnd.value * 1.06, 7) }
}

const xFor = (day: number): number =>
  plotLeft + ((day - view.value.start) / view.value.span) * plotWidth.value

const clampStart = (start: number, span: number): number => {
  const limitEnd = Math.max(viewLimitEnd.value, span)

  return Math.min(Math.max(start, 0), Math.max(0, limitEnd - span))
}

const zoomAt = (pixelX: number, factor: number) => {
  const ratio = Math.min(1, Math.max(0, (pixelX - plotLeft) / plotWidth.value))
  const anchor = view.value.start + ratio * view.value.span
  const nextSpan = Math.min(Math.max(view.value.span * factor, minSpan), maxSpan.value)
  const nextStart = clampStart(anchor - ratio * nextSpan, nextSpan)

  view.value = { start: nextStart, span: nextSpan }
  hovered.value = null
}

const zoomBy = (factor: number) => {
  zoomAt(plotLeft + plotWidth.value / 2, factor)
}

const handleWheel = (event: WheelEvent) => {
  const rect = svgRef.value?.getBoundingClientRect()
  const pixelX = rect ? event.clientX - rect.left : plotLeft + plotWidth.value / 2

  zoomAt(pixelX, Math.exp(event.deltaY * 0.0015))
}

/* ------------------------------------------------------------------ *
 * 拖拽平移
 * ------------------------------------------------------------------ */

interface DragState {
  pointerId: number
  startX: number
  startView: { start: number; span: number }
}

const dragState = ref<DragState | null>(null)
const isDragging = computed(() => dragState.value !== null)

const handlePointerDown = (event: PointerEvent) => {
  if (!event.isPrimary || event.button !== 0) {
    return
  }

  dragState.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startView: { ...view.value },
  }
  svgRef.value?.setPointerCapture?.(event.pointerId)
}

const handlePointerMove = (event: PointerEvent) => {
  const drag = dragState.value

  if (!drag || drag.pointerId !== event.pointerId) {
    return
  }

  const deltaDays = ((event.clientX - drag.startX) / plotWidth.value) * drag.startView.span
  const nextStart = clampStart(drag.startView.start - deltaDays, drag.startView.span)

  if (Math.abs(event.clientX - drag.startX) > 2) {
    hovered.value = null
  }

  view.value = { start: nextStart, span: drag.startView.span }
}

const handlePointerUp = (event: PointerEvent) => {
  const drag = dragState.value

  if (!drag || drag.pointerId !== event.pointerId) {
    return
  }

  dragState.value = null
  svgRef.value?.releasePointerCapture?.(event.pointerId)
}

/* ------------------------------------------------------------------ *
 * 刻度
 * ------------------------------------------------------------------ */

const ticks = computed(() =>
  buildTimelineTicks(props.startEpochMs, view.value.start, view.value.start + view.value.span),
)

const tickAnchor = (day: number): 'start' | 'middle' | 'end' => {
  const x = xFor(day)

  if (x < plotLeft + 26) {
    return 'start'
  }

  if (x > plotRight.value - 26) {
    return 'end'
  }

  return 'middle'
}

const currentX = computed(() => xFor(props.currentDay))
const currentLabel = computed(() => formatGameDate(props.startEpochMs, props.currentDay))
const currentVisible = computed(
  () => currentX.value >= plotLeft - 1 && currentX.value <= plotRight.value + 1,
)

/* ------------------------------------------------------------------ *
 * 泳道与分叉
 * ------------------------------------------------------------------ */

const truncateName = (name: string): string => (name.length > 11 ? `${name.slice(0, 11)}…` : name)

const laneVisuals = computed(() =>
  rows.value.map((row) => {
    const startX = xFor(row.lane.startDay)
    const rawEndX = xFor(row.lane.endDay)

    return {
      ...row,
      color: safeTimelineColor(row.lane.color),
      startX,
      endX: Math.max(rawEndX, startX + 4),
    }
  }),
)

interface ForkVisual {
  fork: TimelineFork
  x: number
  fromY: number
  toY: number
  color: string
}

const forkVisuals = computed<ForkVisual[]>(() => {
  const visuals: ForkVisual[] = []

  for (const fork of props.forks) {
    const from = rowByLaneId.value.get(fork.fromLaneId)
    const to = rowByLaneId.value.get(fork.toLaneId)

    if (!from || !to) {
      continue
    }

    visuals.push({
      fork,
      x: xFor(fork.day),
      fromY: from.y,
      toY: to.y,
      color: safeTimelineColor(fork.color),
    })
  }

  return visuals
})

/** 从死亡点向下弯到继承者泳道的连接线；颜色取继承者的代表色。 */
const buildForkPath = (visual: ForkVisual): string => {
  const bend = Math.min(40, Math.max(16, Math.abs(visual.toY - visual.fromY) * 0.45))

  return [
    `M ${visual.x} ${visual.fromY}`,
    `C ${visual.x + bend} ${visual.fromY},`,
    `${visual.x + bend} ${visual.toY},`,
    `${visual.x} ${visual.toY}`,
  ].join(' ')
}

/* ------------------------------------------------------------------ *
 * 事件点
 * ------------------------------------------------------------------ */

interface PointVisual {
  event: TimelineEvent
  lane: TimelineLane
  x: number
  y: number
}

const pointVisuals = computed<PointVisual[]>(() => {
  const result: PointVisual[] = []

  for (const lane of props.lanes) {
    const row = rowByLaneId.value.get(lane.id)

    if (!row) {
      continue
    }

    const groups = new Map<number, TimelineEvent[]>()

    for (const event of lane.events) {
      const group = groups.get(event.day)

      if (group) {
        group.push(event)
      } else {
        groups.set(event.day, [event])
      }
    }

    for (const [day, group] of groups) {
      group.forEach((event, index) => {
        // 同一天在同一条泳道上可能有多条记录，纵向错开一点避免完全重叠。
        const offset = group.length > 1 ? (index - (group.length - 1) / 2) * 9 : 0

        result.push({ event, lane, x: xFor(day), y: row.y + offset })
      })
    }
  }

  return result
})

const pointColor = (point: PointVisual): string =>
  safeTimelineColor(point.event.color ?? point.lane.color)

const isHoveredPoint = (point: PointVisual): boolean => hovered.value?.event.id === point.event.id

/* ------------------------------------------------------------------ *
 * 悬停提示
 * ------------------------------------------------------------------ */

const showHover = (point: PointVisual) => {
  if (isDragging.value) {
    return
  }

  hovered.value = { event: point.event, lane: point.lane, x: point.x, y: point.y }
}

const hideHover = () => {
  hovered.value = null
}

const hoveredIndicatorRows = computed<Array<{ label: string; text: string }>>(() => {
  const event = hovered.value?.event

  if (!event || !event.indicators) {
    return []
  }

  const indicators: TimelineIndicators = event.indicators

  return INDICATOR_KEYS.map((key) => {
    const next = indicators[key]
    const previous = event.previousIndicators?.[key]

    return {
      label: key,
      text:
        previous === undefined
          ? formatIndicatorNumber(next)
          : `${formatIndicatorNumber(previous)} → ${formatIndicatorNumber(next)}`,
    }
  })
})

const hoveredColor = computed(() => {
  const point = hovered.value

  return point ? safeTimelineColor(point.event.color ?? point.lane.color) : DEFAULT_REGIME_COLOR
})

const hoveredTime = computed(() => {
  const point = hovered.value

  return point ? formatTimelineEventTime(props.startEpochMs, point.event) : ''
})

const tooltipStyle = computed(() => {
  const point = hovered.value

  if (!point) {
    return {}
  }

  const tooltipWidth = 306
  const left = Math.min(Math.max(point.x + 16, 8), Math.max(8, width.value - tooltipWidth - 8))
  const top = point.y > svgHeight.value - 180 ? point.y - 164 : point.y + 18

  return { left: `${left}px`, top: `${top}px` }
})

/* ------------------------------------------------------------------ *
 * 尺寸
 * ------------------------------------------------------------------ */

let resizeObserver: ResizeObserver | null = null

const measure = () => {
  const element = containerRef.value

  if (!element) {
    return
  }

  const nextWidth = element.clientWidth

  if (nextWidth > 0) {
    width.value = nextWidth
  }
}

onMounted(() => {
  measure()

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(containerRef.value)
  }

  resetView()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// 切换到另一份存档（或刷新后历史变长）时回到完整视图。
watch(
  () => props.lanes,
  () => resetView(),
)
</script>

<template>
  <div ref="containerRef" class="timeline-chart">
    <div class="timeline-chart__toolbar">
      <div class="timeline-chart__buttons">
        <button class="timeline-chart__button" type="button" @click="zoomBy(0.7)">＋</button>
        <button class="timeline-chart__button" type="button" @click="zoomBy(1.4)">－</button>
        <button class="timeline-chart__button" type="button" @click="resetView">重置视图</button>
      </div>
      <p class="timeline-chart__hint">滚轮缩放 · 拖拽平移 · 悬停事件点查看概述</p>
    </div>

    <div class="timeline-chart__plot">
      <svg
        ref="svgRef"
        class="timeline-chart__svg"
        :class="{ 'is-dragging': isDragging }"
        :width="width"
        :height="svgHeight"
        role="img"
        aria-label="国家时间线"
        @wheel.prevent="handleWheel"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerUp"
        @pointerleave="handlePointerUp"
        @dblclick="resetView"
      >
        <defs>
          <clipPath id="timeline-plot-clip">
            <rect
              :x="plotLeft"
              :y="AXIS_HEIGHT - 10"
              :width="plotWidth"
              :height="svgHeight - AXIS_HEIGHT + 10 - BOTTOM_PADDING"
            />
          </clipPath>
        </defs>

        <rect
          v-for="row in rows"
          :key="`row-bg-${row.lane.id}`"
          :x="0"
          :y="row.y - ROW_HEIGHT / 2"
          :width="width"
          :height="ROW_HEIGHT"
          :class="row.index % 2 === 0 ? 'timeline-chart__row-even' : 'timeline-chart__row-odd'"
        />

        <g class="timeline-chart__axis">
          <line
            v-for="tick in ticks"
            :key="`grid-${tick.day}`"
            :x1="xFor(tick.day)"
            :x2="xFor(tick.day)"
            :y1="AXIS_HEIGHT - 6"
            :y2="svgHeight - BOTTOM_PADDING"
            class="timeline-chart__gridline"
            :class="{ 'is-major': tick.major }"
          />
          <text
            v-for="tick in ticks"
            :key="`tick-${tick.day}`"
            :x="xFor(tick.day)"
            y="18"
            :text-anchor="tickAnchor(tick.day)"
            class="timeline-chart__tick-label"
          >
            {{ tick.label }}
          </text>
          <line
            :x1="0"
            :x2="width"
            :y1="AXIS_HEIGHT - 8"
            :y2="AXIS_HEIGHT - 8"
            class="timeline-chart__axis-line"
          />
          <line
            :x1="plotLeft - 12"
            :x2="plotLeft - 12"
            :y1="AXIS_HEIGHT - 8"
            :y2="svgHeight - BOTTOM_PADDING"
            class="timeline-chart__axis-line"
          />
        </g>

        <g class="timeline-chart__labels">
          <g v-for="row in rows" :key="`label-${row.lane.id}`">
            <circle :cx="16" :cy="row.y" r="5" :fill="safeTimelineColor(row.lane.color)" />
            <text :x="30" :y="row.y + 4" class="timeline-chart__label-text">
              {{ truncateName(row.lane.name) }}
            </text>
            <title>{{ row.lane.name }}</title>
          </g>
        </g>

        <g clip-path="url(#timeline-plot-clip)">
          <line
            v-for="row in laneVisuals"
            :key="`lane-glow-${row.lane.id}`"
            :x1="row.startX"
            :x2="row.endX"
            :y1="row.y"
            :y2="row.y"
            :stroke="row.color"
            class="timeline-chart__lane-line timeline-chart__lane-glow"
            stroke-width="10"
          />
          <line
            v-for="row in laneVisuals"
            :key="`lane-${row.lane.id}`"
            :x1="row.startX"
            :x2="row.endX"
            :y1="row.y"
            :y2="row.y"
            :stroke="row.color"
            class="timeline-chart__lane-line"
            stroke-width="3.5"
          />

          <path
            v-for="visual in forkVisuals"
            :key="`fork-${visual.fork.id}`"
            :d="buildForkPath(visual)"
            :stroke="visual.color"
            class="timeline-chart__fork"
            :class="{ 'timeline-chart__fork--rename': visual.fork.kind === 'rename' }"
          >
            <title>{{ visual.fork.label }}</title>
          </path>

          <g
            v-for="point in pointVisuals"
            :key="`point-${point.lane.id}-${point.event.id}`"
            class="timeline-chart__point"
            :class="{ 'is-active': isHoveredPoint(point) }"
            :data-country="point.event.country"
            :data-kind="point.event.kind"
            @mouseenter="showHover(point)"
            @mouseleave="hideHover"
          >
            <circle
              v-if="isHoveredPoint(point)"
              :cx="point.x"
              :cy="point.y"
              r="11"
              :stroke="pointColor(point)"
              class="timeline-chart__point-ring"
            />
            <circle :cx="point.x" :cy="point.y" r="12" class="timeline-chart__point-hit" />

            <circle
              v-if="point.event.kind === 'indicator'"
              :cx="point.x"
              :cy="point.y"
              :r="isHoveredPoint(point) ? 6.5 : 5"
              :fill="pointColor(point)"
              class="timeline-chart__dot"
            />
            <rect
              v-else-if="point.event.kind === 'reform'"
              :x="point.x - 4.5"
              :y="point.y - 4.5"
              width="9"
              height="9"
              :fill="pointColor(point)"
              :transform="`rotate(45 ${point.x} ${point.y})`"
              class="timeline-chart__diamond"
            />
            <rect
              v-else-if="point.event.kind === 'transfer'"
              :x="point.x - 4"
              :y="point.y - 4"
              width="8"
              height="8"
              rx="1.5"
              :fill="pointColor(point)"
              class="timeline-chart__square"
            />
            <path
              v-else-if="point.event.kind === 'create'"
              :d="`M ${point.x} ${point.y - 7} L ${point.x + 6.5} ${point.y + 4.5} L ${point.x - 6.5} ${point.y + 4.5} Z`"
              :fill="pointColor(point)"
              class="timeline-chart__triangle"
            />
            <g
              v-else-if="point.event.kind === 'destroy'"
              :transform="`translate(${point.x} ${point.y})`"
              :stroke="pointColor(point)"
              class="timeline-chart__cross"
            >
              <line x1="-5.5" y1="-5.5" x2="5.5" y2="5.5" />
              <line x1="-5.5" y1="5.5" x2="5.5" y2="-5.5" />
            </g>
            <rect
              v-else
              :x="point.x - 4.5"
              :y="point.y - 4.5"
              width="9"
              height="9"
              :stroke="pointColor(point)"
              :transform="`rotate(45 ${point.x} ${point.y})`"
              class="timeline-chart__rename"
            />
          </g>
        </g>

        <g v-if="currentVisible" class="timeline-chart__current">
          <line
            :x1="currentX"
            :x2="currentX"
            :y1="AXIS_HEIGHT - 8"
            :y2="svgHeight - BOTTOM_PADDING"
            class="timeline-chart__current-line"
          />
          <circle :cx="currentX" :cy="AXIS_HEIGHT - 8" r="4" class="timeline-chart__current-dot" />
          <text
            :x="currentX + (currentX > plotRight - 130 ? -8 : 8)"
            :y="svgHeight - 8"
            :text-anchor="currentX > plotRight - 130 ? 'end' : 'start'"
            class="timeline-chart__current-label"
          >
            当前 · {{ currentLabel }}
          </text>
        </g>

        <text
          v-if="!lanes.length"
          :x="width / 2"
          :y="AXIS_HEIGHT + ROW_HEIGHT / 2 + 4"
          text-anchor="middle"
          class="timeline-chart__empty"
        >
          暂无政权时间线
        </text>
      </svg>

      <div v-if="hovered" class="timeline-tooltip" :style="tooltipStyle" role="tooltip">
        <div class="timeline-tooltip__head">
          <span class="timeline-tooltip__dot" :style="{ background: hoveredColor }" />
          <strong class="timeline-tooltip__country">{{ hovered.event.country }}</strong>
          <span class="timeline-tooltip__kind">
            {{ TIMELINE_EVENT_KIND_LABELS[hovered.event.kind] }}
          </span>
        </div>

        <p class="timeline-tooltip__time">{{ hoveredTime }} · 第 {{ hovered.event.turn }} 回合</p>

        <p class="timeline-tooltip__summary">{{ hovered.event.summary }}</p>

        <dl v-if="hoveredIndicatorRows.length" class="timeline-tooltip__indicators">
          <div v-for="row in hoveredIndicatorRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.text }}</dd>
          </div>
        </dl>

        <p v-if="hovered.event.successors?.length" class="timeline-tooltip__meta">
          继承国：{{ hovered.event.successors.join('、') }}
        </p>
        <p
          v-else-if="hovered.event.kind === 'destroy'"
          class="timeline-tooltip__meta timeline-tooltip__meta--danger"
        >
          无继承者：时间线在此中断
        </p>

        <p v-if="hovered.event.nextName" class="timeline-tooltip__meta">
          更名为：{{ hovered.event.nextName }}
        </p>
        <p v-if="hovered.event.reason" class="timeline-tooltip__meta">
          原因：{{ hovered.event.reason }}
        </p>
        <p v-if="hovered.event.dateText" class="timeline-tooltip__meta timeline-tooltip__meta--dim">
          记载日期：{{ hovered.event.dateText }}
        </p>
        <p v-if="hovered.event.trigger" class="timeline-tooltip__meta timeline-tooltip__meta--dim">
          指令：{{ hovered.event.trigger }}
        </p>
        <p class="timeline-tooltip__meta timeline-tooltip__meta--dim">
          来源：{{ TIMELINE_EVENT_SOURCE_LABELS[hovered.event.source] }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-chart {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.timeline-chart__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.timeline-chart__buttons {
  display: flex;
  gap: 6px;
}

.timeline-chart__button {
  padding: 5px 11px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.timeline-chart__button:hover {
  border-color: var(--color-border-hover);
}

.timeline-chart__hint {
  margin: 0;
  color: var(--color-text);
  font-size: 12px;
  opacity: 0.6;
}

.timeline-chart__plot {
  position: relative;
  display: block;
  min-width: 0;
}

.timeline-chart__svg {
  display: block;
  max-width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.timeline-chart__svg.is-dragging {
  cursor: grabbing;
}

.timeline-chart__row-even {
  fill: transparent;
}

.timeline-chart__row-odd {
  fill: rgba(127, 127, 127, 0.06);
}

.timeline-chart__gridline {
  stroke: var(--color-border);
  stroke-width: 1;
  opacity: 0.5;
}

.timeline-chart__gridline.is-major {
  opacity: 0.85;
}

.timeline-chart__axis-line {
  stroke: var(--color-border);
  stroke-width: 1;
}

.timeline-chart__tick-label {
  fill: var(--color-text);
  font-size: 11px;
  opacity: 0.62;
}

.timeline-chart__label-text {
  fill: var(--color-text);
  font-size: 12px;
}

.timeline-chart__lane-line {
  stroke-linecap: round;
}

.timeline-chart__lane-glow {
  opacity: 0.16;
}

.timeline-chart__fork {
  fill: none;
  stroke-width: 2;
  opacity: 0.9;
}

.timeline-chart__fork--rename {
  stroke-dasharray: 5 4;
}

.timeline-chart__point {
  cursor: pointer;
}

.timeline-chart__point-hit {
  fill: transparent;
}

.timeline-chart__dot {
  stroke: var(--color-background-soft);
  stroke-width: 1.5;
}

.timeline-chart__point-ring {
  fill: none;
  stroke-width: 1.4;
  opacity: 0.55;
}

.timeline-chart__diamond,
.timeline-chart__square,
.timeline-chart__triangle {
  stroke: var(--color-background-soft);
  stroke-width: 1.2;
}

.timeline-chart__cross line {
  stroke-width: 2.2;
  stroke-linecap: round;
}

.timeline-chart__rename {
  fill: none;
  stroke-width: 1.8;
}

.timeline-chart__current-line {
  stroke: #38bdf8;
  stroke-width: 1.2;
  stroke-dasharray: 4 4;
  opacity: 0.8;
}

.timeline-chart__current-dot {
  fill: #38bdf8;
}

.timeline-chart__current-label {
  fill: #38bdf8;
  font-size: 11px;
}

.timeline-chart__empty {
  fill: var(--color-text);
  font-size: 13px;
  opacity: 0.5;
}

.timeline-tooltip {
  position: absolute;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 306px;
  max-width: calc(100% - 16px);
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  color: var(--color-text);
  font-size: 12px;
  line-height: 1.6;
  pointer-events: none;
}

.timeline-tooltip__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.timeline-tooltip__dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.timeline-tooltip__country {
  overflow: hidden;
  color: var(--color-heading);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-tooltip__kind {
  flex: none;
  margin-left: auto;
  padding: 1px 7px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 11px;
  opacity: 0.8;
}

.timeline-tooltip__time {
  margin: 0;
  font-size: 11px;
  opacity: 0.62;
}

.timeline-tooltip__summary {
  margin: 0;
  max-height: 10.5em;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.timeline-tooltip__indicators {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 0;
}

.timeline-tooltip__indicators > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.timeline-tooltip__indicators dt {
  opacity: 0.68;
}

.timeline-tooltip__indicators dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.timeline-tooltip__meta {
  margin: 0;
  font-size: 11px;
  opacity: 0.78;
  word-break: break-word;
}

.timeline-tooltip__meta--danger {
  color: #ef4444;
  opacity: 1;
}

.timeline-tooltip__meta--dim {
  opacity: 0.55;
}
</style>
