# 增量影响计算

`planSectionChanges(previous, next)` 是同步纯函数，输入为同一比较范围内的前后完整 Section 快照。缺席表示删除；不能把局部变更列表作为完整快照传入。

返回：

- `added`、`modified`、`removed`：新增、内容版本变化和删除的 Section ID。
- `sourceOnly`、`unchanged`：仅来源/顺序变化和完全未变。
- `rebuildChunkSectionIds`、`rebuildEnrichmentSectionIds`：新增或修改的节。
- `invalidateWikiSectionIds`：已修改或删除的旧节贡献。

调用方先更新 Section，再按计划处理：删除旧 Chunk，替换变更节的 Chunk 集合；修改节尚未完成提取时调用 `updateWiki` 的 `pendingSections` 撤销旧贡献，完成后提交新的 `inputs`。新节也可标记 pending。`sourceOnly` 只刷新 Section 和图来源；引用展示回查当前 Section，旧 Chunk 的绝对位置只是构建快照。

纯路径或行号移动不会安排模型调用和 Chunk 重建；改名或换父级表现为删除加新增。文档标题、元数据和跨节引用定义变化可能影响多个 Section。身份归并映射改变单独调用 `updateWiki`，不影响 Chunk。

`planSectionChanges` 不执行任务、不持久化、不调用模型，不构建 embeddingText 或向量记录。它只计算原文变化；切分配置、提示词或模型升级需要调用方显式安排受影响范围的重建。

错误使用统一 `AppError` 与 `INGESTION_ERROR_CODES`。单测位于 `server/test/ingestion.test.mjs`。

## 双索引写入

`indexAndStore(input, embeddingClient, store, options)` 接收完整知识库范围的 `{ chunks, wiki }`，构造 embeddingText，读取当前数据库版本，生成全部向量，最后调用 `store.replaceSnapshot` 在一个事务中更新 Chunk / Wiki 向量。返回 `{ documents, vectors, stored }`，便于调用方报告各阶段数据。

`input` 是整个知识库的当前快照，不是单份文档增量。已有其他文档时必须一并提供它们当前的 Chunk 和 Wiki 数据；缺失的旧记录会被删除。多个任务基于同一数据库版本工作时，只允许一个提交，其他任务明确失败，不自动重试模型或覆盖新版本。模型调用失败不会写数据库。

向量存储使用 [PgVectorStore](../vector-store/README.md)，复用已有 `buildIndexDocuments` / `embedDualIndex`。LLM 知识提取仍由调用方通过 DeepSeek 的 `KnowledgeEnricher` 先完成；本入口不重复提取或自动加载用户目录。单文档 HTTP 入库已支持正文与完整阶段对象的检查点恢复；原始文件存档和跨任务按变更节复用的增量调度仍待实现。

## 单文档完整入库

`ingestDocument(request, dependencies, options)` 接收知识库 ID、稳定文档 ID 和完整 MDX / Markdown 正文，组合 Normalize → Section → Chunk / Knowledge Enrichment → Wiki → 双索引 Embedding，最后调用 `replaceDocument` 原子写入。HTTP 入口是 `POST /api/documents/ingest`，可按请求选择 DeepSeek / OpenAI 与 Gemini / SiliconFlow，见 [接口文档](../../core/README.md)。

公共入口导出 `IngestDocumentRequest`、`IngestDocumentDependencies`、`IngestDocumentOptions` 和 `IngestDocumentResult`。依赖显式包含 `llm`、`embedding`、`store`；选项包含模型配置、阶段观察者、检查点与写入回执键。`ingestionLimits` 统一文档标识、正文、来源路径和章节数量限制，HTTP 与独立 RAG 入口仍分别执行校验。

读取当前知识库版本后才开始模型调用；写入检查同一版本，冲突不覆盖。节点保持各文档 / 章节独立身份；重传同文档 ID 会完整重建该文档并删除它的旧索引，保留其他文档。涉及既有跨文档共享节点时失败，要求通过完整快照重建。不同文档不能混用 Embedding 空间。

返回标准化警告、各阶段数量、逐节 LLM 与 Embedding 用量、整个知识库的写入版本和数量。原始文件不存档；传入 checkpoint 时保存完整中间产物，用于同任务恢复，不做跨任务变更节复用。

## 阶段事件

`ingestDocument` 可通过 `options.onStage(event)` 观察 normalize、sections、chunks、enrichment、wiki、indexing、embedding、storage 的真实运行、完成和失败事件。事件包含耗时；知识提取阶段逐节报告已完成数量。观察者只接收展示数据，不参与模型选择或事务写入。

完成事件含文本预览和指标；每阶段最多展示前 20 项，每项最多 6000 字符，通过 `totalItems`、`truncated` 明确标注截取。截取仅影响预览，实际建索引和入库使用完整产物。不会传输 AST、向量数组或供应商原始响应，也不将产物预览写入操作日志。未订阅事件时返回原有入库摘要。

## 检查点恢复

options.checkpoint 注入 IngestionCheckpointStore（异步 load/save），各阶段结果、初次知识库版本、逐节 enrichment 和 Embedding 批次分别保存。命中仍报告完成事件并标记 reused；单节失败保留此前成功结果。options.writeKey 传给向量库事务回执，覆盖提交后断线窗口。expectedRevision 在恢复时不刷新，防止覆盖并发更新。

HTTP 层保存输入/配置指纹与版本并持有 PostgreSQL 任务会话锁，RAG 不依赖 HTTP、DAO 或具体数据库。只保存校验成功的结果，不接受截断、拒答或非法证据，不自动重跑模型。服务重启后可按任务 ID 显式继续，未保存的在途调用无法复用。

阶段展示投影集中在同模块的 `previews.ts`；`ingestDocument` 保留阶段顺序、检查点、取消检查与写入编排，`stages.ts` 继续统一事件和预览截取。预览字段、数量限制与恢复行为保持一致。
