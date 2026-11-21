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
- 剧本编辑：配置开局时间与存在国家，支持政权代表色、政体、领导人、玩家操控标记、领土（细化到世界地图的下级行政区并按地区编号记录）、初始国家力量和国家档案导入导出，还可把当前剧本发送给 AI 审校与开局推演。
- 事件驱动：基于世界观上下文进行多轮对话生成与归档。
- 世界地图：等距圆柱投影的深色扫描地图，支持拖拽、滚轮缩放，点击国家弹出情报面板。
- 本地设置：配置模型提供商（含 OpenCode Go）、API、模型名称、提示词模板与时区。

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

- 选择模型提供商（OpenAI / DeepSeek / Qwen / Anthropic / OpenCode Go）
- 填写 API
- 选择模型
- 保存配置

> OpenCode Go 走 `https://opencode.ai/inference/go` 的 OpenAI 兼容接口，API Key 在 [OpenCode Console](https://opencode.ai/console) 创建，以 `oc_sk_` 开头。

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

4. 剧本编辑：

- 进入“剧本编辑”页面（`/pages/scenario-editor`）
- 填写剧本名称与开局时间
- 新建政权，设置代表色、政体、领导人、初始国家力量
- 在「政权设定」顶部勾选「玩家操控国家」可把该政权交给玩家：导出 JSON 时写入 `AI控制: false`；不勾选则为 AI 推演（`AI控制: true`），新建政权默认由 AI 操控
- 右上角「发送至 AI」发送的是**精简审核版**（省略空字段和地区名称，80 政权约 4 万 tokens），避免完整 JSON 超出模型上下文；回复显示在页面顶部，可复制或收起。当前接入 OpenAI / DeepSeek / OpenCode Go，API 错误会显示具体原因
- 政权列表默认按拼音排序，可切换为创建顺序；只影响列表显示，导出 JSON 仍按原数组顺序
- 领土只能在「地区」粒度添加：地图放大到 2.4 倍后会自动加载并显示下级行政区，点击单个行政区即可划入或移出，文件里记录地区编号（如 `DE-BY`、`110000`）
- 领土以「代码 + 国家代码」唯一标识；源数据里的 `N/A` 等重复编号（Abyei / Keserwan-Jbeil）不会串到同一块图
- 地图最高可放大到 200×，右下角提供 `+ / − / 重置`，小地块也能点中
- 从导入数据继承的整国编号（ISO3）领土仍会显示在列表和地图上，可单独删除，但不能再通过地图新增
- 也可以从世界生成草稿导入手绘国土
- 在国家档案页导入文章转 JSON 得到的 `CountryData`，补全国家信息
- 导出 `剧本.json`；文件结构为 `{ 剧本名称, 开局时间, 存在国家: [...] }`，每个政权包含 `代表色`、`政体`、`领导人`、`领土`、`初始国家力量` 以及完整的 `CountryData` 字段
- 仓库自带 1947 年开局示例：[`scenarios/1947-01-01-world.json`](scenarios/1947-01-01-world.json)（按 1947-01-01 现实世界建模，速览见 [`scenarios/1947-01-01-world.md`](scenarios/1947-01-01-world.md)）

5. 事件驱动：

- 从世界观页面切换到“事件驱动”
- 在已加载世界上下文下进行聊天生成
- 可将结果归档并导入/导出

6. 世界地图：

- 进入“世界地图”页面（`/pages/world-map`）
- 第一次使用建议先执行 `pnpm map:data`，生成全球国界（Natural Earth 50m）与中国区县数据
- 拖拽平移、滚轮朝光标方向缩放、悬停高亮，点击会播放过场动画并弹出情报面板
- 地图放大到约 2.4 倍后自动加载并绘制下级行政区；**同屏可见的国家会一起加载**，不再只挑前几个
- 各国家的细分粒度按“平均每块 ≈ 2.6 万 km²（中国地级市密度）”统一，并设密度上限（不比基准密 2 倍以上）：执行 `pnpm map:plan` 重新规划、
  `pnpm map:granularity` 按规划表重建（例如德国→16 州、法国→13 大区、中国→367 地级市、俄罗斯→83 联邦主体、巴西→27 州、美国→56 州）
- 数据有问题时执行 `pnpm map:audit` 体检层级、覆盖率与单元面积
- 地图数据缺失时会退回公网地址，并提示如何离线生成（见 [public/geo/README.md](public/geo/README.md)）

## 部署方式

### OpenCode Go 代理

OpenCode Go 要求请求携带 `x-opencode-session` 等自定义头，浏览器直连会因 CORS 预检被拒绝，
表现为 `NetworkError when attempting to fetch resource`。项目默认走同源路径 `/api/opencode-go`：

- `pnpm dev` / `pnpm preview`：Vite 自动把 `/api/opencode-go` 代理到
  `https://opencode.ai/inference/go/openai/v1`；
- 静态部署：需要在同域配置反向代理，例如 Nginx：

```nginx
location /api/opencode-go/ {
    proxy_pass https://opencode.ai/inference/go/openai/v1/;
    proxy_set_header Host opencode.ai;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

也可以把 `VITE_OPENCODE_GO_BASE_URL` 设为自有代理的完整地址，重新构建后再使用。

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

# 生成地图数据（全球国界 + 中国区县）到 public/geo/
pnpm map:data

# 重新规划各国该用哪一级行政区，并按规划重建（统一细化程度）
pnpm map:plan
pnpm map:granularity

# 体检：层级、覆盖率、单元面积
pnpm map:audit

# 兜底：把还没下载过的国家全部按 ADM2 抓下来（很慢，可中断重跑）
pnpm map:data:all

# 单元测试
pnpm test:unit

# E2E 测试
pnpm test:e2e

# 代码检查并自动修复
pnpm lint
```
