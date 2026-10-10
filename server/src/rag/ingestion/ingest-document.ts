import type { LlmClient } from '../../llm/index.js'
import type { EmbeddingClient } from '../embedding/index.js'
import type { EnrichedSection, EnrichmentOptions } from '../enrichment/index.js'
import type { DualIndexEmbeddingOptions } from '../indexing/index.js'
import type { DocumentVectorStore, VectorSnapshotInfo } from '../vector-store/index.js'
import type { IngestionCheckpointStore } from './checkpoints.js'
import type { IngestionObserver } from './stages.js'
import { INGESTION_ERROR_CODES as CODES, VECTOR_STORE_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { buildChunks } from '../chunking/index.js'
import { resolveEmbeddingDimensions } from '../embedding/index.js'
import { KnowledgeEnricher } from '../enrichment/index.js'
import { buildIndexDocuments, embedDualIndex } from '../indexing/index.js'
import { NextraMdxAdapter, NormalizationClient } from '../normalization/index.js'
import { splitSections } from '../sections/index.js'
import { buildWiki } from '../wiki/index.js'
import { chunksPreview, embeddingPreview, enrichmentPreview, indexingPreview, normalizePreview, sectionsPreview, storagePreview, wikiPreview } from './previews.js'
import { createStageReporter } from './stages.js'

export interface IngestDocumentRequest {
  knowledgeBaseId: string
  documentId: string
  content: string
  sourcePath?: string
  signal?: AbortSignal
}

/** 单篇文档完整重建；所有外部模型调用成功后才原子替换该文档的双索引。 */
export async function ingestDocument(request: IngestDocumentRequest, dependencies: { llm: LlmClient, embedding: EmbeddingClient, store: DocumentVectorStore }, options: { llm: EnrichmentOptions, embedding: Omit<DualIndexEmbeddingOptions, 'signal'>, onStage?: IngestionObserver, checkpoint?: IngestionCheckpointStore, writeKey?: string }) {
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
  const checkpoint = options.checkpoint
  const savedPrevious = await checkpoint?.load<VectorSnapshotInfo | null>('previous')
  const previous = savedPrevious === undefined ? await dependencies.store.getSnapshot(knowledgeBaseId) : savedPrevious
  if (savedPrevious === undefined)
    await checkpoint?.save('previous', previous)
  if (previous && previous.chunks + previous.wikiNodes > 0 && (previous.provider !== options.embedding.provider || previous.requestedModel !== options.embedding.model
    || (options.embedding.dimensions !== undefined && previous.dimensions !== options.embedding.dimensions))) {
    throw new AppError(VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE, 'Embedding 选择与知识库不一致；更换模型需使用新知识库或重建完整索引。')
  }
  checkCancelled()
  const stages = createStageReporter(options.onStage, checkpoint)
  const document = await stages.run('normalize', () => new NormalizationClient([new NextraMdxAdapter()]).normalize({ adapter: 'nextra-mdx', source: { id: documentId, ...(sourcePath === undefined ? {} : { path: sourcePath }) }, content, signal }), value => normalizePreview(value, documentId))
  const sections = await stages.run('sections', () => {
    const result = splitSections(document)
    if (!result.length || !document.text.trim() || result.length > 100)
      throw new AppError(CODES.INVALID_DOCUMENT, '文档需要可检索文本，且最多包含 100 个章节。')
    return result
  }, sectionsPreview)
  const chunks = await stages.run('chunks', () => sections.flatMap(section => buildChunks(section).chunks), chunksPreview)
  const enricher = new KnowledgeEnricher(dependencies.llm, { ...options.llm, maxOutputTokens: options.llm.maxOutputTokens ?? 10000 })
  const inputs = await stages.run('enrichment', async () => {
    const result = []
    await stages.progress(0, sections.length)
    for (const section of sections) {
      checkCancelled()
      const key = `section:${section.id}:${section.revision}`
      const saved = await checkpoint?.load<EnrichedSection>(key)
      const enrichedSection = saved ?? await enricher.enrich(section, { signal })
      if (!saved)
        await checkpoint?.save(key, enrichedSection)
      result.push({ section, enrichedSection })
      await stages.progress(result.length, sections.length)
    }
    return result
  }, value => enrichmentPreview(value, options.llm.model))
  // 不做隐式同名归并，因此单文档更新不会改变其他文档的 Wiki 节点。
  const wiki = await stages.run('wiki', () => buildWiki(inputs, { knowledgeBaseId, canonicalNodes: [], mappings: [] }), wikiPreview)
  const documents = await stages.run('indexing', () => buildIndexDocuments({ chunks, wiki }), indexingPreview)
  const dimensions = resolveEmbeddingDimensions(options.embedding, previous?.dimensions)
  const vectors = await stages.run('embedding', () => embedDualIndex(documents, dependencies.embedding, { ...options.embedding, ...(dimensions === undefined ? {} : { dimensions }), signal, checkpoint }), embeddingPreview)
  checkCancelled()
  const stored = await stages.run('storage', () => dependencies.store.replaceDocument(vectors, documentId, { expectedRevision: previous?.revision ?? null, signal, writeKey: options.writeKey }), value => storagePreview(value, vectors.chunks.length + vectors.wikiNodes.length))
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

export type IngestDocumentResult = Awaited<ReturnType<typeof ingestDocument>>
