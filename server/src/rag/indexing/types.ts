import type { DocumentChunk } from '../chunking/types.js'
import type { EmbeddingUsage } from '../embedding/types.js'
import type { SectionHeading } from '../sections/types.js'
import type { WikiBuildResult } from '../wiki/types.js'

export interface IndexBuildInput {
  chunks: readonly DocumentChunk[]
  /** 当前知识库的 Wiki 快照；pending 节只构造原文索引，不沿用旧知识。 */
  wiki: WikiBuildResult
}

export interface IndexBuildOptions {
  /** 完整 embeddingText 的预算，默认 8000；超限明确失败，不截断原文或知识。 */
  maxTokens?: number
  /** 默认 cl100k_base 基线；生产调用应按目标模型提供相应 Token 计数器。 */
  countTokens?: (text: string) => number
}

export interface IndexSource {
  documentId: string
  sectionId: string
  sectionRevision: string
  sourcePath: string | null
  headingPath: SectionHeading[]
}

export interface IndexDocument {
  /** 知识库、索引类型与原对象 ID 共同确定身份；内容变化不改变此 ID。 */
  id: string
  kind: 'chunk' | 'wiki'
  knowledgeBaseId: string
  sourceId: string
  /** chunk 对应 section revision，wiki 对应 node revision。 */
  sourceRevision: string
  title: string
  embeddingText: string
  /** 只绑定模板和实际向量化文本；来源路径或生成请求 ID 改动不触发重算。 */
  textRevision: string
  tokenCount: number
  sources: IndexSource[]
  /** 记录关联版本，但不把内部 ID、路径、版本哈希发送给向量模型。 */
  wikiNodes: { id: string, revision: string }[]
  knowledgeStatus: 'ready' | 'pending' | 'unavailable'
}

export interface IndexBuildResult {
  schemaVersion: 1
  templateVersion: 1
  knowledgeBaseId: string
  tokenizer: 'cl100k_base' | 'custom'
  maxTokens: number
  chunks: IndexDocument[]
  wikiNodes: IndexDocument[]
}

export interface DualIndexEmbeddingOptions {
  provider: string
  model: string
  dimensions?: number
  /** 默认 32，顺序分批；实际允许的上限仍由目标适配器校验。 */
  batchSize?: number
  signal?: AbortSignal
}

export interface EmbeddedIndexDocument extends IndexDocument {
  vector: number[]
  /** 同时绑定文本、供应商、请求/实际模型与维度，防止跨向量空间误复用。 */
  embeddingRevision: string
}

/** 内存中的双索引向量产物，不包含数据库表、集合或写入逻辑。 */
export interface DualIndexEmbeddingResult {
  schemaVersion: 1
  knowledgeBaseId: string
  provider: string
  requestedModel: string
  /** 空输入没有上游调用，实际模型与维度均为 null。 */
  model: string | null
  dimensions: number | null
  chunks: EmbeddedIndexDocument[]
  wikiNodes: EmbeddedIndexDocument[]
  /** 任一批次未报告用量则总用量为 null，单批数据仍保留。 */
  usage: EmbeddingUsage | null
  batches: { documentIds: string[], requestId?: string, usage: EmbeddingUsage | null }[]
}
