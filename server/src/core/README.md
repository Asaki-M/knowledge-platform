# 文档入库与问答接口

服务默认地址 `http://127.0.0.1:3000`，请求与响应使用 JSON。模型密钥和服务地址只读服务端 `.env`，客户端仅选择供应商、模型和可选向量维度。导入和问答在单次请求内处理，大文档需要等待多次模型调用完成；入库可订阅实时阶段事件。

## 统一模型选择

| 参数                   | 支持值 / 行为                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `llm.provider`         | `deepseek`（也接受 `ds`）或 `openai`                                                                                        |
| `llm.model`            | 可选；DeepSeek 默认读取 `DEEPSEEK_MODEL`，未配置时使用 `deepseek-flash`；OpenAI 默认读取 `OPENAI_MODEL`，未配置必须显式传入 |
| `embedding.provider`   | `gemini`（也接受 `google`）或 `siliconflow`；响应使用内部标识 `google` / `siliconflow`                                      |
| `embedding.model`      | 入库未传时读取 `GOOGLE_EMBEDDING_MODEL` 或 `EMBEDDING_MODEL`；问答未传时沿用知识库模型                                      |
| `embedding.dimensions` | 可选正整数，供应商和模型必须支持；Gemini、SiliconFlow Qwen3 可传，BGE 入库不传                                              |

HTTP 入库单节生成预算默认 DeepSeek 32768 / OpenAI 10000 Token，可通过服务端 `ENRICHMENT_MAX_OUTPUT_TOKENS` 覆盖为模型支持的正整数；空值沿用默认。DeepSeek 保持默认思考模式，预算需要容纳推理及最终 JSON。入库 DeepSeek 单次超时为 180 秒，关闭 SDK 自动重试；问答预算与适配器默认行为不变。

省略整个 `llm` 时使用 DeepSeek；入库省略整个 `embedding` 时使用 SiliconFlow。问答省略整个 `embedding` 时自动沿用入库的供应商、模型和维度。Gemini 和支持自定义维度的 Qwen3 在更新文档或问答时可继承库内维度。

同一知识库只能使用同一个 Embedding 向量空间。入库或问答显式选择不匹配的供应商、模型或维度时返回 409；更换 Embedding 模型应使用新的知识库，或由完整快照流程重建全库。LLM 可按请求切换，不影响向量空间。

OpenAI 继续使用现有 **Responses API** 适配器，`OPENAI_BASE_URL` 必须支持该协议。DeepSeek 问答使用 Chat Completions，知识提取使用 Responses JSON Schema；入库地址和模型必须支持该协议，不自动降级或重试。Rerank 保持 SiliconFlow，与所选 LLM / Embedding 无关：使用 `RERANK_MODEL`，凭据 / 地址优先 `RERANK_*`，未设置时复用 `EMBEDDING_*`。选择 Gemini 后，问答仍需配置 SiliconFlow Rerank。

## POST /api/documents/ingest

```json
{
  "knowledgeBaseId": "notes-demo",
  "document": {
    "id": "atlas-intro",
    "format": "nextra-mdx",
    "sourcePath": "atlas-intro.mdx",
    "content": "# Atlas\n\n生产环境必须使用 HTTPS。"
  },
  "llm": { "provider": "ds" },
  "embedding": { "provider": "siliconflow" }
}
```

- `knowledgeBaseId`、`document.id` 为稳定标识，均最多 256 字符。同库同文档 ID 表示更新，不同文档 ID 表示新增。
- `document.content` 直接传正文，最多 200000 字符；请求体最多 1 MiB。`format` 可省略，目前仅支持 `nextra-mdx`，普通 Markdown 内容也可由该适配器处理；不支持 PDF / Word 或 multipart 文件上传。
- `sourcePath` 可省略，仅保存来源标记，最多 2048 字符，不读取服务器文件或远程 URL。
- 执行 Normalize → Section Split → Chunk Build → LLM Knowledge Enrichment → Wiki → 双索引 embeddingText → Embedding → pgvector。每篇最多 100 个章节，各阶段仍执行既有文本与 Token 预算校验。
- 第一笔入库会幂等初始化表结构。所有模型调用完成后，单个数据库事务替换该文档的双索引，删除该文档失效的旧记录，保留其他文档。失败不提交部分索引；并发快照冲突返回 409，不自动重跑模型。
- 当前节点按文档 / 章节的独立身份构建，不做自动同名合并。若更新目标涉及已有跨文档共享 Wiki 节点，返回 409，需使用完整 Wiki / 知识库重建流程。

成功返回 `status: stored`，包含：

