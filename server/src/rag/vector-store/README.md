# PostgreSQL / pgvector 向量存储

本模块将已有 `DualIndexEmbeddingResult` 持久化为两类逻辑索引：`chunk` 与 `wiki`。`rag_vector_snapshots` 保存知识库当前模型空间、版本和数量；`rag_vectors` 保存向量、完整 embeddingText、来源与文本版本。模型用量保留在调用结果中，不写入记录元数据。

## Neon 配置

在 Neon 创建 PostgreSQL 项目，推荐 PostgreSQL 17，区域尽量与后端部署区域一致。只需开启 Postgres database，现有代码通过 `pg` 连接，不依赖 Neon 的 Functions、Object storage、AI gateway 或 Auth。

在 Neon 连接面板关闭 `Connection pooling`，复制直连连接串并完整保留 SSL 参数，填入私有 `server/.env` 的 `VECTOR_DATABASE_URL`；部署时配置到服务端环境变量。入库断点依赖 PostgreSQL 会话锁，不能使用带 `-pooler` 的事务池地址。连接串包含密码，不打印或提交，不暴露给前端。`.env.example` 只提供变量说明。

应用的健康检查不依赖数据库，初始化必须由调用方显式执行，构造客户端不会联网。新增数据库使用 `initialize()` 幂等创建 `vector` 扩展和表，单文档入库接口已显式调用此方法；当前没有自动升级已有表的迁移系统。新建 Neon 数据库不会自动迁移旧数据库的数据。

## 写入现有流程

在 Normalization → Section → DeepSeek Enrichment → Wiki / Chunk 之后，传入**整个知识库的当前快照**。以下示例在 `server/src` 调用方中使用，已加载服务端环境变量：

<!-- prettier-ignore -->
```ts
import type { IndexBuildInput } from './rag/indexing/index.js'
import process from 'node:process'
import {
  EmbeddingClient,
  SiliconFlowEmbeddingAdapter,
} from './rag/embedding/index.js'
import { indexAndStore } from './rag/ingestion/index.js'
import { PgVectorStore } from './rag/vector-store/index.js'

export async function writeKnowledgeBase(input: IndexBuildInput) {
  const model = process.env.EMBEDDING_MODEL
  if (!model) {
    throw new Error('EMBEDDING_MODEL is required')
  }
  const store = new PgVectorStore()
  try {
    await store.initialize()
    const embedding = new EmbeddingClient([new SiliconFlowEmbeddingAdapter()])
    return await indexAndStore(input, embedding, store, {
      embedding: { provider: 'siliconflow', model },
    })
  }
  finally {
    await store.close()
  }
}
```

长驻应用可复用 store，并在关闭服务时调用 `close()`。当前示例不挂接 HTTP，也不重复调用 DeepSeek；已有 `KnowledgeEnricher` 负责上一步的知识提取。

若已经有生成好的向量，直接使用 `getSnapshot(knowledgeBaseId)` 读取版本，再调用 `replaceSnapshot(vectors, { expectedRevision: previous?.revision ?? null })`。写入后返回知识库 ID、版本、模型、维度与两类数量。

**replaceSnapshot 不是单文档 upsert。** 输入缺少的记录会从当前知识库删除；空快照表示清空当前知识库的向量。多个文档属于同一知识库时，调用方必须提供它们当前的全部 Chunk 与完整 Wiki 快照。数据库中的其他知识库不受影响。文件上传、原始文档及完整 Section/Wiki 对象的独立持久化、自动增量调度仍待实现。

## 一致性

