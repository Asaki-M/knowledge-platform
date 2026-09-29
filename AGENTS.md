# 项目协作约定

本文件适用于整个仓库。执行任务前先检查相关源码与已有修改，以实际代码、`package.json` 和用户当前要求为准；结构或公共接口发生变化时，同步更新相关文档。

## 项目定位与当前范围

知序（Knowledge Platform）是基于 pnpm monorepo 的 Wiki RAG 知识库平台。

- `app/`：React、Vite、Tailwind CSS、Zustand、shadcn/ui。
- `server/`：Hono、OpenTelemetry、统一 LLM Adapter、OpenAI 官方 SDK。
- 保持工作区名称 `@knowledge/app` 与 `@knowledge/server`，不自行将 `server/` 改为 `api/`。
- 已实现基础页面、健康检查、日志追踪、非流式文本生成适配器、可扩展的文档标准化接入层、按标题的 Section Split、Knowledge Enrichment 和 Chunk Build。
- RAG 中 normalization 已实现 Nextra MDX 的 AST 标准化，sections 已实现 H1–H3 分节与来源版本，chunking 已实现独立 Chunk Build，enrichment 已实现通过 LLM 提取结构化知识，wiki 已实现显式身份映射的跨节语义聚合及增量更新，ingestion 已实现纯函数影响计算，embedding 已接入 SiliconFlow / Google 文本向量化 SDK；其余 RAG、完整文档入库及持久化目前仍是目录占位，Wiki 页面尚未接入后端节点。不要将占位页面或目录描述为已实现功能，也不要在无关任务中补写这些能力。

计划链路：

```text
MDX → Normalized Document → Section（事实来源）
Section → Chunk（检索单元）→ Metadata Build → Embedding → Vector Record → Vector DB
Section → Knowledge Enrichment → Concept / Entity → Wiki / KG
问题 → Chunk 检索 → Section → 语义节点 → Graph Expand → Rerank / Context → Generation
```

## 环境与命令

使用 pnpm，版本以根目录 `packageManager` 为准；Node.js 版本遵循根目录 `engines`，当前为 22.13+（22.x）或 24+。保持单一 `pnpm-lock.yaml`，不要生成 npm/yarn 锁文件。

| 命令                                | 用途                              |
| ----------------------------------- | --------------------------------- |
| `pnpm install`                      | 安装整个工作区依赖                |
| `pnpm dev`                          | 同时启动前后端                    |
| `pnpm dev:app` / `pnpm dev:server`  | 单独启动对应工作区                |
| `pnpm typecheck`                    | 检查两个工作区的类型              |
| `pnpm lint` / `pnpm lint:fix`       | antfu ESLint 检查 / 自动修复      |
| `pnpm format:check` / `pnpm format` | 完整格式检查 / 格式修复           |
| `pnpm test`                         | 构建服务端并执行 Node.js 集成测试 |
| `pnpm build`                        | 构建两个工作区                    |

依赖安装到所属工作区，例如 `pnpm --filter @knowledge/server add <package>`；仅共享开发工具放在根目录。

默认前端地址为 `http://127.0.0.1:5173`，服务端为 `http://127.0.0.1:3000`。开发环境通过 Vite 将 `/api` 代理到服务端，健康检查为 `GET /api/health`。

端口占用时先确认进程归属。复用合适的现有服务，或停止自己启动的残留进程；不要直接杀掉所有 Node 进程、随意更改端口或关闭 `strictPort`。临时验证结束后停止自己启动的服务，避免妨碍用户再次执行 `pnpm dev`。

## 文件放置与依赖边界

文件和目录使用 `kebab-case`，先寻找现有功能归属，再创建新目录。保持实现、类型和辅助逻辑靠近所属模块，不增加重复的 `utils`、`helpers`、`manager` 等目录。

### 前端

- `app/src/features/<feature>/`：页面、业务组件、状态和功能专属逻辑。
- `app/src/components/ui/`：可复用 shadcn/ui 基础组件。
- `app/src/utils/`：确实跨功能复用的工具。
- 使用现有 `@/` 路径别名，状态管理延续 Zustand。
- 延续现有简洁工作台样式，兼顾移动端、键盘操作与清晰的加载、失败和空状态。
- 尚未接入的功能保持明确占位，不用伪造成功、统计或回答来代替实际功能。

### 服务端

