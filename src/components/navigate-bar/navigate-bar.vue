<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { formatTimezoneLabel, selectedTimezone } from '../../composables/timezone'

const realClockText = ref('')
let clockTimer: number | undefined

const currentTime = computed(() => formatTimezoneLabel(selectedTimezone.value))

const updateRealClock = () => {
  const now = new Date()
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60_000
  const timezoneTime = new Date(utcTime + selectedTimezone.value * 60_000 * 60)

  realClockText.value = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timezoneTime)
}

onMounted(() => {
  updateRealClock()
  clockTimer = window.setInterval(updateRealClock, 1000)
})

watch(selectedTimezone, updateRealClock)

onBeforeUnmount(() => {
  if (clockTimer !== undefined) {
    window.clearInterval(clockTimer)
  }
})
</script>

<template>
  <div id="nav-menu">
    <div id="nav-menu-left">
      <rouer-link to="/pages/index">
        <img src="/public/favicon.ico" alt="Logo" class="logo" />
      </rouer-link>
      <router-link to="/pages/text-to-json">
        <span class="nav-item"> 文章->json </span>
      </router-link>
      <router-link to="/pages/world-generator">
        <span class="nav-item">世界生成</span>
      </router-link>
      <router-link to="/pages/event-drive">
        <span class="nav-item">事件驱动</span>
      </router-link>
      <router-link to="/pages/setting">
        <span class="nav-item">设置</span>
      </router-link>
    </div>
    <div id="nav-menu-right">
      <!-- 世界线时钟 -->
      <span class="world-clock"></span>
      <!-- 本地时间 -->
      <span class="real-clock">{{ currentTime }} {{ realClockText }}</span>
    </div>
  </div>
</template>

<style src="./navigate-bar.css"></style>