- `ingestionId`、`knowledgeBaseId`、`documentId`。
- `normalization`：标题、标准化警告、纯文本字符数。
- `counts`：本次文档的 Section、Chunk、Wiki 节点 / 边、向量数量。
- `enrichment`：逐节 LLM 供应商、实际模型、请求 ID 和用量。
- `embedding`：供应商、请求 / 实际模型、维度和用量。
- `stored`：写入后的**整个知识库**版本、向量空间及 Chunk / Wiki 数量。

### 实时阶段与产物预览

同一 `POST /api/documents/ingest` 请求增加 `Accept: application/x-ndjson`，响应变为逐行 JSON 事件（`Content-Type: application/x-ndjson`）。请求正文不变，默认仍返回上述完整 JSON 摘要。前端 RAG 过程页使用此模式。

- `start`：包含 `requestId` 和有效任务的 `ingestionId`。
- `stage`：包含 `stage: { id, status, durationMs, reused?, progress?, preview? }`。`id` 依次为 `normalize`、`sections`、`chunks`、`enrichment`、`wiki`、`indexing`、`embedding`、`storage`；`status` 为 `running` / `completed` / `failed`。知识提取的 `progress` 为 `{ completed, total }`，单位是章节。
- `preview`：`metrics` 是 `{ label, value }[]`，`items` 是 `{ id, title, text, truncated }[]`，`totalItems` 为实际产物数量。每阶段最多预览前 20 项，每项最多 6000 字符，不返回 AST 或向量数组。预览截取不影响实际入库。
- `result`：包含 `result`，与普通 JSON 入库的最终响应一致；仅事务提交成功后发送。
- `error`：包含共用的 `error: { code, message }` 和 `requestId`。流开启后的业务错误通过此事件报告，HTTP 状态已为 200，客户端必须检查事件；JSON 解析失败或请求体超限仍返回普通 HTTP 错误。
- `ping`：每 15 秒保活，客户端忽略。

客户端逐行解码，流结束但未收到 `result` 或 `error` 时显示“入库状态未确认”，可按任务 ID 查询状态，不能推断失败或自动重试。连接断开会取消尚未完成的处理；事务已提交时仍可能收不到最终结果。日志在实际处理结束后记最终业务状态，不因流响应头返回而提前标记成功。阶段预览和完整产物保存为任务检查点，刷新可恢复最近任务；不写入操作日志。

双索引保存向量、embeddingText、来源和版本；任务检查点另行保存正文和完整阶段对象。原始上传文件不存档，尚无通用文档/Wiki 浏览接口。新任务/修改文档仍需完整正文，不做跨任务变更节复用。

## POST /api/search

```json
{
  "knowledgeBaseId": "notes-demo",
  "question": "生产环境需要使用什么协议？",
  "llm": { "provider": "openai" },
  "embedding": { "provider": "siliconflow" }
}
```

上述示例需要配置 `OPENAI_MODEL`。使用 Gemini 建库时，将两个接口的 `embedding.provider` 都设为 `gemini`；问答也可以直接省略 `embedding`。`llm` 同样可以改为 `ds`。

问题最多 4000 字符，请求体最多 32 KiB。链路保持：问题向量化一次 → Chunk Top 30 + Wiki Top 30 → 合并去重 → Rerank Top 5 → 所选 LLM 生成带来源引用的答案。返回 `answer`、`sources`、阶段 `counts`、快照版本及模型用量；空库返回 `status: no_results`，不调用模型。详细规则见 [Query](../rag/query/README.md)。

## 错误与验证

400：参数或 MDX 语法无效、文档 / 上下文超限；413：请求体过大；409：向量空间不匹配、快照冲突或跨文档共享节点；503：模型 / 数据库配置缺失；502：模型或数据库操作失败。错误响应包含 `error.code`、可控文案及 `requestId`，不返回凭据或上游原始错误正文。

`server/test/document-api.test.mjs` 使用真实 SDK 和本地模拟上游验证四种 LLM / Embedding 组合，从实际 HTTP 路由走完整入库和问答。`vector-store.test.mjs` 的显式数据库测试验证单文档保留邻居数据、过期记录清理、重复写入、向量空间检查、共享节点保护和回滚；测试使用独立临时数据库。

知识提取结构、引用或证据校验失败时返回 `ENRICHMENT_INVALID_OUTPUT`。新的错误消息显示失败章节、白名单字段位置和固定原因，例如缺少字段、非法 JSON、节点引用未定义、证据未在本节 Markdown 中逐字匹配；同一文案也保存在操作日志和失败阶段面板。不会传输被拒绝的模型值、证据文本或原始解析异常，也不会自动修复结果或重试模型。历史日志不反推失败字段。

