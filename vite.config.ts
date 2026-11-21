import { fileURLToPath, URL } from 'node:url'

import { defineConfig, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

/**
 * OpenCode Go 网关不允许浏览器跨域直连，本地开发/预览时通过 Vite 同源代理转发：
 *   /api/opencode-go/chat/completions
 *   -> https://opencode.ai/inference/go/openai/v1/chat/completions
 *
 * 生产环境需要在同域 /api/opencode-go 配置反向代理，或通过
 * VITE_OPENCODE_GO_BASE_URL 指向自己的代理地址。
 */
const openCodeGoProxy: Record<string, ProxyOptions> = {
  '/api/opencode-go': {
    target: 'https://opencode.ai',
    changeOrigin: true,
    secure: true,
    timeout: 300_000,
    proxyTimeout: 300_000,
    rewrite: (path) => path.replace(/^\/api\/opencode-go/, '/inference/go/openai/v1'),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueJsx(), vueDevTools()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: openCodeGoProxy,
  },
  preview: {
    proxy: openCodeGoProxy,
  },
})