```text
server/src/
├── index.ts          # 启动、监听、优雅关闭
├── errors.ts         # 所有能力共用 AppError，不重复定义模块异常类
├── error-codes.ts    # HTTP / LLM / RAG 错误码与中文说明
├── core/
│   ├── app.ts        # Hono 应用组装与统一错误响应
│   ├── router/       # HTTP 路由
│   ├── middleware/   # HTTP 追踪及其他传输层关注点
│   ├── service/      # API 输入处理、校验、操作编排与响应组织
│   └── dao/          # 应用数据访问及持久化模型
├── rag/              # Wiki RAG 独立能力
├── llm/              # 统一模型接口与各 SDK 适配器
└── telemetry/        # 通用日志与 OpenTelemetry SDK
```

- `core` 只承载 HTTP/API 及直接支持它的业务层，不作为所有后端能力的容器。
- 路由保持轻量，在 `core/router/index.ts` 注册；不要在路由里编写数据库查询、模型调用或完整业务流程。
- API 服务协调 DAO、RAG 和 LLM；独立能力不反向依赖 HTTP 路由或中间件，DAO 不依赖服务层。
- RAG 模块沿用 `normalization`、`sections`、`enrichment`、`wiki/nodes`、`chunking`、`embedding`、`vector-store`、`retrieval`、`rerank`、`generation`；`ingestion` 当前提供增量影响计算，完整入库编排和 `query` 问答编排仍待实现。
- Embedding、Rerank 的 SDK 接入归各自能力模块，通用大模型 SDK 归 `llm`。不要重新引入通用 `core/manager` 层。
- 不为简单操作增加 controller、DTO、mapper 等额外分层。
- 服务端使用 ESM / NodeNext，TypeScript 相对导入写 `.js` 扩展名；不要套用前端的 `@/` 别名。

## LLM 扩展约定

