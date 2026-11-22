<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

export interface FloatingCountrySidebarStat {
  label: string
  value: string
}

export interface FloatingCountrySidebarItem {
  id: string
  name: string
  color?: string
  subtitle?: string
  summary?: string
  stats?: FloatingCountrySidebarStat[]
}

export interface FloatingCountrySidebarEditStatPayload {
  item: FloatingCountrySidebarItem
  label: string
  newValue: string
}

const props = withDefaults(
  defineProps<{
    title?: string
    items: FloatingCountrySidebarItem[]
    emptyText?: string
    /** 是否在每个政权的展开面板里显示「灭亡」按钮。 */
    destroyable?: boolean
  }>(),
  {
    title: '国家列表',
    emptyText: '暂无国家',
    destroyable: false,
  },
)

const emit = defineEmits<{
  select: [item: FloatingCountrySidebarItem]
  'edit-stat': [payload: FloatingCountrySidebarEditStatPayload]
  destroy: [item: FloatingCountrySidebarItem]
}>()

const activeId = ref<string | null>(null)
const isCollapsed = ref(false)
const editingKey = ref<string | null>(null)
const editValue = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

const visibleItems = computed(() => props.items.filter((item) => item.id.trim().length > 0))

watch(
  visibleItems,
  (items) => {
    if (!items.length) {
      activeId.value = null
      return
    }

    if (!items.some((item) => item.id === activeId.value)) {
      activeId.value = items[0]?.id ?? null
    }
  },
  { immediate: true },
)

const toggleItem = (item: FloatingCountrySidebarItem) => {
  activeId.value = activeId.value === item.id ? null : item.id
  emit('select', item)
}

const toggleSidebar = () => {
  isCollapsed.value = !isCollapsed.value
}

const buildItemStyle = (item: FloatingCountrySidebarItem) =>
  ({
    '--country-color': item.color || 'var(--color-border)',
  }) as Record<string, string>

const editKey = (item: FloatingCountrySidebarItem, stat: FloatingCountrySidebarStat) =>
  `${item.id}::${stat.label}`

const isEditing = (item: FloatingCountrySidebarItem, stat: FloatingCountrySidebarStat) =>
  editingKey.value === editKey(item, stat)

const startEditing = async (item: FloatingCountrySidebarItem, stat: FloatingCountrySidebarStat) => {
  editingKey.value = editKey(item, stat)
  editValue.value = stat.value
  await nextTick()
  editInputRef.value?.focus()
  editInputRef.value?.select()
}

const commitEdit = (item: FloatingCountrySidebarItem, stat: FloatingCountrySidebarStat) => {
  const newValue = editValue.value.trim()
  editingKey.value = null
  editValue.value = ''

  if (newValue && newValue !== stat.value) {
    emit('edit-stat', { item, label: stat.label, newValue })
  }
}

const cancelEdit = () => {
  editingKey.value = null
  editValue.value = ''
}

const handleEditKeydown = (
  event: KeyboardEvent,
  item: FloatingCountrySidebarItem,
  stat: FloatingCountrySidebarStat,
) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitEdit(item, stat)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  }
}
</script>

<template>
  <aside class="floating-country-sidebar" aria-label="国家列表侧边栏">
    <div class="floating-country-sidebar__shell" :class="{ 'is-collapsed': isCollapsed }">
      <header class="floating-country-sidebar__header">
        <div class="floating-country-sidebar__header-copy">
          <p class="floating-country-sidebar__eyebrow">快捷查看</p>
          <h2 class="floating-country-sidebar__title">{{ title }}</h2>
        </div>

        <div class="floating-country-sidebar__header-actions">
          <span class="floating-country-sidebar__count">{{ visibleItems.length }}</span>
          <button
            class="floating-country-sidebar__collapse-button"
            type="button"
            :aria-label="isCollapsed ? '展开侧边栏' : '收起侧边栏'"
            @click="toggleSidebar"
          >
            {{ isCollapsed ? '展开' : '收起' }}
          </button>
        </div>
      </header>

      <div v-if="!isCollapsed && visibleItems.length" class="floating-country-sidebar__list">
        <section
          v-for="item in visibleItems"
          :key="item.id"
          class="floating-country-sidebar__item"
          :class="{ 'is-active': activeId === item.id }"
          :style="buildItemStyle(item)"
        >
          <button class="floating-country-sidebar__trigger" type="button" @click="toggleItem(item)">
            <span class="floating-country-sidebar__name">{{ item.name }}</span>
            <span class="floating-country-sidebar__arrow">{{
              activeId === item.id ? '收起' : '展开'
            }}</span>
          </button>

          <transition name="floating-country-sidebar-expand">
            <div v-if="activeId === item.id" class="floating-country-sidebar__panel">
              <p v-if="item.subtitle" class="floating-country-sidebar__subtitle">
                {{ item.subtitle }}
              </p>
              <p v-if="item.summary" class="floating-country-sidebar__summary">
                {{ item.summary }}
              </p>

              <dl v-if="item.stats?.length" class="floating-country-sidebar__stats">
                <div
                  v-for="stat in item.stats"
                  :key="stat.label"
                  class="floating-country-sidebar__stat"
                  :class="{ 'is-editing': isEditing(item, stat) }"
                >
                  <dt>{{ stat.label }}</dt>
                  <dd
                    v-if="!isEditing(item, stat)"
                    class="floating-country-sidebar__stat-value"
                    tabindex="0"
                    role="button"
                    :aria-label="`编辑 ${item.name} 的${stat.label}`"
                    @click="startEditing(item, stat)"
                    @keydown.enter.prevent="startEditing(item, stat)"
                  >
                    {{ stat.value }}
                  </dd>
                  <input
                    v-else
                    ref="editInputRef"
                    v-model="editValue"
                    class="floating-country-sidebar__stat-input"
                    type="text"
                    @keydown="handleEditKeydown($event, item, stat)"
                    @blur="commitEdit(item, stat)"
                  />
                </div>
              </dl>

              <button
                v-if="destroyable"
                class="floating-country-sidebar__destroy"
                type="button"
                :aria-label="`灭亡 ${item.name}`"
                @click="emit('destroy', item)"
              >
                灭亡此政权
              </button>
            </div>
          </transition>
        </section>
      </div>

      <div v-else-if="!isCollapsed" class="floating-country-sidebar__empty">{{ emptyText }}</div>
    </div>
  </aside>
