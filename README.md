# 知序 · Knowledge Platform

pnpm monorepo 的 Wiki RAG 知识库起步项目。当前包含前端工作台、HTTP 服务、OpenTelemetry、统一 LLM 适配接口、OpenAI SDK 接入，可扩展的文档标准化接入层、按标题的 Section Split 、结构化 Knowledge Enrichment 及 Chunk Build；其余 RAG 业务能力仍为目录占位。

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
│   │   ├── errors.ts               # 服务端共用 AppError 与可选错误信息
│   │   ├── error-codes.ts          # HTTP / LLM / RAG 错误码与中文含义
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
│   │   ├── rag/                    # Wiki RAG 独立能力，Normalize / Split / Enrichment / Chunk Build 已实现
│   │   │   ├── ingestion/          # 入库链路编排
│   │   │   ├── normalization/      # 统一文档接入层与 Nextra MDX → AST 标准化
│   │   │   ├── enrichment/         # LLM 结构化知识补充及校验
│   │   │   ├── wiki/               # Wiki 化
│   │   │   │   └── nodes/          # 节点构建与关联
│   │   │   ├── chunking/           # 按标题 Section Split 与 Token 预算 Chunk Build
│   │   │   ├── embedding/          # 向量化及对应模型接入
│   │   │   ├── vector-store/       # RAG 向量存储与访问
│   │   │   ├── query/              # 问答链路编排
│   │   │   ├── retrieval/          # Top 30 检索与 Wiki 上下文
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

已提供通用文本生成接口和 OpenAI SDK 适配器。已实现可扩展的 Normalization 接口和 Nextra MDX 适配器。已实现按标题的 Section Split、结构化 Knowledge Enrichment 和 Chunk Build。尚未实现 Wiki 化、Metadata Build、Embedding、向量数据库、检索、Rerank、RAG 答案编排或持久化，也没有固定具体模型或数据库。

计划中的链路：

```text
MDX → Normalized Document → Section Split → Knowledge Enrichment
    → Chunk Build → Metadata Build → Embedding → Vector Record → Vector DB
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
API Service / RAG → LlmClient → LlmAdapter → OpenAI SDK
                                         → 其他模型 SDK（后续实现）
```

当前实现为非流式、无服务端会话状态的文本生成，支持 `system` / `user` / `assistant` 消息。每次调用传入所需的完整文本历史；不重放模型内部推理或工具调用记录。流式、多模态、工具调用、结构化输出和 Embedding 尚未接入。

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

使用示例、扩展约定和阅读顺序见 [Normalization 文档](server/src/rag/normalization/README.md)。本阶段只提供可调用的文档标准化接入层，没有 CLI 或目录导入。`Section Split`、`Knowledge Enrichment` 和 `Chunk Build` 已实现，后续按 `Metadata Build → Embedding → Vector Record → Vector DB` 逐步实现；embeddingText 拼装与 pgvector 写入尚未实现。

## 按标题切分

`splitSections(document)` 消费标准化文档，返回按原文顺序排列的 section，保留标题路径、父级、来源位置与完整 AST 块。直接调用纯函数，不需要 Adapter。使用方式和输出示例见 [Section Split 文档](server/src/rag/chunking/README.md)。

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

`KnowledgeEnricher.enrich(section)` 先规则提取 title、headingPath、metadata、codeBlocks、links，再复用 `LlmClient` 补充 summary、keywords、aliases、questions、entities、concepts、relations、facts、knowledgeType，最后校验并去重。规则结果保存在 `extracted`，语义结果保存在 `enrichment`，已移除 constraints 和模型生成的 metadata。输出为 `EnrichedSection` v2，Chunk Build 同步消费新版结果。字段定义与阅读顺序见 [Knowledge Enrichment 文档](server/src/rag/enrichment/README.md)。

## Chunk Build

`buildChunks(section, enrichedSection, options)` 按完整 Markdown 的 Token 预算构建 chunk，保留结构、标题上下文、来源片段和引用。支持 overlap、自定义 Token 计数及显式超限策略，enrichment 仍保留 section 级作用域。默认 800 Token、无 overlap；详见 [Chunk Build](server/src/rag/chunking/README.md#chunk-build)。当前不生成 embeddingText 或数据库记录。