- 公共入口为 `server/src/llm/index.ts`，业务层通过 `LlmClient` 调用模型，不直接依赖具体 SDK。
- 通用契约定义在 `types.ts`：`LlmAdapter`、`LlmRequest`、`LlmResponse` 等，不引入供应商 SDK 类型。
- 服务端错误码统一在 `server/src/error-codes.ts` 定义，并逐项标注中文含义；HTTP、LLM 与 RAG 分组引用常量，类型从常量推导。异常统一使用 `server/src/errors.ts` 中的 `AppError`，通过 `code` 区分类型，不再为各模块创建 `errors.ts` 或异常子类；可选信息通过第三个参数传入。
- 新模型 SDK 放在 `llm/providers/<厂商>/`，实现 `provider` 和 `generate(request)`，通过 `LlmClient.register()` 或构造参数注册，不在 LLM 根目录堆放各厂商文件。
- 厂商目录内按职责组织 `adapter.ts`（SDK 配置与调用）、`mapping.ts`（输入输出映射）、`normalize-error.ts`（SDK 异常转换），由厂商 `index.ts` 导出适配器。公共 LLM 契约留在 LLM 根目录，AppError 位于服务端根目录，不混入厂商类型。
- 每个适配器负责输入映射、输出归一化和 `AppError` 转换；共享校验、供应商选择和追踪留在 `LlmClient`。
- 保持模型 ID 显式传入。`OPENAI_MODEL` 是调用方可使用的配置来源，客户端不会自动读取它作为默认模型。
- OpenAI 适配器当前使用 Responses API；配置中转地址时确认它支持该协议，不假设所有兼容站点都支持。
- DeepSeek 适配器位于 `llm/providers/deepseek/`，复用 OpenAI SDK 的 Chat Completions API，读取 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`。`DEEPSEEK_MODEL` 由调用方读取并显式传入；不自动回退到 OpenAI 配置，不将推理内容混入最终回答。
- 当前契约只支持非流式文本消息；扩展流式、工具调用或多模态时，明确调整公共契约与测试，不偷偷透传 SDK 专有参数。
- 保留 `finishReason`、拒答和部分文本的语义；缺失用量使用 `null`，不要伪造为零。调用方应判断结束原因再使用结果。
- 保留取消信号、超时及可重试错误语义；不要在 SDK 已有重试之外无意叠加重试。
- 不在模块导入或 HTTP 启动时调用模型。缺少模型 Key 不应影响健康检查和基础服务启动。

## Normalization 扩展约定

- 公共入口为 `server/src/rag/normalization/index.ts`；调用方通过 `NormalizationClient` 显式选择适配器。
- `types.ts` 定义统一输入、输出与 `NormalizationAdapter`。输出标准 Markdown / GFM mdast、Markdown、纯文本、元数据、来源、originalContent、blockSources 与 warnings，不泄露具体格式的原始 AST。
- 各格式解析与标准化规则放在 `normalization/adapters/<格式>/`，通过构造参数或 `register()` 注册；不把格式分支塞入客户端。
- 当前 `nextra-mdx` 覆盖 nextra-docs 的 ZoomImage、Download、Callout、ExpandableTable 等；只读取静态 AST，禁止执行 MDX、import 或表达式。不能提取的内容要留 warning，不静默丢弃。
- 内容加载由调用方负责，适配器不绑定用户目录或 HTTP。用户明确要求没有 CLI，按既定流程一步一步实现；当前已完成 Normalized Document、Section Split、Knowledge Enrichment、Chunk Build 及独立 Embedding SDK 接入，不提前实现 embeddingText 或 pgvector 写入。
- 错误码继续统一在 `src/error-codes.ts`；追踪由客户端负责，日志不记录来源路径和文档正文。
- 语义转换修改需覆盖代码、表格、链接、组件、动态表达式、错误与扩展契约，不能只检查是否成功解析。

## Section Split 约定

- `rag/sections/index.ts` 导出 `splitSections(document)` 同步纯函数，不需要适配层。
- 只按标准 AST 顶层 H1–H3 切分，H4–H6 保留在正文，保留前言、标题层级、原文位置与完整块；父节正文不重复包含子节内容。
- 输出 `DocumentSection[]`，用 `parentId`、`headingPath` 表达层级；补齐独立使用所需的跨节链接与脚注定义。
- Section 显式保留 documentId、sourcePath、原始源片段和 revision；ID 来自标题路径及同父级重名序号，改名/换父级按删除加新增处理。位置和路径不参与内容 revision。
- `rag/markdown.ts` 维护 Normalization 和 Split 共用的标准 AST 投影，后续阶段不依赖具体适配器的内部文件。
- 当前不做 Token 长度切分或 overlap，不构建 embeddingText，不调用 LLM 或数据库；对应逻辑在后续阶段按需实现。

## Chunk Build 约定

- `rag/chunking/index.ts` 导出 `buildChunks(section, options?)` 同步纯函数，不新增适配层或 CLI。
- 预算计算完整 Markdown（含标题、引用定义、代码围栏和重复表头），默认 cl100k_base；可传入目标模型的 `countTokens`。
- 按 AST 拆段落、代码行、表格数据行与列表项；保留超长原子内容并显式标记，严格策略下报错，不能静默丢弃。
- 通过 parts 记录原块、片段范围和 overlap，拆分片段不伪造源文档精确行列。
- ChunkBuildResult 使用 schemaVersion 3；Chunk 仅关联 documentId、sectionId、sectionRevision 及同节前后片段，不依赖 Wiki/enrichment，不提前拼接 embeddingText 或数据库字段。

## Knowledge Enrichment 约定

- `rag/enrichment/index.ts` 导出 `KnowledgeEnricher`，单节调用已有 `LlmClient`，不再增加模型或文档适配层。
- 按规则提取 → LLM 补充 → 校验去重 → 复查执行。`extractSectionData` 从 AST / Split 元数据提取 title、headingPath、metadata、codeBlocks、links；模型只输出语义字段。
- `EnrichedSection` 使用 schemaVersion 3，绑定 documentId、sectionId、sectionRevision，保留 extracted 和生成元数据；语义结果在 enrichment 中。Concept 为带局部 ID、别名、描述和证据的结构，主题归入 Concept。metadata 只取原文 frontmatter。
- `knowledgeType` 使用内置字典加调用方扩展，运行时只接受配置过的分类，不让模型自由增加类型。
- 实体、概念、关系、事实保留逐字原文证据；关系端点和事实 nodeIds 可引用本节实体或概念。证据存在不等于语义蕴含，不能宣称自动事实核验。
- 去重在校验之后进行，实体合并需重映射关系与事实的引用，再复查证据数量等边界。不用模糊匹配合并不同含义的实体。
- 字段缺失、无效 JSON、拒答、截断、超长输入均明确失败，不自动修复、补事实或叠加重试。错误继续共用 AppError 与统一错误码。
- 不在本阶段构建 Wiki/KG 实体全局 ID、chunk、embeddingText 或数据库写入；常规验证使用本地模拟模型。

## Wiki 构建与增量更新约定

- `rag/wiki/index.ts` 导出 `buildWiki(inputs, options)`、`updateWiki(previous, update, options)` 和 `getWikiNodesForSection`，与 Chunk 分支独立。
- Wiki 节点为 entity/concept，通过显式知识库命名空间、canonical 定义及绑定 Section revision 的映射跨节聚合；未映射项保持独立，不按同名/别名自动归并。
- WikiBuildResult 使用 schemaVersion 2，保留节点、语义关系边、Section 关联、各节贡献和 pending 状态。标题父子关系只属于 Section。
- 描述、事实和关系逐项保留 Section ID/revision、证据与生成来源。Markdown 确定性汇编并转义模型文本，不额外调用模型写文章、不向所有节点复制整节摘要。
- 增量更新先撤销旧节贡献再加入新结果；共享节点保留其他节来源，无剩余贡献的节点和边删除。待提取节显式标记 pending，不能沿用旧知识。
- `rag/ingestion` 的 `planSectionChanges` 比较相同范围的前后完整 Section 快照，输出内容重建、来源刷新与失效范围。完整入库编排尚未实现。
- 直接替换旧契约，不保留兼容入口或旧 schema 转换。核心模块验证使用内存 stub 的单测，不启动服务连调。
- 不提前实现 Wiki 页面/数据库接入、自动实体消歧、embeddingText、向量写入或完整入库编排。错误继续共用 AppError 与统一错误码。

## Embedding 约定

- 公共入口为 `rag/embedding/index.ts`，通过 `EmbeddingClient.embed()` 显式传入 provider、model 和文本数组；每条文本对应一个向量。
- SDK 位于 `embedding/providers/siliconflow` 和 `embedding/providers/google`，通用类型不引入 SDK 类型，也不反向依赖 `llm` 或 HTTP。
- SiliconFlow 沿用 `EMBEDDING_*` 配置；Google 使用 `GOOGLE_API_KEY` / `GOOGLE_EMBEDDING_MODEL`。模型环境变量由调用方读取，客户端不自动选择模型。
- 保留批量顺序、用量缺失、维度约束、取消和超时语义；拒绝缺失/重复索引与非法向量，不静默丢文本、截断或自动重试。
- Google Embedding 2 每条文本包装为独立 Content，避免字符串列表被合并为单个向量。当前只接收准备好的文本，不拼接检索指令或 embeddingText。
- 错误继续共用 AppError 与 EMBEDDING_ERROR_CODES；追踪由客户端负责，日志不记录文本或向量。
- 常规验证用真实 SDK 对本地模拟服务；不在导入模块或启动 HTTP 时调用模型。Metadata Build、Vector Record、向量写入和入库编排仍未实现。

## 日志与配置

- 使用 `server/src/telemetry/logger.ts` 的 `log.info`、`log.warn`、`log.error` 写业务日志，保持 trace 上下文关联。
- SDK 在加载 HTTP 应用前初始化；关闭服务时保留 telemetry 刷新流程。
- 模型调用的通用 span 由 `LlmClient` 创建，避免重复创建同一层的调用 span。
- 日志记录状态、耗时、请求 ID、供应商、模型和用量；不要记录 API Key、鉴权头、完整提示词、文档正文或模型输出。
- `.env` 是本地私有配置，已被 Git 忽略。不要整体打印、提交、覆盖已有 `.env`，也不要把其中的 Key 复制到源码、文档、测试或回复中。
- 新配置项补充到所属工作区的 `.env.example`，仅写空值或安全示例。不要给前端暴露模型 Key 或放入 `VITE_*` 变量。
- 真实调用只使用用户指定的服务地址和凭据；常规测试使用本地模拟服务。

## 风格与验证

- 遵循 `eslint.config.mjs` 的 antfu 配置，保持 TypeScript 严格检查，不用宽泛的规则禁用或 `any` 掩盖问题。
- JS、TS、JSON、YAML 的格式由 ESLint 管理；Prettier 仅负责 CSS、HTML、Markdown。不要对整个仓库直接执行 `prettier --write .`。
- Markdown 内的代码也会被 ESLint 检查。示例应同时满足格式规则；必要时用大括号避免 ESLint 与 Prettier 反复改写单行条件。
- 现有服务端测试位于 `server/test/*.test.mjs`，使用 `node:test`，针对构建后的模块运行；`pnpm test` 会先构建服务端。
- SDK 适配改动应覆盖真实 SDK 对本地模拟 API 的请求、响应和错误转换；追踪改动应覆盖上下文关联及导出。测试不依赖真实 Key 或外部 Collector。
- 根据改动范围执行检查：文档改动检查对应文档；服务端逻辑改动执行类型检查及相关测试；前端逻辑或界面改动执行对应构建，并验证受影响的交互。无需为低风险文档修改重跑全部测试。
- 不修改生成的 `dist/`、`node_modules/` 或无关文件来修复源码问题。目录迁移时同步引用、测试、文档，并处理旧构建产物。
- 完成后简要说明变更、实际运行的验证和仍未实现的部分。保留用户已有修改，不为完成当前任务回退无关工作。

## 开发

- 代码需要用中文补充一下关键逻辑注释
