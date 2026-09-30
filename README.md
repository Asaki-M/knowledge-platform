# 知序 · Knowledge Platform

pnpm monorepo 的 Wiki RAG 知识库起步项目。当前包含前端工作台、HTTP 服务、OpenTelemetry、统一 LLM 适配接口、OpenAI / DeepSeek 接入，可扩展的文档标准化接入层、按标题的 Section Split 、结构化 Knowledge Enrichment、跨节 Wiki 聚合、独立 Chunk Build、增量影响计算、SiliconFlow / Google Embedding 接入及 Chunk / Wiki 双索引向量生成及 pgvector 事务写入、双路检索、Rerank 与引用式问答；前端已接入操作日志、RAG 入库过程与知识问答三个页面。

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
│       │   ├── logs/               # 操作日志、筛选与详情
│       │   ├── ask/                # 问答页面
│       │   └── pipeline/           # 文档入库与处理结果
│       └── utils/                  # 通用样式工具
├── server/                         # Hono + Node.js，包名 @knowledge/server
│   ├── src/
│   │   ├── index.ts                # 启动、端口监听、优雅关闭
│   │   ├── errors.ts               # 服务端共用 AppError 与可选错误信息
│   │   ├── error-codes.ts          # HTTP / LLM / RAG 错误码与中文含义
│   │   ├── utils/                  # 跨模块通用工具，当前为基础类型守卫
│   │   │   └── type-guards.ts      # 非空白字符串、非数组对象判断
│   │   ├── core/                   # HTTP/API 层
│   │   │   ├── app.ts              # Hono 应用组装与错误响应
│   │   │   ├── router/             # HTTP 路由，目前只有 health
│   │   │   ├── middleware/
│   │   │   │   └── tracing.ts      # 请求 span、请求日志、trace 响应头
│   │   │   ├── service/            # API 操作编排（预留）
│   │   │   └── dao/                # 应用数据访问
│   │   │       ├── operation-logs.ts    # 操作日志持久化与查询
│   │   │       └── workspace-options.ts # 工作台目录与日志筛选范围读取
│   │   ├── rag/                    # Wiki RAG 独立能力，Normalize / Split / Enrichment / Wiki / Chunk Build 已实现
│   │   │   ├── ingestion/          # 增量影响计算及完整快照的双索引生成/写入
│   │   │   ├── normalization/      # 统一文档接入层与 Nextra MDX → AST 标准化
│   │   │   ├── enrichment/         # LLM 结构化知识补充及校验
│   │   │   ├── wiki/               # 跨节 Entity/Concept 聚合与增量更新
│   │   │   │   └── nodes/          # 节点构建与关联
│   │   │   ├── sections/           # H1–H3 分节、来源与内容版本
│   │   │   ├── chunking/           # 独立的 Token 预算 Chunk Build
│   │   │   ├── embedding/          # SiliconFlow / Google 文本向量化接口
│   │   │   ├── indexing/           # Chunk / Wiki 文本构造、来源版本与双索引向量生成
│   │   │   ├── vector-store/       # PostgreSQL / pgvector 事务写入、版本检查与精确检索
│   │   │   ├── query/              # 问答链路编排
│   │   │   ├── retrieval/          # 双路结果合并去重与来源保留
│   │   │   ├── rerank/             # Top 3 重排及对应模型接入
│   │   │   └── generation/         # 基于上下文生成答案
│   │   ├── llm/                    # 独立于具体 SDK 的文本生成能力
│   │   │   ├── index.ts            # 模块公共出口
│   │   │   ├── types.ts            # 统一请求、响应、Adapter 契约
│   │   │   ├── client.ts           # Adapter 注册、调用、校验与追踪
│   │   │   └── providers/         # 各厂商 SDK 实现按目录隔离
│   │   │       └── openai/
│   │   │           ├── index.ts   # 厂商模块出口
│   │   │           ├── adapter.ts # SDK 配置与调用编排
│   │   │           ├── mapping.ts # 输入输出映射
│   │   │           └── normalize-error.ts # SDK 异常转换为 AppError
│   │   └── telemetry/              # 不依赖 HTTP 的可观测性
│   │       ├── sdk.ts              # OpenTelemetry 初始化与关闭
│   │       └── logger.ts           # 带当前 trace 上下文的日志 API
│   └── test/
│       ├── chunk-build.test.mjs    # Token 预算、结构切分、重叠及来源
│       ├── wiki.test.mjs           # 语义聚合、来源、身份映射与增量更新
│       ├── embedding.test.mjs      # 两家 Embedding SDK 的本地 API 集成测试
│       ├── indexing.test.mjs       # 双索引文本、来源版本、分批及失败边界
│       ├── reports/dual-index/     # 简短文章真实调用的分步数据与报告
│       ├── enrichment.test.mjs     # 知识提取、分类扩展和输出校验
│       ├── section-split.test.mjs   # 层级切分、完整性、引用与不变性测试
│       ├── normalization.test.mjs   # MDX 转换与扩展契约测试
│       ├── llm.test.mjs             # 官方 SDK 请求映射与适配器契约测试
│       └── telemetry.test.mjs       # HTTP、LLM、Normalization 子 span 与 OTLP 集成测试
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

