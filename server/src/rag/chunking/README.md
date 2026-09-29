# Chunk Build：检索单元

`rag/chunking/index.ts` 导出 `buildChunks(section, options?)` 和 `countChunkTokens(text)`。输入为 [Section](../sections/README.md) 的有效快照，输出 `ChunkBuildResult` v3；不接收 Wiki 或 enrichment。

```ts
import { buildChunks } from './rag/chunking/index.js'

const result = buildChunks(section, {
  maxTokens: 800,
  overlapTokens: 0,
  oversized: 'keep',
})
```

## 切分规则

- 短 Section 生成单个 Chunk，长 Section 按完整 Markdown 的 Token 预算拆分，计入标题、代码围栏、表头与引用定义。
- 默认使用 cl100k_base，可传入同步、确定且无副作用的 `countTokens`；预算默认 800，overlap 默认 0。
- 段落按 AST 内文本片段拆分；代码按行、表格按数据行、列表按项目拆分。保留 Markdown 结构、代码信息、表头与列表起始编号。
- 重复添加的上下文仅为 Section 自身标题；H4–H6 属于正文，不当作 Section 标题重复。
- 无法细分的超长原子默认完整保留并标记 `oversized`；`oversized: 'error'` 让本次构建失败，不丢弃或截断内容。
- overlap 仅复制同节前一 Chunk 的尾部片段，预算不足时减少，优先保证新内容。

## 结果与引用

结果保留 `documentId`、`sectionId`、`sectionRevision`、计数器和预算信息。每个 Chunk 保留相同的 Section 引用，以及自身内容、Token 数、`parts`、`previousChunkId`、`nextChunkId`。

`parts` 标记 Section AST 中的原块、片段范围和 overlap。细分后的 AST 不伪造源文档精确行列；完整块位置是构建时快照，当前 citation 通过 Section 回查。Chunk 不保存语义事实、Wiki 快照或 enrichment。

ID 使用 `${section.id}#chunk-${index}`，重新切分后调用方应按 Section 替换原 Chunk 集合，不能只新增而遗留旧片段。版本通过 `sectionRevision` 区分，前后引用不跨 Section。

检索的后续设计为：命中 Chunk → 当前 Section → 多个语义节点 → 图扩展。Chunk Build 本身不构建 embeddingText；[indexing](../indexing/README.md) 负责将 Chunk 与当前 Wiki 关联后生成两类向量输入和内存向量结果。向量库写入和精确余弦查询由 `vector-store` 提供，生产检索服务仍待实现。

## 验证

`server/test/chunk-build.test.mjs` 覆盖独立构建、预算、Unicode、代码/表格/列表、overlap、引用、超限策略、版本和输入不可变性。统一使用 `AppError` 与 `CHUNK_BUILD_ERROR_CODES`。
