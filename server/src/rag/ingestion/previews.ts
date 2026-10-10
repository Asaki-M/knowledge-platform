import type { DocumentChunk } from '../chunking/index.js'
import type { DualIndexEmbeddingResult, IndexBuildResult } from '../indexing/index.js'
import type { NormalizedDocument } from '../normalization/index.js'
import type { DocumentSection } from '../sections/index.js'
import type { VectorSnapshotInfo } from '../vector-store/index.js'
import type { WikiBuildInput, WikiBuildResult } from '../wiki/index.js'
import type { StagePreview } from './stages.js'
import { stagePreview } from './stages.js'

/** 展示投影只读取阶段产物；数量与截取策略统一交给 stagePreview。 */
export function normalizePreview(value: NormalizedDocument, documentId: string): StagePreview {
  return stagePreview([
    { label: '字符', value: value.text.length },
    { label: '警告', value: value.warnings.length },
  ], [{ id: documentId, title: '标准 Markdown', text: value.markdown }, ...value.warnings.map((warning, index) => ({ id: `warning-${index}`, title: '标准化警告', text: warning.message }))])
}

export function sectionsPreview(value: DocumentSection[]): StagePreview {
  return stagePreview([{ label: '章节', value: value.length }], value.map(section => ({ id: section.id, title: section.headingPath.map(item => item.title).join(' / ') || '前言', text: section.markdown })))
}

export function chunksPreview(value: DocumentChunk[]): StagePreview {
  return stagePreview([
    { label: '片段', value: value.length },
    { label: '超长片段', value: value.filter(chunk => chunk.oversized).length },
    { label: '分词基线', value: 'cl100k_base' },
  ], value.map(chunk => ({ id: chunk.id, title: `${chunk.headingPath.map(item => item.title).join(' / ') || '前言'} · 片段 ${chunk.index + 1} · ${chunk.tokenCount} Token${chunk.oversized ? ' · 超长' : ''}`, text: chunk.markdown })))
}

export function enrichmentPreview(value: WikiBuildInput[], model: string): StagePreview {
  return stagePreview([
    { label: '已提取章节', value: value.length },
    { label: '实体与概念', value: value.reduce((sum, item) => sum + item.enrichedSection.enrichment.entities.length + item.enrichedSection.enrichment.concepts.length, 0) },
    { label: '模型', value: model },
  ], value.map(({ section, enrichedSection }) => {
    const knowledge = enrichedSection.enrichment
    return {
      id: section.id,
      title: section.title || '前言',
      text: [`摘要：${knowledge.summary}`, `关键词：${knowledge.keywords.join('、')}`, `分类：${knowledge.knowledgeType}`, ...knowledge.questions.map(question => `可能的问题：${question}`), ...[...knowledge.entities, ...knowledge.concepts].map(node => `知识点：${node.name}\n${node.description}\n证据：${node.evidence.join('；')}`), ...knowledge.facts.map(fact => `事实：${fact.statement}\n证据：${fact.evidence.join('；')}`), ...knowledge.relations.map(relation => `关系：${relation.description}\n证据：${relation.evidence.join('；')}`)].join('\n\n'),
    }
  }))
}

export function wikiPreview(value: WikiBuildResult): StagePreview {
  return stagePreview([
    { label: '知识节点', value: value.nodes.length },
    { label: '语义关系', value: value.edges.length },
  ], value.nodes.map(node => ({ id: node.id, title: `${node.kind === 'entity' ? '实体' : '概念'} · ${node.title}`, text: node.markdown })))
}

export function indexingPreview(value: IndexBuildResult): StagePreview {
  return stagePreview([
    { label: 'Chunk 索引', value: value.chunks.length },
    { label: 'Wiki 索引', value: value.wikiNodes.length },
  ], [...value.chunks, ...value.wikiNodes].map(item => ({ id: item.id, title: `${item.kind === 'chunk' ? 'Chunk' : 'Wiki'} · ${item.title} · ${item.tokenCount} Token`, text: item.embeddingText })))
}

export function embeddingPreview(value: DualIndexEmbeddingResult): StagePreview {
  return stagePreview([
    { label: '向量', value: value.chunks.length + value.wikiNodes.length },
    { label: '维度', value: value.dimensions ?? '未提供' },
    { label: '模型', value: value.model ?? '未提供' },
    { label: '批次', value: value.batches.length },
  ])
}

export function storagePreview(value: VectorSnapshotInfo, vectorCount: number): StagePreview {
  return stagePreview([
    { label: '本次写入向量', value: vectorCount },
    { label: '全库 Chunk', value: value.chunks },
    { label: '全库 Wiki', value: value.wikiNodes },
    { label: '快照版本', value: value.revision },
  ])
}
