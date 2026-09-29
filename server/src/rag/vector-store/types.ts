import type { DualIndexEmbeddingResult, IndexDocument } from '../indexing/types.js'

export interface VectorSnapshotInfo {
  knowledgeBaseId: string
  revision: string
  provider: string
  requestedModel: string
  model: string | null
  dimensions: number | null
  chunks: number
  wikiNodes: number
}

export interface SnapshotWriteOptions {
  /** 首次写入传 null；更新必须传读取到的版本，防止并发任务覆盖新数据。 */
  expectedRevision: string | null
  signal?: AbortSignal
}

/** 输入代表整个知识库的完整双索引快照，遗漏的旧记录会在同一事务中删除。 */
export interface VectorSnapshotStore {
  getSnapshot: (knowledgeBaseId: string) => Promise<VectorSnapshotInfo | null>
  replaceSnapshot: (input: DualIndexEmbeddingResult, options: SnapshotWriteOptions) => Promise<VectorSnapshotInfo>
}

export interface VectorSearchRequest {
  knowledgeBaseId: string
  kind: 'chunk' | 'wiki'
  provider: string
  /** 查询向量实际所属模型，必须与已写入快照相同。 */
  model: string
  vector: readonly number[]
  limit?: number
}

export interface VectorSearchHit {
  document: IndexDocument & { embeddingRevision: string }
  score: number
}

export interface DualVectorSearchRequest extends Omit<VectorSearchRequest, 'kind'> {
  /** 问题向量生成前读取的快照版本；变化时明确失败，不混入新旧空间。 */
  expectedRevision: string
  signal?: AbortSignal
}

export interface DualVectorSearchResult {
  snapshotRevision: string
  chunks: VectorSearchHit[]
  wikiNodes: VectorSearchHit[]
}

export interface VectorQueryStore {
  getSnapshot: (knowledgeBaseId: string) => Promise<VectorSnapshotInfo | null>
  searchDual: (request: DualVectorSearchRequest) => Promise<DualVectorSearchResult>
}