知识提取输出达到生成长度限制时返回 `ENRICHMENT_OUTPUT_TRUNCATED`，内容过滤返回 `ENRICHMENT_CONTENT_FILTERED`，未知结束原因返回 `ENRICHMENT_INCOMPLETE_RESPONSE`；HTTP 和操作日志均显示对应原因，本次文档不会提交部分索引，也不会自动重试模型。历史日志保持原始记录，不反推旧 `ENRICHMENT_INCOMPLETE_RESPONSE` 的原因。

## GET /api/logs：操作日志列表

查询文档入库和问答的持久化操作记录：

```bash
# 文档入库日志
curl 'http://127.0.0.1:3000/api/logs?type=ingestion&limit=20'

# 指定知识库内失败的问答日志
curl 'http://127.0.0.1:3000/api/logs?type=query&status=failed&knowledgeBaseId=notes-demo'

# 指定文档的入库日志
curl 'http://127.0.0.1:3000/api/logs?type=ingestion&documentId=atlas-intro'
```

| 参数              | 含义                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `type`            | `ingestion`（文档入库）或 `query`（查询问答）；省略时返回两类          |
| `status`          | `running` / `succeeded` / `failed` / `cancelled`                       |
| `knowledgeBaseId` | 精确匹配知识库 ID                                                      |
| `documentId`      | 精确匹配文档 ID，适用于入库日志                                        |
| `requestId`       | 匹配原接口响应的 `X-Request-Id`；也对应错误响应里的 requestId          |
| `from` / `to`     | 按开始时间筛选，左闭右开；带时区的 ISO 时间，如 `2026-09-30T00:00:00Z` |
| `limit`           | 每页条数，默认 20，范围 1–100                                          |
| `cursor`          | 上页返回的 `nextCursor`，作为字符串原样传入                            |

返回 `{ "items": [...], "nextCursor": "123" }`，没有后续记录时 `nextCursor` 为 `null`。按日志数字 ID 倒序排列，分页过程中新增记录不会挤动已有页面；下一页应保留原来的筛选条件。状态变化可能改变匹配集合，分页不代表冻结的历史快照。

每条记录包括：

- `id`（字符串）、`type`、`status`、`knowledgeBaseId`、`documentId`。
- `requestId`、`traceId`（启用有效追踪时存在，否则为 null）。
- `startedAt`、`finishedAt`（UTC）、`durationMs`、`httpStatus`；运行中结束字段为 null。
- `summary.resultStatus`：例如 `stored`、`answered`、`no_results`。
- `summary.counts`：入库的章节 / Chunk / Wiki / 向量数量，或问答的两路召回 / 去重 / 入选数量。
- `summary.models`：成功请求的实际模型、维度和用量；入库 LLM 按章节保留用量条目；未报告的用量保持 null。失败请求尽可能保留已解析的模型选择，不伪造未完成阶段的数量或用量。
- `summary.normalization`：入库标准化后的字符数、警告数量；`summary.snapshotRevision` 关联本次知识库版本。
- `error`：失败 / 取消时的统一错误码、固定说明和是否可重试；成功时为 null，不包含原始异常内容。

文档正文、来源路径、问题原文、答案、模型输出、提示词、向量、API Key 和鉴权头不写入操作日志。标准化警告仅记录数量，不复制可能包含原文的 warning 文本。

## GET /api/logs/:id：操作日志详情

```bash
curl 'http://127.0.0.1:3000/api/logs/123'
```

返回与列表相同结构的单条记录；记录不存在返回 404，ID 或筛选参数无效返回 400。日志库不可用时明确返回错误，不将查询失败伪装为空列表。

日志保存在现有 PostgreSQL 的 `operation_logs` 表，复用 `VECTOR_DATABASE_URL`，无需新增配置。首次相关操作或日志查询时幂等建表；导入模块、启动服务和健康检查不连接日志库。

从此版本开始，实际 `POST /api/documents/ingest` 与 `POST /api/search` 请求会先写 running，结束后更新状态；JSON 解析失败和请求体过大也会记录，但无法解析的知识库 / 文档 ID 为 null。日志查询、健康检查和其他路由不生成这两类业务记录。此前的控制台 / OTLP 日志不会自动补录。

操作日志采用尽力写入：日志数据库故障会输出 `operation-log.persistence.failed` 遥测事件，不改变原业务响应、不重试模型。写入失败可能缺少记录；进程退出或最终状态更新失败可能留下 running，不能据此断言任务仍在执行。当前未提供自动修复运行状态或日志清理；前端操作日志页已接入查询、筛选、分页与详情。

验证：`server/test/operation-logs.test.mjs` 覆盖筛选、脱敏、HTTP 状态记录、故障隔离及真实 PostgreSQL 持久化和分页；真实数据库测试仍通过 `VECTOR_STORE_TEST_DATABASE_URL` 显式启用，创建独立临时库。`document-api.test.mjs` 验证四种模型组合成功入库和回答后生成对应摘要。