</template>

<style scoped>
.floating-country-sidebar {
  position: fixed;
  top: 96px;
  right: 24px;
  z-index: 40;
  width: min(340px, calc(100vw - 32px));
  pointer-events: none;
}

.floating-country-sidebar__shell {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-height: 50vh;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--color-background) 92%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.16);
  overflow-x: hidden;
  overflow-y: auto;
}

.floating-country-sidebar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.floating-country-sidebar__header-copy {
  min-width: 0;
}

.floating-country-sidebar__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.floating-country-sidebar__eyebrow {
  margin: 0 0 4px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text);
  opacity: 0.7;
}

.floating-country-sidebar__title {
  margin: 0;
  font-size: 18px;
  color: var(--color-heading);
}

.floating-country-sidebar__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--color-primary-soft, rgba(0, 0, 0, 0.08));
  font-size: 13px;
  font-weight: 700;
}

.floating-country-sidebar__collapse-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 56px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
}

.floating-country-sidebar__collapse-button:hover {
  border-color: var(--country-color);
}

.floating-country-sidebar__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 4px;
}

.floating-country-sidebar__item {
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--country-color) 10%, var(--color-background));
  border-left: 6px solid var(--country-color);
  overflow: hidden;
}

.floating-country-sidebar__item.is-active {
  border-color: var(--country-color);
}

.floating-country-sidebar__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--country-color) 18%, transparent),
    transparent 65%
  );
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.floating-country-sidebar__name {
  font-weight: 700;
  line-height: 1.3;
}

.floating-country-sidebar__arrow {
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.72;
}

.floating-country-sidebar__panel {
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid color-mix(in srgb, var(--country-color) 24%, transparent);
}

.floating-country-sidebar__subtitle,
.floating-country-sidebar__summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text);
}

.floating-country-sidebar__stats {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin: 0;
}

.floating-country-sidebar__stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--country-color) 12%, var(--color-background));
}

.floating-country-sidebar__stat dt,
.floating-country-sidebar__stat dd {
  margin: 0;
  font-size: 13px;
}

.floating-country-sidebar__stat dt {
  color: var(--color-text);
  opacity: 0.75;
  flex-shrink: 0;
}

.floating-country-sidebar__stat-value {
  font-weight: 700;
  text-align: right;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  min-width: 40px;
  transition: background 0.15s ease;
}

.floating-country-sidebar__stat-value:hover,
.floating-country-sidebar__stat-value:focus-visible {
  background: color-mix(in srgb, var(--country-color) 18%, var(--color-background));
  outline: none;
}

.floating-country-sidebar__stat-input {
  font-weight: 700;
  text-align: right;
  border: 1px solid var(--country-color);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  padding: 2px 6px;
  font: inherit;
  font-size: 13px;
  width: 100%;
  min-width: 60px;
  outline: none;
  box-sizing: border-box;
}

.floating-country-sidebar__stat.is-editing {
  background: color-mix(in srgb, var(--country-color) 20%, var(--color-background));
}

.floating-country-sidebar__empty {
  padding: 16px;
  border-radius: 14px;
  border: 1px dashed var(--color-border);
  color: var(--color-text);
  opacity: 0.75;
  background: rgba(255, 255, 255, 0.28);
}

.floating-country-sidebar__destroy {
  align-self: flex-start;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, #d64545 45%, var(--color-border));
  border-radius: 999px;
  background: transparent;
  color: #d64545;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.floating-country-sidebar__destroy:hover {
  background: color-mix(in srgb, #d64545 12%, transparent);
}

.floating-country-sidebar__shell.is-collapsed .floating-country-sidebar__empty {
  display: none;
}

.floating-country-sidebar-expand-enter-active,
.floating-country-sidebar-expand-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.floating-country-sidebar-expand-enter-from,
.floating-country-sidebar-expand-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 1280px) {
  .floating-country-sidebar {
    top: auto;
    bottom: 16px;
    right: 16px;
    left: 16px;
    width: auto;
  }
}

@media (max-width: 720px) {
  .floating-country-sidebar__shell {
    padding: 12px;
  }

  .floating-country-sidebar__trigger {
    padding: 10px 12px;
  }
}
</style>