空目录仅放 `.gitkeep`，不包含业务实现。后端按下面的职责与依赖方向扩展：

- `core/router` 负责 HTTP 路径与请求转发，在 `router/index.ts` 注册。
- `core/service` 负责 API 输入处理、业务校验、调用能力模块和组织响应。
- `core/dao` 当前负责操作日志持久化及工作台选项读取；文档与完整 Wiki 节点持久化尚未实现，按需新增模块，不预建空目录。
- `rag` 负责入库和问答能力；Embedding、Rerank 接入各自归所属模块，向量存储也归 RAG 所有。
- `llm` 负责通用大模型调用，可被 Wiki 化、答案生成等能力复用。
- `telemetry` 负责 SDK 与通用日志，HTTP 追踪放在 `core/middleware/tracing.ts`。
- `utils` 只收纳跨模块复用且不依赖业务的工具；AST、元数据和知识处理规则保留在所属 RAG 模块。

```text
HTTP → core/router → core/service → core/dao
                                 → rag → llm
各模块 → telemetry
```

独立能力不依赖 HTTP 路由或中间件。原先的 `core/manager` 已合并到所属能力模块；`normalize`、`split`、`search`、`answer` 分别统一为 `normalization`、`chunking`、`retrieval`、`generation`。后续在同一模块内添加实现与模型适配，避免再次按 service/manager 拆散同一能力。

## 当前范围

- 桌面工作台包含知识问答、RAG 过程和操作日志三个页面，分别接入 `/api/search`、`/api/documents/ingest` 和 `/api/logs`。
- Zustand 保存页面切换、知识库 ID 和问题草稿；切换页面保留请求及结果，刷新浏览器后清空，不将正文和回答写入本地持久化存储。
- `GET /api/workspace/options` 提供现有知识库、文档、日志筛选范围和已配置模型。知识库可选择或通过 Popover 填写名称创建，新增文档使用 UUID；更新已有文档需明确选择目标。来源自动取文件名，已有知识库沿用向量模型与维度，名称仅在新建时填写，其余仅问题和正文需要手填。选项读取不会调用模型或创建数据表。
- 前端每 30 秒读取健康检查，可手动刷新，显示连接、检查中、离线状态。
- `GET /api/health` 返回 `status`、`service`、`timestamp`；未知路由返回 JSON 404；错误响应带请求 ID。
- RAG 过程页支持粘贴或读取本地 Markdown / MDX 文件为 JSON 正文，选择模型后入库，展示真实统计和标准化警告。相同知识库与文档 ID 完整更新原文档。
- 问答页支持模型选择、Ctrl / ⌘ + Enter 发送、答案复制、引用跳转和来源展开，显示双路召回及重排数量。
- 日志页通过下拉选择类型、状态、知识库、文档及快捷时间范围，支持游标分页、详情、同请求筛选和手动刷新；加载失败与空结果分别展示。
- 当前接口仅返回完整结果，前端不模拟逐阶段进度；原始文件存档、中间对象预览和 Wiki 浏览页仍未实现。