## 工作台选项

`GET /api/workspace/options` 为前端下拉选择提供真实选项：

- `models.llm` / `models.embedding`：`{ provider, model }[]`，仅返回配置了凭据和有效模型名的供应商。模型可用性仍以实际调用结果为准，不返回 Key 或 Base URL，也不调用模型探测。DeepSeek 未指定模型时沿用 `deepseek-flash`。
- `knowledgeBases`：`{ id, embedding: { provider, model, dimensions }, documents: [{ id, label }] }[]`。从现有向量快照与来源引用读取；`model` 是原入库请求的模型 ID，文档标签优先使用来源文件名/路径。列表用于选择更新目标，不提供原文回查。
- `logScopes`：历史操作记录中的 `{ knowledgeBaseId, documentId }[]`，包含失败操作的范围，避免把未成功入库的文档误当成可更新文档。

API 只读现有表，不初始化数据库、不读取正文或向量。首次没有表返回空目录，数据库配置或读取失败分别返回 `WORKSPACE_CONFIGURATION_ERROR` / `WORKSPACE_DATABASE_ERROR`，不冒充空库。目录查询归 `core/dao/workspace-options.ts`，配置白名单和实际请求的默认模型统一归 `core/service/model-options.ts`，`core/service/workspace-options.ts` 只组合目录与模型选项。

前端通过 Popover 填写知识库名称（1–64 字符、去首尾空格、拒绝同名），名称沿用为知识库字符串标识；新文档生成 UUID，首次入库成功才持久化；同名文件默认新增，更新需从已有文档列表显式选择。已有知识库锁定原 Embedding 模型，维度由入库编排沿用；新库使用模型默认维度。失败保留正文与文档标识，成功后清空编辑器并重新读取目录。日志使用快捷时间范围，在详情中可一键按 requestId 筛选。

`server/test/workspace-options.test.mjs` 使用本地数据库 stub 验证配置白名单、首次空库、现有目录、历史失败范围及读取错误，不调用真实模型。

## 入库中断与恢复

初次 `POST /api/documents/ingest` 可携带客户端生成的 UUID `ingestionId`，未传时服务端生成。继续同一任务只传 `{ "ingestionId": "a86ac373-1726-4afc-9efc-3f6f7d91255d" }`，可继续使用 NDJSON；沿用已保存的原文与配置。字段变化或任务仍运行返回 409，任务不存在返回 404。重试已成功任务直接返回原结果。

`GET /api/documents/ingestions/:id` 返回 ingestionId、status（running / interrupted / failed / succeeded）、knowledgeBaseId、documentId、requestId、stages、可控 error 和已提交 result，不返回原始请求、AST 或向量。`POST /api/documents/ingestions/:id/interrupt` 请求取消，返回 `status: interrupt-requested`；前端同时关闭自己的进度流。接受取消不代表事务尚未提交，应检查最终状态。

正文、配置、完整阶段结果、已通过校验的逐节知识和成功向量批次保存在 PostgreSQL，与日志分表。浏览器 sessionStorage 仅保存最近任务 ID，刷新后查询服务端恢复，不保存正文。命中的完成阶段带 `reused: true`。会话锁阻止同任务并发执行，进程退出释放锁，遗留 running 查询为 interrupted；不自动恢复或清理。新任务不跨文档/配置复用。

向量提交和 writeKey 回执同事务完成，提交后断线或任务状态保存失败可恢复原结果；其他任务修改快照仍拒绝覆盖，不放宽 expectedRevision。检查点写入失败停止处理，不盲目重试。正在进行但尚未保存的调用可能已经消耗额度，取消不能追回。模型验证全部使用本地 stub；真实数据库验证只在独立临时库进行。

## 内部公共机制

PostgreSQL 的连接串校验、连接池错误监听、参数化查询和事务收尾共用 `server/src/utils/postgres.ts`；各 DAO 与向量库仍决定凭据来源、连接数量、超时、SQL 和领域错误码。事务复用同一连接，回滚失败时丢弃连接；任务会话锁继续由入库 DAO 单独持有。API 结束时尝试关闭全部数据库资源，关闭失败仅记录脱敏遥测，不覆盖原业务错误或已提交结果。初始化仍由各操作显式触发，启动与健康检查不连接数据库。

HTTP 错误响应与操作日志共用 `core/error-presentation.ts` 中的分类和安全文案，按错误码常量字段分类。HTTP 保留状态码与操作提示，日志仅保存固定摘要；知识校验位置仍使用字段与规则白名单。模型、向量化、标准化和重排调用共用 `telemetry/operation.ts` 管理计时、span 状态和收尾，具体能力继续负责取消优先级、输入输出校验、错误归一化及元数据白名单。
