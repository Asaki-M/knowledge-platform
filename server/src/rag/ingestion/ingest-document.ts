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
import { KnowledgeEnricher } from '../enrichment/index.js'
import { buildIndexDocuments, embedDualIndex } from '../indexing/index.js'
import { NextraMdxAdapter, NormalizationClient } from '../normalization/index.js'
import { splitSections } from '../sections/index.js'
import { buildWiki } from '../wiki/index.js'
import { createStageReporter, stagePreview } from './stages.js'

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
  const document = await stages.run('normalize', () => new NormalizationClient([new NextraMdxAdapter()]).normalize({ adapter: 'nextra-mdx', source: { id: documentId, ...(sourcePath === undefined ? {} : { path: sourcePath }) }, content, signal }), value => stagePreview([
    { label: '字符', value: value.text.length },
    { label: '警告', value: value.warnings.length },
  ], [{ id: documentId, title: '标准 Markdown', text: value.markdown }, ...value.warnings.map((warning, index) => ({ id: `warning-${index}`, title: '标准化警告', text: warning.message }))]))
  const sections = await stages.run('sections', () => {
    const result = splitSections(document)
    if (!result.length || !document.text.trim() || result.length > 100)
      throw new AppError(CODES.INVALID_DOCUMENT, '文档需要可检索文本，且最多包含 100 个章节。')
    return result
  }, value => stagePreview([{ label: '章节', value: value.length }], value.map(section => ({ id: section.id, title: section.headingPath.map(item => item.title).join(' / ') || '前言', text: section.markdown }))))
  const chunks = await stages.run('chunks', () => sections.flatMap(section => buildChunks(section).chunks), value => stagePreview([
    { label: '片段', value: value.length },
    { label: '超长片段', value: value.filter(chunk => chunk.oversized).length },
    { label: '分词基线', value: 'cl100k_base' },
  ], value.map(chunk => ({ id: chunk.id, title: `${chunk.headingPath.map(item => item.title).join(' / ') || '前言'} · 片段 ${chunk.index + 1} · ${chunk.tokenCount} Token${chunk.oversized ? ' · 超长' : ''}`, text: chunk.markdown }))))
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
  }, value => stagePreview([
    { label: '已提取章节', value: value.length },
    { label: '实体与概念', value: value.reduce((sum, item) => sum + item.enrichedSection.enrichment.entities.length + item.enrichedSection.enrichment.concepts.length, 0) },
    { label: '模型', value: options.llm.model },
  ], value.map(({ section, enrichedSection }) => {
    const knowledge = enrichedSection.enrichment
    return {
      id: section.id,
      title: section.title || '前言',
      text: [`摘要：${knowledge.summary}`, `关键词：${knowledge.keywords.join('、')}`, `分类：${knowledge.knowledgeType}`, ...knowledge.questions.map(question => `可能的问题：${question}`), ...[...knowledge.entities, ...knowledge.concepts].map(node => `知识点：${node.name}\n${node.description}\n证据：${node.evidence.join('；')}`), ...knowledge.facts.map(fact => `事实：${fact.statement}\n证据：${fact.evidence.join('；')}`), ...knowledge.relations.map(relation => `关系：${relation.description}\n证据：${relation.evidence.join('；')}`)].join('\n\n'),
    }
  })))
  // 不做隐式同名归并，因此单文档更新不会改变其他文档的 Wiki 节点。
  const wiki = await stages.run('wiki', () => buildWiki(inputs, { knowledgeBaseId, canonicalNodes: [], mappings: [] }), value => stagePreview([
    { label: '知识节点', value: value.nodes.length },
    { label: '语义关系', value: value.edges.length },
  ], value.nodes.map(node => ({ id: node.id, title: `${node.kind === 'entity' ? '实体' : '概念'} · ${node.title}`, text: node.markdown }))))
  const documents = await stages.run('indexing', () => buildIndexDocuments({ chunks, wiki }), value => stagePreview([
    { label: 'Chunk 索引', value: value.chunks.length },
    { label: 'Wiki 索引', value: value.wikiNodes.length },
  ], [...value.chunks, ...value.wikiNodes].map(item => ({ id: item.id, title: `${item.kind === 'chunk' ? 'Chunk' : 'Wiki'} · ${item.title} · ${item.tokenCount} Token`, text: item.embeddingText }))))
  const dimensions = options.embedding.dimensions ?? ((options.embedding.provider === 'google' || options.embedding.model.startsWith('Qwen/Qwen3-')) ? previous?.dimensions ?? undefined : undefined)
  const vectors = await stages.run('embedding', () => embedDualIndex(documents, dependencies.embedding, { ...options.embedding, ...(dimensions === undefined ? {} : { dimensions }), signal, checkpoint }), value => stagePreview([
    { label: '向量', value: value.chunks.length + value.wikiNodes.length },
    { label: '维度', value: value.dimensions ?? '未提供' },
    { label: '模型', value: value.model ?? '未提供' },
    { label: '批次', value: value.batches.length },
  ]))
  checkCancelled()
  const stored = await stages.run('storage', () => dependencies.store.replaceDocument(vectors, documentId, { expectedRevision: previous?.revision ?? null, signal, writeKey: options.writeKey }), value => stagePreview([
    { label: '本次写入向量', value: vectors.chunks.length + vectors.wikiNodes.length },
    { label: '全库 Chunk', value: value.chunks },
    { label: '全库 Wiki', value: value.wikiNodes },
    { label: '快照版本', value: value.revision },
  ]))
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
