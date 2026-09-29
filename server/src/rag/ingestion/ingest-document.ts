import type { LlmClient } from '../../llm/index.js'
import type { EmbeddingClient } from '../embedding/index.js'
import type { EnrichmentOptions } from '../enrichment/index.js'
import type { DualIndexEmbeddingOptions } from '../indexing/index.js'
import type { DocumentVectorStore } from '../vector-store/index.js'
import { INGESTION_ERROR_CODES as CODES, VECTOR_STORE_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { buildChunks } from '../chunking/index.js'
import { KnowledgeEnricher } from '../enrichment/index.js'
import { buildIndexDocuments, embedDualIndex } from '../indexing/index.js'
import { NextraMdxAdapter, NormalizationClient } from '../normalization/index.js'
import { splitSections } from '../sections/index.js'
import { buildWiki } from '../wiki/index.js'

export interface IngestDocumentRequest {
  knowledgeBaseId: string
  documentId: string
  content: string
  sourcePath?: string
  signal?: AbortSignal
}

/** 单篇文档完整重建；所有外部模型调用成功后才原子替换该文档的双索引。 */
export async function ingestDocument(request: IngestDocumentRequest, dependencies: { llm: LlmClient, embedding: EmbeddingClient, store: DocumentVectorStore }, options: { llm: EnrichmentOptions, embedding: Omit<DualIndexEmbeddingOptions, 'signal'> }) {
  const { knowledgeBaseId, documentId, content, sourcePath, signal } = request
  if (![knowledgeBaseId, documentId, content].every(isNonEmptyString) || knowledgeBaseId.length > 256 || documentId.length > 256 || content.length > 200000
    || (sourcePath !== undefined && (!isNonEmptyString(sourcePath) || sourcePath.length > 2048))) {
    throw new AppError(CODES.INVALID_DOCUMENT, '文档 ID、知识库 ID 或正文无效；正文最多 200000 字符。')
  }
  const checkCancelled = () => {
    if (signal?.aborted)
      throw new AppError(CODES.ABORTED, 'Document ingestion was cancelled')
  }
  checkCancelled()
  // 提取前绑定旧版本；并发更新时拒绝提交，避免长时间模型调用覆盖新数据。
  const previous = await dependencies.store.getSnapshot(knowledgeBaseId)
  if (previous && previous.chunks + previous.wikiNodes > 0 && (previous.provider !== options.embedding.provider || previous.requestedModel !== options.embedding.model
    || (options.embedding.dimensions !== undefined && previous.dimensions !== options.embedding.dimensions))) {
    throw new AppError(VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE, 'Embedding 选择与知识库不一致；更换模型需使用新知识库或重建完整索引。')
  }
  checkCancelled()
  const document = await new NormalizationClient([new NextraMdxAdapter()]).normalize({ adapter: 'nextra-mdx', source: { id: documentId, ...(sourcePath === undefined ? {} : { path: sourcePath }) }, content, signal })
  const sections = splitSections(document)
  if (!sections.length || !document.text.trim() || sections.length > 100)
    throw new AppError(CODES.INVALID_DOCUMENT, '文档需要可检索文本，且最多包含 100 个章节。')
  const chunks = sections.flatMap(section => buildChunks(section).chunks)
  const enricher = new KnowledgeEnricher(dependencies.llm, { ...options.llm, maxOutputTokens: options.llm.maxOutputTokens ?? 10000 })
  const inputs = []
  for (const section of sections) {
    checkCancelled()
    inputs.push({ section, enrichedSection: await enricher.enrich(section, { signal }) })
  }
  // 不做隐式同名归并，因此单文档更新不会改变其他文档的 Wiki 节点。
  const wiki = buildWiki(inputs, { knowledgeBaseId, canonicalNodes: [], mappings: [] })
  const documents = buildIndexDocuments({ chunks, wiki })
  const dimensions = options.embedding.dimensions ?? ((options.embedding.provider === 'google' || options.embedding.model.startsWith('Qwen/Qwen3-')) ? previous?.dimensions ?? undefined : undefined)
  const vectors = await embedDualIndex(documents, dependencies.embedding, { ...options.embedding, ...(dimensions === undefined ? {} : { dimensions }), signal })
  checkCancelled()
  const stored = await dependencies.store.replaceDocument(vectors, documentId, { expectedRevision: previous?.revision ?? null, signal })
  return {
    status: 'stored' as const,
    knowledgeBaseId,
    documentId,
    normalization: { title: document.title, warnings: document.warnings, characters: document.text.length },
    counts: { sections: sections.length, chunks: chunks.length, wikiNodes: wiki.nodes.length, wikiEdges: wiki.edges.length, vectors: vectors.chunks.length + vectors.wikiNodes.length },
    enrichment: inputs.map(input => ({ sectionId: input.section.id, ...input.enrichedSection.generation })),
    embedding: { provider: vectors.provider, requestedModel: vectors.requestedModel, model: vectors.model, dimensions: vectors.dimensions, usage: vectors.usage },
    stored,
  }
}