- 先完成全部 Embedding 调用，再开始数据库写事务；模型失败不会产生部分写入。
- 每个事务使用同一个连接，通过知识库级事务锁和 `expectedRevision` 检查避免并发覆盖，包括两个首次写入任务。
- 每批最多写 128 条，但所有批次、旧记录删除和快照更新共用一次提交。SQL 失败或提交前取消会回滚整个事务，已开始的 SQL 受 `statementTimeoutMs` 约束（默认 30 秒）。取消不强制中断正在执行的 SQL，而是在后续检查点回滚；提交已完成后不报告取消成功。
- PostgreSQL 连接同时启用客户端读取超时与 TCP keepalive；默认读取超时取 SQL 执行预算加 5 秒与 60 秒中的较大值，为完整检查点和向量结果留出传输时间，同时覆盖数据库已执行完但结果读取停滞的情况。超时后尝试回滚，回滚失败丢弃连接；借出连接的异常也记录脱敏事件，避免单个数据库连接断开导致 HTTP 进程退出。不自动重试写入或模型调用。
- 版本由内容、来源与模型空间确定，相同快照重复写入保持同一版本。用量、批次请求 ID 不参与版本。
- 单文档更新的全库版本使用数据库内生成的逐条元数据和向量 SHA-256 指纹，按记录 ID 排序后汇总；不再将全库正文和向量传回应用。版本仍为不透明的并发比较值，已有版本可继续传入 `expectedRevision`，下次单文档写入后使用新的指纹算法；回执仍与数据原子提交。
- 参数使用 [node-postgres 参数化查询](https://node-postgres.com/features/queries)，[事务复用同一连接](https://node-postgres.com/features/transactions)。错误使用统一 AppError / VECTOR_STORE_ERROR_CODES，不返回数据库原始报错、连接串或 SQL 参数。

## 数据库查询

`store.search({ knowledgeBaseId, kind, provider, model, vector, limit? })` 返回 `{ document, score }[]`。`document` 包含完整索引文本、来源和版本；`score` 是余弦相似度。查询向量必须使用与入库相同的实际模型和维度，不能仅凭维度相同混用两个模型。

当前使用 [pgvector 的精确余弦距离](https://github.com/pgvector/pgvector)；B-tree 索引先按知识库和 chunk/wiki 过滤，尚未建立 HNSW 近似索引。向量按 pgvector 的 float32 存储，允许 1–16000 维非零有限向量；查询结果相对于 JavaScript 双精度计算可能存在微小差异。

这提供数据库级搜索能力，不包含 HTTP 检索 API、双路结果融合、图扩展或 Rerank。

## 验证

普通 `pnpm test` 执行离线校验与入库组合测试；真实数据库测试默认跳过。显式设置 `VECTOR_STORE_TEST_DATABASE_URL` 后运行 `server/test/vector-store.test.mjs`，测试会创建随机命名的独立数据库，结束后删除它，需要连接用户有创建数据库权限。不要将此变量指向生产服务。

将 `VECTOR_STORE_TEST_DATABASE_URL` 单独设置为独立测试项目的连接串后，在仓库根目录运行。不要从知识库使用的 `VECTOR_DATABASE_URL` 自动推导测试连接；未设置测试变量时，真实数据库测试跳过。

```sh
pnpm --filter @knowledge/server build
node --test server/test/vector-store.test.mjs
```

测试覆盖实际写入、重复写入、余弦查询、跨知识库隔离、删除旧记录、第二批写入失败回滚、并发冲突、关闭后重连读取及空快照。历史真实短文向量的本地数据库结果见 [数据库实测数据](../../../test/reports/dual-index/09-database.json)，不代表新建 Neon 项目已包含这些记录。

## 双路检索

`searchDual({ knowledgeBaseId, provider, model, vector, expectedRevision, limit: 30, signal })` 在同一 repeatable-read 只读事务内分别检索 Chunk 和 Wiki 节点，各返回最多 30 条。先验证快照版本与向量空间，再读取两路数据；版本变化返回 `VECTOR_STORE_CONFLICT`。完整问答流程见 [Query](../query/README.md)。

## 按文档替换

`replaceDocument(vectors, documentId, { expectedRevision, signal })` 使用与完整快照相同的事务锁、版本检查和批量写入，仅删除当前文档不再存在的旧记录，保留其他文档。返回整个知识库的版本与数量。禁止混用向量空间，也拒绝覆盖已有跨文档共享节点。新文档必须包含至少一个 Chunk，不能通过空输入删除文档。版本根据数据库实际内容计算，完全相同的记录重复写入保持同一版本。当前通过扫描本知识库记录重算版本，适用于小规模知识库。

## 可恢复写入回执

SnapshotWriteOptions.writeKey 可指定幂等键，rag_vector_write_receipts 在写入事务保存输入指纹和最终快照结果。同库同键重试相同输入返回原提交结果，避免提交后断线引起重复写入；键关联其他输入仍失败。回执检查位于知识库事务锁内、版本比较之前；其余写入仍严格检查 expectedRevision。失败事务不留下回执，其他任务后续提交不会被旧任务恢复覆盖。
