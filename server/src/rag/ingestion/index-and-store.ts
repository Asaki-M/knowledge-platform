import type { EmbeddingClient } from '../embedding/index.js'
import type { DualIndexEmbeddingOptions, IndexBuildInput, IndexBuildOptions } from '../indexing/index.js'
import type { VectorSnapshotStore } from '../vector-store/types.js'
import { buildIndexDocuments, embedDualIndex } from '../indexing/index.js'

export interface IndexAndStoreOptions {
  text?: IndexBuildOptions
  embedding: DualIndexEmbeddingOptions
}

/** 完整知识库快照：先准备全部向量，最后一个事务替换数据库中的双索引。 */
export async function indexAndStore(input: IndexBuildInput, client: EmbeddingClient, store: VectorSnapshotStore, options: IndexAndStoreOptions) {
  // 同步构造文本先拒绝无效来源；网络等待期间调用方修改输入不会影响这次提交。
  const documents = buildIndexDocuments(input, options.text)
  const embeddingOptions = { ...options.embedding }
  const previous = await store.getSnapshot(documents.knowledgeBaseId)
  const vectors = await embedDualIndex(documents, client, embeddingOptions)
  const stored = await store.replaceSnapshot(vectors, { expectedRevision: previous?.revision ?? null, signal: embeddingOptions.signal })
  return { documents, vectors, stored }
}
