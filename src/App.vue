<script setup lang="ts">
import { RouterView } from 'vue-router'
import NavigateBar from './components/navigate-bar/navigate-bar.vue'
</script>

<template>
  <div class="app-shell">
    <NavigateBar />
    <main class="app-content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  width: 100%;
}

.app-content {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding-top: 64px;
}
</style>
