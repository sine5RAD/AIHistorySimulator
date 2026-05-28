<script setup lang="ts">
import { RouterLink } from 'vue-router'

defineOptions({
  name: 'IndexTutorialPage',
})
</script>

<template>
  <main class="page-shell">
    <header class="hero">
      <h1>AIHistoryMonitor 使用教程</h1>
      <p>
        本教程覆盖全部路由页面，按推荐顺序操作即可完成从模型配置、文本结构化到世界观与事件推演的完整流程。
      </p>
    </header>

    <section class="panel">
      <h2>推荐使用顺序</h2>
      <ol>
        <li><strong>首页（/pages/index）</strong>：阅读本教程，确认操作流程。</li>
        <li><strong>设置（/pages/setting）</strong>：先配置提供商、API、模型与提示词。</li>
        <li>
          <strong>文本转 JSON（/pages/text-to-json）</strong>：将原始文本转换为结构化国家数据。
        </li>
        <li>
          <strong>世界观生成（/pages/world-generator）</strong
          >：导入/编辑国家与国土、地图和颜色信息。
        </li>
        <li>
          <strong>事件驱动（/pages/event-drive）</strong>：基于世界上下文进行事件推演与对话归档。
        </li>
      </ol>
    </section>

    <section class="panel">
      <h2>每个路由的使用方法</h2>

      <article class="route-card">
        <h3>1. 首页 /pages/index</h3>
        <p>用途：作为流程入口，查看全局步骤，避免跳步导致上下文不完整</p>
      </article>

      <article class="route-card">
        <h3>2. 设置 /pages/setting</h3>
        <p>用途：统一管理模型调用配置与提示词模板</p>
        <p>怎么用：</p>
        <ul>
          <li>选择模型提供商</li>
          <li>填写 API</li>
          <li>选择模型并保存</li>
          <li>按需编辑“文章转 JSON”与“事件驱动”提示词后保存</li>
          <li>设置时区，虽然没什么用但是你可以在右上角看时间</li>
        </ul>
      </article>

      <article class="route-card">
        <h3>3. 文本转 JSON /pages/text-to-json</h3>
        <p>用途：把自然语言文本转换为结构化 JSON 数据</p>
        <p>怎么用：</p>
        <ul>
          <li>导入文本文件或粘贴内容</li>
          <li>在下方的卡片中确认提示词后提交模型生成</li>
          <li>检查结果并执行 JSON 校验</li>
          <li>导出/复制结构化结果，供后续世界观页面使用</li>
        </ul>
      </article>

      <article class="route-card">
        <h3>4. 世界观生成 /pages/world-generator</h3>
        <p>用途：维护国家、国土与世界地图数据，形成可用于推演的世界状态</p>
        <p>怎么用：</p>
        <ul>
          <li>从text-to-json页面发送或导入第 3 步得到的国家 JSON</li>
          <li>导入墨卡托投影的世界地图图片</li>
          <li>检查并补全国家信息</li>
          <li>在星球模型上划分地盘</li>
          <li>调整国家颜色，确认视觉区分</li>
          <li>可选：导出世界数据以备下次使用</li>
          <li>确认token大小（一定要，我一不小心花了200万未缓存命中的token）</li>
          <li>把世界数据传递到事件驱动页面</li>
        </ul>
      </article>

      <article class="route-card">
        <h3>5. 事件驱动 /pages/event-drive</h3>
        <p>用途：在世界上下文中进行连续事件生成和多轮对话</p>
        <p>怎么用：</p>
        <ul>
          <li>确认当前世界包已加载。你可以向模型发送“你好”以确认</li>
          <li>按照右侧的提示卡片干你想干的事情</li>
          <li>存档：导出聊天记录的json文件</li>
        </ul>
      </article>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  max-width: 1040px;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero {
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 18px;
  background: color-mix(in oklab, var(--color-background) 92%, var(--color-text) 8%);
}

.hero h1 {
  margin: 0 0 10px;
}

.hero p {
  margin: 0;
  line-height: 1.7;
}

.quick-nav,
.panel {
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 18px;
  background: var(--color-background);
}

.quick-nav h2,
.panel h2 {
  margin: 0 0 10px;
}

.panel ol,
.panel ul {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}

.link-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.nav-link {
  display: inline-block;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  text-decoration: none;
}

.nav-link:hover {
  border-color: var(--color-border-hover);
}

.route-card {
  border-top: 1px dashed var(--color-border);
  padding-top: 12px;
  margin-top: 12px;
}

.route-card:first-of-type {
  border-top: none;
  padding-top: 0;
  margin-top: 0;
}

.route-card h3 {
  margin: 0 0 8px;
}

.route-card p {
  margin: 0 0 8px;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .page-shell {
    padding: 16px;
  }

  .quick-nav,
  .panel,
  .hero {
    padding: 14px;
  }
}
</style>