已提供通用文本生成接口和 OpenAI / DeepSeek 适配器。已实现可扩展的 Normalization 接口和 Nextra MDX 适配器。已实现 H1–H3 分节、来源版本、结构化知识提取、跨节语义聚合、独立 Chunk Build 和增量影响计算。已接入 SiliconFlow 与 Google 的文本 Embedding，推荐模型见下文。已实现 Chunk 原文加本节 Wiki 信息的 embeddingText、Wiki 节点 embeddingText 和双索引向量生成。已接入本地 PostgreSQL / pgvector，原子写入双索引向量、文本与来源元数据。已提供 `POST /api/search`：Chunk / Wiki 双路各取 Top 30，合并去重后使用 SiliconFlow Rerank 取 Top 5，交给 DeepSeek 生成带引用的答案。Wiki 页面接入、原始文档持久化、Graph Expand 与自动文档级增量入库仍待实现。

计划中的链路：

```text
MDX → Normalized Document → Section（事实来源）
Section → Chunk + 本节 Wiki 信息 → Chunk embeddingText → Embedding → Chunk 向量
Section → Knowledge Enrichment → Wiki Node → Wiki embeddingText → Embedding → Wiki 向量
双索引向量 → PostgreSQL / pgvector（事务写入）
问题 → Chunk 检索 → Section → 语义节点 → Graph Expand → Rerank / Context → Answer
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

服务启动时初始化 OpenTelemetry Node SDK，Hono 中间件手动创建请求 span。当前覆盖 HTTP 请求、应用日志、通过 `LlmClient` 发起的模型调用及通过 `NormalizationClient` 发起的文档标准化；数据库与其他业务阶段后续可添加子 span。

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

## 统一 LLM Adapter

`server/src/llm` 提供统一的文本生成协议，业务层只依赖 `LlmClient` / `LlmAdapter`，不接触 OpenAI 的请求或返回类型。

模块职责和建议阅读顺序见 [LLM 阅读指南](server/src/llm/README.md)。

```text
API Service / RAG → LlmClient → OpenAIAdapter → OpenAI SDK Responses API
                             → DeepSeekAdapter → OpenAI SDK Chat Completions API
```

当前实现为非流式、无服务端会话状态的文本生成，支持 `system` / `user` / `assistant` 消息。每次调用传入所需的完整文本历史；不重放模型内部推理或工具调用记录。通用 LLM 的流式、多模态、工具调用和结构化输出尚未接入；Embedding 由独立的 `rag/embedding` 模块提供。

在 `server/.env` 配置 `OPENAI_API_KEY`，并将 `OPENAI_MODEL` 设为账号可用的模型 ID。`OPENAI_BASE_URL` 可选，默认使用 SDK 的 OpenAI 地址；自定义地址必须支持 Responses API，仅兼容 Chat Completions 的服务不能直接使用此适配器。

例如在 `server/src` 下的业务入口中使用：

```ts
import process from 'node:process'
import { LlmClient, OpenAIAdapter } from './llm/index.js'

const llm = new LlmClient([new OpenAIAdapter()])

export async function generateAnswer(question: string) {
  const model = process.env.OPENAI_MODEL
  if (!model) {
    throw new Error('OPENAI_MODEL is required')
  }

  return llm.generate({
    provider: 'openai',
    model,
    messages: [
      { role: 'system', content: '请根据提供的知识回答问题。' },
      { role: 'user', content: question },
    ],
    maxOutputTokens: 1024,
  })
}
```

适配器仅在实例化时读取 Key；公共模块导入和 HTTP 服务启动不会创建适配器或调用模型。`model` 始终显式传入，`OPENAI_MODEL` 只是上面示例的配置来源。

DeepSeek 使用独立的 `DeepSeekAdapter`，读取 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`），通过已有 OpenAI SDK 调用 Chat Completions。显式构造参数优先于环境变量，不回退到 `OPENAI_*` 配置。

