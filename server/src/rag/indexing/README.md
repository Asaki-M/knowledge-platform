# 双索引构建

`indexing` 组合已有 Chunk、Wiki 和 Embedding 能力，生成可追溯的两类内存向量产物，不依赖 HTTP 或数据库。`buildIndexDocuments` 是纯函数，`embedDualIndex` 才调用向量模型。知识提取仍使用现有 `KnowledgeEnricher`，在调用方配置 DeepSeek。

## 文本与来源

| 索引  | embeddingText                                                         | 来源元数据                                         |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------- |
| Chunk | 文档标题、章节路径、完整 Chunk Markdown、本节 Wiki 节点名称/别名/描述 | documentId、sectionId/revision、路径、关联节点版本 |
| Wiki  | 节点名称、类型、别名、描述、事实、关系的名称与方向                    | Wiki node ID/revision、各贡献 Section 与版本       |

Chunk 的知识块明确标为“本节知识信息”，可能覆盖本节其他 Chunk 的上下文。共享节点只取当前节的描述贡献，其他节的知识不会复制进该 Chunk。Wiki 则汇总节点的全部有效贡献。关系端点用可读名称表示；来源路径、哈希 ID、请求 ID 和证据引用布局不进入向量文本。模型生成知识与原文分块保留，不覆盖原文。

`schemaVersion: 1` / `templateVersion: 1` 的构造结果包含 `chunks` 和 `wikiNodes`。单条记录具有：

- `id`：知识库命名空间、索引类型、原对象 ID 的稳定组合。
- `sourceId` / `sourceRevision`：Chunk 与 Section 版本，或 Wiki node 与 node 版本。
- `textRevision`：模板版本与实际 embeddingText 的哈希。单纯更换来源路径或生成请求 ID 不改变此值。
- `sources` / `wikiNodes`：用于来源回查和失效判断；与文本指纹分别维护。
- `knowledgeStatus`：`ready` 为已有当前提取结果（允许无语义节点），`pending` 为明确待提取，`unavailable` 为 Wiki 快照尚不包含此节。

关联的 Section 版本不匹配时失败。pending 节保留原文 Chunk 索引，Wiki 中已撤销其旧贡献；本层不缓存或恢复旧知识。不会按同名自动消歧或聚合节点，身份映射仍由 Wiki 调用方显式提供。

## 调用示例

示例放在 `server/src` 的调用方，环境需已加载 `server/.env`。每个模型 ID 都显式传入，不在导入或 HTTP 启动时执行这些调用。

```ts
import type { NormalizedDocument } from './rag/normalization/index.js'
import process from 'node:process'
import { DeepSeekAdapter, LlmClient } from './llm/index.js'
import { buildChunks } from './rag/chunking/index.js'
import {
  EmbeddingClient,
  SiliconFlowEmbeddingAdapter,
} from './rag/embedding/index.js'
import { KnowledgeEnricher } from './rag/enrichment/index.js'
import { buildIndexDocuments, embedDualIndex } from './rag/indexing/index.js'
import { splitSections } from './rag/sections/index.js'
import { buildWiki } from './rag/wiki/index.js'

export async function buildDocumentIndexes(
  document: NormalizedDocument,
  knowledgeBaseId: string,
) {
  const model = process.env.DEEPSEEK_MODEL
  const embeddingModel = process.env.EMBEDDING_MODEL
  if (!model || !embeddingModel) {
    throw new Error('DEEPSEEK_MODEL and EMBEDDING_MODEL are required')
  }
  const enricher = new KnowledgeEnricher(
    new LlmClient([new DeepSeekAdapter()]),
    {
      provider: 'deepseek',
      model,
      maxOutputTokens: 10000,
    },
  )
  const sections = splitSections(document)
  const inputs = []
  for (const section of sections) {
    inputs.push({ section, enrichedSection: await enricher.enrich(section) })
  }
  // 本例不提供全局映射；同名项仍按各节局部身份独立保留。
  const wiki = buildWiki(inputs, {
    knowledgeBaseId,
    canonicalNodes: [],
    mappings: [],
  })
  const chunks = sections.flatMap((section) => {
    return buildChunks(section).chunks
  })
  const documents = buildIndexDocuments({ chunks, wiki })
  const vectors = await embedDualIndex(
    documents,
    new EmbeddingClient([new SiliconFlowEmbeddingAdapter()]),
    {
      provider: 'siliconflow',
      model: embeddingModel,
      batchSize: 32,
    },
  )
  return { sections, inputs, chunks, wiki, documents, vectors }
}
```

这是单份文档的能力组合示例，不是完整入库编排；已有知识库需由调用方使用 `updateWiki` 得到当前快照。若共享节点的语义发生变化，应重新构造受影响的索引输入并比较 `textRevision`，不能只依据原文变化计划判断是否需要重嵌入。自动增量调度仍待实现；`ingestion.indexAndStore` 已连接 `PgVectorStore`，支持完整知识库快照的原子替换和删除过期向量。

## 预算与向量空间

文本预算默认 8000 Token，计算完整文本。默认计数器为 cl100k_base 基线，可用 `countTokens` 替换；它不等价于 BGE 或 Google 的真实分词器，供应商仍会校验实际模型上限。超限、计数异常均抛出 `AppError`，不截断原文、丢弃 Wiki 字段或悄悄重切块。构造完成后调用方可以先检查文本再执行模型请求。

`embedDualIndex` 先快照全部输入，再按 Chunk、Wiki 的顺序分批，默认每批 32 条。两类向量共用显式 provider/model/dimensions，批间实际模型或维度变化会失败。SDK 校验每条输入对应一个有限数值向量；本层再把向量按顺序绑定回稳定 ID。

结果按 `chunks` / `wikiNodes` 分开保存，公共字段记录供应商、请求模型、实际模型和维度；每条 `embeddingRevision` 绑定文本指纹及向量空间。使用这些结果做检索时，查询向量必须使用同一模型和维度。模型别名背后的服务若发生未报告的升级，调用方仍需主动重建，指纹无法检测供应商未声明的变化。

所有批次成功才返回整套结果；已完成的上游调用无法撤销，但本层没有外部写入或隐式重试。`batches` 保留各批次记录 ID、请求 ID 和用量；任一批用量未知，总用量为 `null`。空输入不调用模型，实际模型、维度和用量均为 `null`。

## 验证和范围

`server/test/indexing.test.mjs` 以真实 Normalization / Split / Chunk / Wiki 和内存 Embedding stub 验证来源、文本版本、跨节隔离、预算、批次顺序、取消与失败。真实 DeepSeek + SiliconFlow 短文测试的完整阶段数据见 [报告](../../../test/reports/dual-index/report.md)；报告里的余弦排序只是本次内存检查，数据库写入及精确余弦查询已由 [vector-store](../vector-store/README.md) 实现；双路检索、结果去重、Rerank 和单文档完整入库已通过 [HTTP 接口](../../core/README.md) 接入；原始文件独立持久化仍未实现。

错误码统一在 `server/src/error-codes.ts` 的 `INDEXING_ERROR_CODES`，SDK 的取消、鉴权、超时等错误沿用 `EMBEDDING_ERROR_CODES`。文本构造不写日志；网络调用复用现有 SDK 客户端的追踪，只记录元数据。
