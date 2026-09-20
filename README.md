# 知序 · Knowledge Platform

pnpm monorepo 的 Wiki RAG 知识库起步项目。当前只包含前端工作台、可运行的 HTTP 服务与后续能力的目录占位。

## 启动

需要 Node.js 22.13+（22.x）或 24+ 与 pnpm 10（项目固定 pnpm 10.33.0）。ESLint 10 的 Node.js 要求已同步到根目录 `engines`。

```sh
pnpm install
pnpm dev
```

- 前端：http://127.0.0.1:5173
- 健康检查：http://127.0.0.1:3000/api/health
- `pnpm dev:app` / `pnpm dev:server`：单独启动前端或后端。

默认配置可以直接运行。需要自定义时，将 `app/.env.example`、`server/.env.example` 分别复制为同目录的 `.env`。后端修改端口后，同步修改前端的 `API_PROXY_TARGET`。前端开发服务器与预览服务器将 `/api` 代理到 Hono，无需额外 CORS 配置。

## 目录

```text
.
├── app/                            # React + Vite + Tailwind CSS + Zustand
│   ├── components.json             # shadcn/ui 配置
│   └── src/
│       ├── components/ui/          # shadcn/ui 基础组件
│       ├── features/
│       │   ├── workspace/          # 布局、Zustand 状态与健康检查
│       │   ├── documents/          # 文档库页面
│       │   ├── wiki/               # Wiki 节点页面
│       │   ├── ask/                # 问答页面
│       │   └── pipeline/           # 流程预览页面
│       └── utils/                  # 通用样式工具
├── server/                         # Hono + Node.js，包名 @knowledge/server
│   ├── src/
│   │   ├── index.ts                # 启动、端口监听、优雅关闭
│   │   ├── core/                   # HTTP/API 层
│   │   │   ├── app.ts              # Hono 应用组装与错误响应
│   │   │   ├── router/             # HTTP 路由，目前只有 health
│   │   │   ├── middleware/
│   │   │   │   └── tracing.ts      # 请求 span、请求日志、trace 响应头
│   │   │   ├── service/            # API 操作编排（预留）
│   │   │   └── dao/                # 应用数据访问（预留）
│   │   │       ├── documents/      # 文档持久化
│   │   │       ├── wiki-nodes/     # Wiki 节点持久化
│   │   │       └── models/         # 数据库记录模型
│   │   ├── rag/                    # Wiki RAG 独立能力，以下均为预留目录
│   │   │   ├── ingestion/          # 入库链路编排
│   │   │   ├── normalization/      # Markdown / MDX 标准化
│   │   │   ├── wiki/               # Wiki 化
│   │   │   │   └── nodes/          # 节点构建与关联
│   │   │   ├── chunking/           # 内容切分
│   │   │   ├── embedding/          # 向量化及对应模型接入
│   │   │   ├── vector-store/       # RAG 向量存储与访问
│   │   │   ├── query/              # 问答链路编排
│   │   │   ├── retrieval/          # Top 30 检索与 Wiki 上下文
│   │   │   ├── rerank/             # Top 3 重排及对应模型接入
│   │   │   └── generation/         # 基于上下文生成答案
│   │   ├── llm/                    # 通用大模型接入（预留）
│   │   └── telemetry/              # 不依赖 HTTP 的可观测性
│   │       ├── sdk.ts              # OpenTelemetry 初始化与关闭
│   │       └── logger.ts           # 带当前 trace 上下文的日志 API
│   └── test/
│       └── telemetry.test.mjs       # HTTP 与 OTLP 集成测试
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

空目录仅放 `.gitkeep`，不包含业务实现。后端按下面的职责与依赖方向扩展：

- `core/router` 负责 HTTP 路径与请求转发，在 `router/index.ts` 注册。
- `core/service` 负责 API 输入处理、业务校验、调用能力模块和组织响应。
- `core/dao` 负责文档、Wiki 节点等应用数据持久化。
- `rag` 负责入库和问答能力；Embedding、Rerank 接入各自归所属模块，向量存储也归 RAG 所有。
- `llm` 负责通用大模型调用，可被 Wiki 化、答案生成等能力复用。
- `telemetry` 负责 SDK 与通用日志，HTTP 追踪放在 `core/middleware/tracing.ts`。

```text
HTTP → core/router → core/service → core/dao
                                 → rag → llm
