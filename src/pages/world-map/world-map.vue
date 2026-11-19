<script setup lang="ts">
import { ref, watch } from 'vue'

import { useWorldMap } from '@/composables/world-map'
import InfoPanel from './components/info-panel.vue'
import LoadingPanel from './components/loading-panel.vue'

defineOptions({
  name: 'WorldMapPage',
})

/** 信息面板的实际高度，由面板自己量好播报回来，供连接线定位 */
const panelHeight = ref(58)

function updatePanelHeight(height: number): void {
  panelHeight.value = height
}

const {
  containerRef,
  canvasRef,
  infoVisible,
  infoName,
  infoCode,
  infoDetail,
  infoX,
  infoY,
  selectionKind,
  cityMode,
  loadState,
  loadError,
  cityLoading,
  retry,
} = useWorldMap({
  getPanelHeight: () => panelHeight.value,
})

/** 点开“国家”时覆盖一层“入侵进度”过场，播完自动收起；点市级行政区不播 */
const loadingVisible = ref(false)
watch([infoVisible, selectionKind], ([visible, kind]) => {
  if (visible && kind === 'country') {
    loadingVisible.value = true
  }
})
</script>

<template>
  <div ref="containerRef" class="world-map-page">
    <canvas ref="canvasRef" class="world-map-canvas" />

    <InfoPanel
      :visible="infoVisible"
      :name="infoName"
      :code="infoCode"
      :detail="infoDetail"
      :x="infoX"
      :y="infoY"
      @height-change="updatePanelHeight"
    />

    <LoadingPanel v-if="loadingVisible" :key="infoCode" @loading-end="loadingVisible = false" />

    <div v-if="loadState === 'loading'" class="world-map-hint">正在加载世界地图数据…</div>

    <div v-else-if="loadState === 'error'" class="world-map-hint world-map-hint--error">
      <p class="hint-title">世界地图数据加载失败</p>
      <p class="hint-detail">{{ loadError }}</p>
      <p class="hint-tip">
        执行 <code>node scripts/build-map-data.mjs --world --china</code> 可在本地生成地图数据；
        也可以把任意 <code>world.geojson</code> 放到 <code>public/geo/</code> 目录。
      </p>
      <button type="button" class="hint-retry" @click="retry">重新加载</button>
    </div>

    <p v-if="!cityMode" class="world-map-hint-zoom">滚轮放大后可查看下级行政区</p>

    <p v-if="cityLoading" class="world-map-hint-city">正在加载次级行政区…</p>

    <p class="world-map-attribution">
      边界数据：Natural Earth（公有领域）· geoBoundaries（CC BY 4.0）· 阿里云 DataV
    </p>
  </div>
</template>

<style scoped>
.world-map-page {
  position: relative;
  width: 100%;
  /* 导航栏固定 64px，地图铺满剩余空间 */
  height: calc(100vh - 64px);
  min-height: 320px;
  overflow: hidden;
  background: #0a0e14;
}

.world-map-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.world-map-canvas:active {
  cursor: grabbing;
}

.world-map-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 520px;
  padding: 18px 22px;
  border: 1px solid rgba(59, 130, 246, 0.4);
  border-radius: 10px;
  background: rgba(10, 14, 20, 0.88);
  color: #cbd5e1;
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}

.world-map-hint--error {
  border-color: rgba(248, 113, 113, 0.5);
}

.hint-title {
  margin: 0;
  color: #fca5a5;
  font-size: 15px;
  font-weight: 600;
}

.hint-detail {
  margin: 0;
  color: rgba(148, 163, 184, 0.85);
  font-size: 12px;
  word-break: break-all;
}

.hint-tip {
  margin: 0;
}

.hint-tip code {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.16);
  font-size: 12px;
}

.hint-retry {
  align-self: center;
  padding: 6px 16px;
  border: 1px solid rgba(59, 130, 246, 0.6);
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.15);
  color: #bfdbfe;
  cursor: pointer;
}

.hint-retry:hover {
  background: rgba(59, 130, 246, 0.3);
}

.world-map-hint-zoom {
  position: absolute;
  left: 16px;
  bottom: 14px;
  margin: 0;
  color: rgba(148, 163, 184, 0.55);
  font-size: 11px;
  letter-spacing: 0.4px;
  pointer-events: none;
}

.world-map-hint-city {
  position: absolute;
  left: 16px;
  bottom: 34px;
  margin: 0;
  padding: 3px 10px;
  border: 1px solid rgba(59, 130, 246, 0.35);
  border-radius: 999px;
  background: rgba(10, 14, 20, 0.8);
  color: #93c5fd;
  font-size: 11px;
  pointer-events: none;
}

.world-map-attribution {
  position: absolute;
  right: 14px;
  bottom: 10px;
  margin: 0;
  color: rgba(148, 163, 184, 0.42);
  font-size: 10px;
  letter-spacing: 0.3px;
  pointer-events: none;
}
</style>