当前选择 `DEEPSEEK_MODEL=deepseek-flash` 作为成本优先的起步模型；模型与价格以 [DeepSeek 官方文档](https://api-docs.deepseek.com/quick_start/pricing/) 为准。适配器不自动读取模型、不切换思考模式，沿用上游默认行为；公共响应只保留最终回答，不返回或重放 `reasoning_content`。输出预算是否包含推理 Token 由模型决定。HTTP 入库对 DeepSeek 默认使用每节 32768 Token、180 秒单次超时且关闭 SDK 重试；OpenAI 入库仍默认 10000 Token。可通过服务端 `ENRICHMENT_MAX_OUTPUT_TOKENS` 覆盖单节预算，问答设置保持不变。

```ts
import process from 'node:process'
import { DeepSeekAdapter, LlmClient } from './llm/index.js'

export async function generateWithDeepSeek(question: string) {
  const model = process.env.DEEPSEEK_MODEL
  if (!model) {
    throw new Error('DEEPSEEK_MODEL is required')
  }
  const llm = new LlmClient([new DeepSeekAdapter()])
  return llm.generate({
    provider: 'deepseek',
    model,
    messages: [{ role: 'user', content: question }],
  })
}
```

DeepSeek 同样支持 `timeoutMs` / `maxRetries`，默认每次尝试超时 60 秒、SDK 最多重试 2 次；缺少 Key 不影响公共模块导入和 HTTP 启动。

统一输入包括 `model`、`messages`、可选 `maxOutputTokens`、`temperature` 和 `signal: AbortSignal`。不传采样参数时不向 SDK 添加默认值，具体模型是否支持这些参数由其 API 决定。

统一输出包括：

| 字段                 | 含义                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `id` / `requestId`   | 模型响应 ID / 可选的供应商请求 ID                                   |
| `provider` / `model` | 供应商与实际返回的模型                                              |
| `text`               | 生成文本                                                            |
| `finishReason`       | `stop`、`length`、`content_filter`、`refusal` 或 `unknown`          |
| `usage`              | `inputTokens`、`outputTokens`、`totalTokens`，未返回用量时为 `null` |
| `refusal`            | 可选的拒答信息，不混入生成文本                                      |

截断或过滤的结果保留部分文本并标明原因，业务层应检查 `finishReason` 后再使用。OpenAI 适配器设置 `store: false`，默认每次请求尝试超时 60 秒，SDK 最多重试 2 次；可通过构造参数 `timeoutMs` / `maxRetries` 调整。统一客户端不会额外重试。

失败统一抛出 `server/src/errors.ts` 中的 `AppError`，通过 `code` 判断具体分类；提供 `code`、`provider`、`status`、`requestId` 和 `retryable`。错误码覆盖配置/输入错误、未注册供应商、鉴权、限流、超时、取消、连接失败、上游失败及无效响应，不向业务层暴露 SDK 原始异常内容。

所有服务端错误码及逐项中文含义集中在 [server/src/error-codes.ts](server/src/error-codes.ts)：`HTTP_ERROR_CODES` 用于 HTTP 层，`LLM_ERROR_CODES` 用于模型调用。错误码类型从常量推导，调用处引用常量；新增错误码只在该文件声明。`LLM_ERROR_CODES` 也通过 LLM 公共入口导出，方便业务层判断错误。

添加其他 SDK 时，在 `llm/providers/<厂商>/` 下新增实现（例如 `providers/anthropic/`），实现 `LlmAdapter` 的 `provider` 和 `generate(request): Promise<LlmResponse>`，将 SDK 调用、输入输出映射和异常转换保留在厂商目录内。通过厂商 `index.ts` 和 LLM 公共入口导出适配器，再由 `llm.register(adapter)` 注册。调用方只需切换 `provider` / `model`。重复的供应商名称会被拒绝，避免覆盖已注册适配器。

每次统一客户端调用创建 `llm.generate` 子 span，日志记录供应商、模型、结束原因、用量、请求 ID 和耗时；不会主动记录 Key、输入消息或输出文本。`pnpm test` 使用真实 OpenAI SDK 连接本地模拟 API，验证转换、错误、超时、取消，以及 HTTP → LLM 的 trace 关联，不会访问真实模型服务或产生 API 费用。

OpenAI 接口参考：[Responses API](https://platform.openai.com/docs/api-reference/responses)。

添加 shadcn/ui 组件：

```sh
cd app
pnpm dlx shadcn@latest add dialog
```

基础接入参考：[Tailwind CSS / Vite](https://tailwindcss.com/docs/installation/using-vite)、[shadcn/ui](https://ui.shadcn.com/docs/installation/manual)、[Hono / Node.js](https://hono.dev/docs/getting-started/nodejs)。

## 文档标准化

`server/src/rag/normalization` 沿用 LLM 的 Adapter 注册模式，当前接入 `nextra-docs` 的 MDX：先解析 AST，再输出标准 Markdown / GFM AST、Markdown、纯文本、元数据和处理提示。支持图片、下载链接、Callout、嵌套字段表格等组件；不执行文档代码。

使用示例、扩展约定和阅读顺序见 [Normalization 文档](server/src/rag/normalization/README.md)。本阶段只提供可调用的文档标准化接入层，没有 CLI 或目录导入。`Section Split`、`Knowledge Enrichment` 和 `Chunk Build` 已实现，独立 Embedding SDK 和 `indexing` 双索引组合层已实现；pgvector 向量写入已实现，后续补齐原始文档持久化与完整文档级入库编排。

## 按标题切分

`rag/sections` 的 `splitSections(document)` 只按 H1–H3 分节，保留标准正文、原始源片段、documentId、sourcePath、标题层级及内容 revision。Section 是事实来源，位置移动不触发内容重建。详见 [Section 文档](server/src/rag/sections/README.md)。

## 统一业务异常

LLM、Normalization 和 Section Split 共用 [errors.ts](server/src/errors.ts) 中的 `AppError`，各模块不再定义异常子类。错误码及中文含义仍统一维护在 [error-codes.ts](server/src/error-codes.ts)。

```ts
import { NORMALIZATION_ERROR_CODES } from './error-codes.js'
import { AppError } from './errors.js'

throw new AppError(
  NORMALIZATION_ERROR_CODES.PARSE_ERROR,
  'Invalid MDX syntax',
  {
    location: { line: 3, column: 1 },
  },
)
```

调用方统一通过 `error instanceof AppError` 和 `error.code` 判断错误。可选字段包含 `provider`、`status`、`requestId`、`retryable`、`location`；未指定 `retryable` 时为 `false`。迁移后从 `server/src/errors.ts` 导入 `AppError` / `AppErrorOptions`，旧模块的异常类导出已移除。HTTP 层继续处理对外状态和信息，SDK 上游状态不自动作为 API 响应状态。

## 知识补充

`KnowledgeEnricher.enrich(section)` 先规则提取 title、headingPath、metadata、codeBlocks、links，再复用 `LlmClient` 补充 summary、keywords、aliases、questions、entities、concepts、relations、facts、knowledgeType，最后校验并去重。规则结果保存在 `extracted`，语义结果保存在 `enrichment`，已移除 constraints 和模型生成的 metadata。输出为绑定 Section revision 的 `EnrichedSection` v3，Concept 具有局部 ID 和逐字证据，关系和事实可引用实体或概念。Chunk Build 独立消费 Section。字段定义与阅读顺序见 [Knowledge Enrichment 文档](server/src/rag/enrichment/README.md)。

## Wiki 构建

`buildWiki(inputs, options)` 通过调用方显式 canonical 身份映射跨节聚合 Entity/Concept，保留每条描述、事实、关系的 Section 证据与生成来源，确定性渲染 Wiki Markdown。`updateWiki` 撤销和替换各节贡献，支持待重建状态和来源刷新。未映射同名对象保持独立，标题层级仍属于 Section。详见 [Wiki 构建](server/src/rag/wiki/README.md)。页面与数据库尚未接入。

## Chunk Build

`buildChunks(section, options?)` 独立按完整 Markdown 的 Token 预算构建检索 Chunk。结果仅关联 documentId、sectionId、sectionRevision 及同节前后片段，不携带 Wiki 或 enrichment。默认 800 Token、无 overlap；详见 [Chunk Build](server/src/rag/chunking/README.md)。Chunk Build 本身不生成 embeddingText 或数据库记录；文本和来源元数据由独立 `indexing` 层组合。

## 增量影响计算

`planSectionChanges(previous, next)` 比较前后完整 Section 快照，安排新增/修改节的 Chunk 与 enrichment 重建、删除节的贡献撤销，以及仅位置/路径变化的来源刷新。它不执行任务或持久化；完整入库和查询链路仍未实现。详见 [增量影响计算](server/src/rag/ingestion/README.md)。

## Embedding

`rag/embedding` 提供 `EmbeddingClient`、`SiliconFlowEmbeddingAdapter` 和 `GoogleEmbeddingAdapter`，统一将文本数组转换为有序向量，支持输出维度校验、取消、超时、错误转换和追踪。SiliconFlow 沿用 `EMBEDDING_*` 配置，推荐免费模型 `BAAI/bge-m3`；Google 使用 `GOOGLE_API_KEY` / `GOOGLE_EMBEDDING_MODEL`，推荐 `gemini-embedding-2`，标准接口在 Free Tier 下免费。模型每次显式传入，付费项目按平台计费层级处理。完整配置、官方价格来源与调用示例见 [Embedding 文档](server/src/rag/embedding/README.md)。文本构造与双索引向量组合已由独立 `rag/indexing` 实现，向量数据库写入已由 `rag/vector-store` 接入，已通过 `POST /api/documents/ingest` 接入单文档标准化到入库的完整流程。

## Chunk / Wiki 双索引

`rag/indexing` 的 `buildIndexDocuments({ chunks, wiki }, options?)` 构造两类输入：Chunk 保留完整 Markdown 原文，附加文档标题、章节路径和本节 Wiki 节点的名称、别名、描述；Wiki 节点使用自身描述、事实与有方向的关系名称。路径、内部 ID、版本、生成请求 ID 只保留为来源元数据，不加入向量文本。

`embedDualIndex(documents, embeddingClient, { provider, model, ... })` 在同一模型空间顺序分批，返回独立的 `chunks` / `wikiNodes` 向量数组及批次用量。默认每批 32 条，任何批次失败都不会返回半套索引。两类结果保留 Section ID/revision，可在后续检索时回查原文。

构造结果使用稳定 ID、来源版本、文本指纹；向量版本再绑定供应商、请求/实际模型与维度。pending 节保留原文索引，不复用旧 Wiki 知识。文本默认按 cl100k_base 基线检查完整 8000 Token 预算，可传目标模型的 `countTokens`；这不是 BGE 或 Google 的精确分词上限，真正模型限制仍由供应商校验。超限明确失败，不自动截断。

使用 DeepSeek 做知识提取的组合示例见 [Indexing 文档](server/src/rag/indexing/README.md)。短文真实测试的各阶段数据、实际 embeddingText、向量和内存相似度检查见 [双索引报告](server/test/reports/dual-index/report.md)。`rag/ingestion.indexAndStore` 已连接 pgvector 事务写入；已提供单文档新增 / 更新接口，按变更节复用模型结果仍待实现；问答接口见 [双路检索与回答](server/src/rag/query/README.md)。

## 本地向量数据库

本地使用 PostgreSQL 17 + pgvector 0.8.6，配置在根目录 `compose.yaml`，仅监听 `127.0.0.1:5432`，持久化到 Docker 卷 `knowledge-platform_vector-data`。在 `server/.env` 中设置 `VECTOR_DB_PASSWORD` 和对应的 `VECTOR_DATABASE_URL`（见 `.env.example`）；当前开发机已完成配置。

```sh
pnpm db:up
pnpm db:status
pnpm db:stop
```

`db:stop` 只停止服务，保留数据；需要 Docker Desktop 运行。应用启动不会自动初始化数据库或调用模型，使用 `PgVectorStore.initialize()` 显式创建扩展与表。`VECTOR_DATABASE_URL` 仅供服务端使用，不应暴露给前端。

`indexAndStore({ chunks, wiki }, embeddingClient, store, options)` 构造文本、生成向量并写入完整知识库快照；两类向量的新增、更新和旧记录删除在同一事务内完成，使用预期版本避免并发覆盖。**输入必须包含该知识库全部当前 Chunk 和 Wiki 节点，不能直接把单文档增量当成完整快照传入。** 原文、Section 和 Wiki 完整对象的独立持久化仍待实现；当前保存的是向量、embeddingText、来源引用和版本。

接口、查询示例和数据库测试见 [Vector Store 文档](server/src/rag/vector-store/README.md)。实测数据已写入 `knowledge` 数据库，知识库 ID 为 `dual-index-demo`，共 2 条 Chunk、10 条 Wiki 向量；详见 [数据库验证数据](server/test/reports/dual-index/09-database.json)。

## 双路检索与回答

`POST /api/search` 接收知识库 ID 和问题，两路分别检索 Chunk embeddingText 与 Wiki 节点向量，各取最多 30 条，按 ID / 完全相同的文本去重，使用 `BAAI/bge-reranker-v2-m3` 重排取前 5 条，再交给所选 DeepSeek / OpenAI 汇总回答。返回答案、引用来源、各阶段数量、向量分数、重排分数及模型用量。

启动数据库和服务后，可直接查询已有示例知识库：

```bash
curl http://127.0.0.1:3000/api/search \
  -H 'Content-Type: application/json' \
  -d '{"knowledgeBaseId":"dual-index-demo","question":"哪种索引用于定位概念和实体？"}'
```

Rerank 读取 `RERANK_MODEL`，凭据和地址默认复用 `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL`，也可单独设置 `RERANK_API_KEY` / `RERANK_BASE_URL`。答案模型读取 `DEEPSEEK_MODEL`。向量查询沿用知识库写入时记录的 Embedding 模型，避免配置改动造成空间不一致。具体契约与限制见 [Query 文档](server/src/rag/query/README.md)。

## 文档入库与模型选择

两个接口均支持 `llm: { provider, model? }` 和 `embedding: { provider, model?, dimensions? }`。LLM 可选 `ds` / `deepseek` / `openai`，Embedding 可选 `gemini` / `google` / `siliconflow`；不传 model 时按供应商读取服务端配置。问答不传 embedding 时自动沿用知识库向量空间，显式传入不匹配的选择会返回 409。

`POST /api/documents/ingest`：传入 `knowledgeBaseId` 和 `document: { id, content, sourcePath?, format? }`，执行 Normalize → Section → Chunk / Enrichment → Wiki → 双索引 Embedding → 入库。同库同文档 ID 重传表示更新，只替换该文档，保留其他文档。格式目前为 `nextra-mdx`，也可传普通 Markdown 内容。

```bash
curl http://127.0.0.1:3000/api/documents/ingest \
  -H 'Content-Type: application/json' \
  -d '{"knowledgeBaseId":"notes-demo","document":{"id":"atlas-intro","content":"# Atlas\n\n生产环境必须使用 HTTPS。"},"llm":{"provider":"ds"},"embedding":{"provider":"siliconflow"}}'
```

`POST /api/search` 保留原来的双路 Top 30 → 去重 → Rerank Top 5 → LLM 答案流程，可通过相同参数切换答案模型。完整参数、响应、Gemini / OpenAI 配置及错误语义见 [接口文档](server/src/core/README.md)。

## 操作日志查询

- `GET /api/logs?type=ingestion`：文档入库日志。
- `GET /api/logs?type=query`：问答日志。
- `GET /api/logs/:id`：单条详情。

支持按状态、知识库、文档、请求 ID、时间范围筛选，使用 `limit` / `cursor` 分页。记录开始和结束时间、耗时、成功 / 失败 / 取消状态、模型用量、流程数量和错误码，不保存正文、问题或答案。数据保存在现有 PostgreSQL 的 `operation_logs` 表，无需新增环境配置；历史控制台日志不自动补录。完整字段与示例见 [接口文档](server/src/core/README.md#get-apilogs操作日志列表)。