各模块 → telemetry
```

独立能力不依赖 HTTP 路由或中间件。原先的 `core/manager` 已合并到所属能力模块；`normalize`、`split`、`search`、`answer` 分别统一为 `normalization`、`chunking`、`retrieval`、`generation`。后续在同一模块内添加实现与模型适配，避免再次按 service/manager 拆散同一能力。

## 当前范围

- 文档库、Wiki 节点、问答及处理流程页面，支持桌面与移动布局。
- Zustand 保存页面切换、文档搜索词、问题草稿（只保存在内存中）。
- 前端每 30 秒读取健康检查，可手动刷新，显示连接、检查中、离线状态。
- `GET /api/health` 返回 `status`、`service`、`timestamp`；未知路由返回 JSON 404；错误响应带请求 ID。
- 文档与统计当前为空状态，占位数值为 0；导入与发送按钮禁用，不执行上传或模型调用。

尚未实现 Normalize、Wiki 化、Split、Embedding、向量数据库、检索、Rerank、生成回答或持久化，也没有选择具体模型或数据库。

计划中的链路：

```text
MDX → Normalize → Wiki / Wiki Node → Split → Embedding → Vector Store
问题 → Search Top 30 + Wiki Node → Rerank Top 3 → Answer
```

## 检查与构建

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm --filter @knowledge/server start
# 在另一个终端预览前端构建
pnpm --filter @knowledge/app preview
```

前端产物在 `app/dist`，后端产物在 `server/dist`。正式部署前端静态文件时，需在部署平台将 `/api` 反向代理到 Hono；Vite 的代理仅用于开发与本地预览。

## ESLint 与格式化

根目录 `eslint.config.mjs` 使用 `@antfu/eslint-config`，统一检查两个工作区的 TypeScript、React、JSON 和 YAML，忽略构建产物与锁文件。

- `pnpm lint`：检查代码，警告也会使检查失败。
- `pnpm lint:fix`：自动修复 antfu 规则及格式问题。
- `pnpm format`：先执行 ESLint 修复，再用 Prettier 格式化 CSS、HTML、Markdown。
- `pnpm format:check`：同时检查上述两部分。

JS/TS/JSON/YAML 的格式由 ESLint 管理，不再对整个仓库运行 Prettier，以免格式反复变化。React Fast Refresh 仅对 shadcn/ui 的 `buttonVariants` 导出做了定向例外。

## 服务端日志与追踪

服务启动时初始化 OpenTelemetry Node SDK，Hono 中间件手动创建请求 span。当前覆盖 HTTP 请求与应用日志，数据库和外部模型调用后续可在业务层添加子 span。

- 默认将 traces 和 logs 输出到控制台，无需启动 Collector。
- 请求日志记录方法、路径、路由模板、状态码、耗时及 request ID；日志由 SDK 自动关联当前 trace ID 和 span ID。
- 支持入站 W3C `traceparent` / `tracestate`，响应带 `X-Request-Id` 和 `X-Trace-Id`。
- 2xx/3xx 为 INFO，4xx 为 WARN，5xx 为 ERROR；服务端异常会记录到 span 与错误日志。
- 请求日志不采集请求体、请求头或 URL 查询参数；后续业务日志属性由调用方控制。
- 收到 SIGINT / SIGTERM 时，先停止 HTTP 服务，再导出剩余 traces 和 logs；关闭过程最多等待 10 秒。

后续业务代码通过 `server/src/telemetry/logger.ts` 的 `log.info`、`log.warn`、`log.error` 写入日志。在请求的异步调用链内，日志会自动关联对应请求，例如：

```ts
import { log } from './telemetry/logger.js'

log.info('document.normalized', { 'document.id': 'doc-123' })
```

启动、停止等请求外日志没有 trace ID，这是正常行为。现有 `console.log` 不会自动成为 OpenTelemetry 日志，业务代码应使用 `log`。

如已有 OTLP Collector，将 `server/.env.example` 复制为 `server/.env`，修改如下配置后重启服务：

```dotenv
OTEL_SERVICE_NAME=knowledge-server
OTEL_TRACES_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

HTTP 导出自动使用 `/v1/traces` 与 `/v1/logs`。SDK 同样支持 `http/protobuf` 或 `grpc`；使用 gRPC 时应配置对应的 Collector 端口。可通过 `OTEL_EXPORTER_OTLP_HEADERS` 设置鉴权头，或通过 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` 分别指定完整端点。

`OTEL_TRACES_EXPORTER=none` / `OTEL_LOGS_EXPORTER=none` 可分别关闭导出，`OTEL_SDK_DISABLED=true` 可关闭 SDK。若关闭 tracing，日志不再有本服务生成的 trace 关联。`OTEL_LOG_LEVEL` 仅控制 SDK 自身诊断日志，不控制应用日志。

项目未部署 Collector 或可视化后台。`pnpm test` 会临时启动本地 OTLP 接收端和独立 HTTP 服务，验证真实导出、上游 trace 传播、并发日志上下文隔离、404/500、异常记录以及退出刷新，不需要外部服务。

配置参考：[antfu ESLint](https://github.com/antfu/eslint-config)、[OpenTelemetry Node SDK](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-node.html)。

添加 shadcn/ui 组件：

```sh
cd app
pnpm dlx shadcn@latest add dialog
```

基础接入参考：[Tailwind CSS / Vite](https://tailwindcss.com/docs/installation/using-vite)、[shadcn/ui](https://ui.shadcn.com/docs/installation/manual)、[Hono / Node.js](https://hono.dev/docs/getting-started/nodejs)。
