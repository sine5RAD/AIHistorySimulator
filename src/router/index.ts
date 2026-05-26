import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/pages/index',
    },
    {
      path: '/pages/index',
      name: 'index',
      component: () => import('../pages/index/index.vue'),
    },
    {
      path: '/pages/text-to-json',
      name: 'text-to-json',
      component: () => import('../pages/text-to-json/text-to-json.vue'),
    },
    {
      path: '/pages/world-generator',
      name: 'world-generator',
      component: () => import('../pages/world-generator/world-generator.vue'),
    },
    {
      path: '/pages/event-drive',
      name: 'event-drive',
      component: () => import('../pages/event-drive/event-drive.vue'),
    },
    {
      path: '/pages/setting',
      name: 'setting',
      component: () => import('../pages/local-setting/local-setting.vue'),
    },
  ],
})

export default router
