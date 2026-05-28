# AIHistoryMonitor（中文说明）

AIHistoryMonitor 是一个基于 Vue 3 + Vite + TypeScript 的前端应用，包含文本转 JSON、世界观生成、事件驱动对话等页面。

## 目录

- [功能概览](#功能概览)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用说明](#使用说明)
- [部署方式](#部署方式)
- [常用命令](#常用命令)

## 功能概览

- 首页：项目入口页。
- 文本转 JSON：上传文档/文本，调用模型生成 JSON，并进行结构校验。
- 世界观生成：管理国家与国土数据、世界地图与颜色信息。
- 事件驱动：基于世界观上下文进行多轮对话生成与归档。
- 本地设置：配置模型提供商、API、模型名称、提示词模板与时区。

## 环境要求

- Node.js：`^20.19.0 || >=22.12.0`
- 包管理器：`pnpm`（推荐）

建议先启用 Corepack：

```bash
corepack enable
```

## 快速开始

1. 安装依赖

```bash
pnpm install
```

2. 启动开发环境

```bash
pnpm dev
```

3. 打开浏览器访问（默认）

- http://localhost:5173

## 使用说明

1. 首次使用先进入“设置”页面：

- 选择模型提供商
- 填写 API
- 选择模型
- 保存配置

2. 文本转 JSON：

- 进入“文本转 JSON”页面
- 上传或粘贴文本
- 发送生成请求
- 查看并校验 JSON 结果

3. 世界观生成：

- 进入“世界观生成”页面
- 导入/维护国家与国土数据
- 调整国家颜色与地图信息
- 保存草稿（浏览器会话存储）

4. 事件驱动：

- 从世界观页面切换到“事件驱动”
- 在已加载世界上下文下进行聊天生成
- 可将结果归档并导入/导出

## 部署方式

### 方式一：构建后本机预览

适用于验收或临时演示。

1. 执行构建

```bash
pnpm build
```

2. 本机预览

```bash
pnpm preview
```

默认会启动一个本地预览服务，使用终端输出的地址访问。

### 方式二：静态资源部署（Nginx/静态托管）

适用于生产环境或正式发布。

1. 生成静态文件

```bash
pnpm build
```

2. 将 `dist/` 目录中的产物上传到静态服务器（如 Nginx、对象存储静态网站、CDN）。

3. Nginx（SPA）示例配置：

```nginx
server {
  listen 80;
  server_name your-domain.com;

  root /var/www/aihistorymonitor/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

> 说明：本项目使用 Vue Router 的 history 模式，生产环境必须配置 `try_files ... /index.html`，否则刷新子路由会出现 404。

### 方式三：托管到静态平台

可部署到 Vercel、Netlify、GitHub Pages（或类似平台）：

- Build Command：`pnpm build`
- Output Directory：`dist`
- Node 版本建议：20+

如果使用子路径部署（例如 `/aihistorymonitor/`），请在 [vite.config.ts](vite.config.ts) 中配置 `base` 后重新构建。

## 常用命令

```bash
# 启动开发
pnpm dev

# 类型检查 + 构建
pnpm build

# 仅构建
pnpm build-only

# 单元测试
pnpm test:unit

# E2E 测试
pnpm test:e2e

# 代码检查并自动修复
pnpm lint
```
