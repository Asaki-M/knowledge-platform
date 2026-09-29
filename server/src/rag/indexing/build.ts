import type { WikiCitation } from '../wiki/types.js'
import type { IndexBuildInput, IndexBuildOptions, IndexBuildResult, IndexDocument, IndexSource } from './types.js'
import { INDEXING_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { countChunkTokens } from '../chunking/tokens.js'
import { describeNode, describeRelations, indexId, sortedUnique, textRevision } from './text.js'
import { validateBuildInput } from './validation.js'

/** 独立的纯函数组合层；不让 Chunk、Wiki 或 Embedding SDK 互相依赖。 */
export function buildIndexDocuments(input: IndexBuildInput, options: IndexBuildOptions = {}): IndexBuildResult {
  const maxTokens = options.maxTokens ?? 8000
  const countTokens = options.countTokens ?? countChunkTokens
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || typeof countTokens !== 'function')
    throw new AppError(CODES.INVALID_OPTIONS, 'A positive token budget and token counter are required')
  validateBuildInput(input)
  const { wiki, chunks } = input
  const nodes = new Map(wiki.nodes.map(node => [node.id, node]))
  const links = new Map(wiki.sectionLinks.map(link => [link.sectionId, link]))
  const pending = new Map(wiki.pendingSections.map(section => [section.sectionId, section.sectionRevision]))
  const contributions = new Map(wiki.contributions.map(item => [item.sectionId, item]))
  const source = (citation: IndexSource): IndexSource => ({
    documentId: citation.documentId,
    sectionId: citation.sectionId,
    sectionRevision: citation.sectionRevision,
    sourcePath: citation.sourcePath,
    headingPath: structuredClone(citation.headingPath),
  })
  const sources = (citations: WikiCitation[]): IndexSource[] => [...new Map(citations.map(item => [item.sectionId, source(item)])).values()].sort((a, b) => a.sectionId.localeCompare(b.sectionId))
  const make = (document: Omit<IndexDocument, 'id' | 'knowledgeBaseId' | 'textRevision' | 'tokenCount'>): IndexDocument => {
    let tokenCount: number
    try {
      tokenCount = countTokens(document.embeddingText)
      if (!Number.isSafeInteger(tokenCount) || tokenCount < 0)
        throw new Error('Invalid token count')
    }
    catch {
      throw new AppError(CODES.TOKEN_COUNT_FAILED, 'Embedding text token counting failed')
    }
    if (tokenCount > maxTokens)
      throw new AppError(CODES.INPUT_TOO_LARGE, 'Complete embedding text exceeds the configured token budget')
    return { ...document, id: indexId(wiki.knowledgeBaseId, document.kind, document.sourceId), knowledgeBaseId: wiki.knowledgeBaseId, textRevision: textRevision(document.embeddingText), tokenCount }
  }

  const chunkDocuments = chunks.map((chunk) => {
    const link = links.get(chunk.sectionId)
    const waiting = pending.get(chunk.sectionId)
    const contribution = contributions.get(chunk.sectionId)
    if ((link && (link.sectionRevision !== chunk.sectionRevision || contribution?.documentId !== chunk.documentId))
      || (waiting !== undefined && waiting !== chunk.sectionRevision)) {
      throw new AppError(CODES.STALE_SOURCE, 'Chunk and Wiki must refer to the same current section revision')
    }
    // 只选本节的描述贡献；共享 Wiki 节点在其他节的事实不复制进当前 chunk。
    const related = (link?.nodeIds ?? []).map(id => nodes.get(id)!).sort((a, b) => a.id.localeCompare(b.id))
    const knowledge = sortedUnique(related.map(node => describeNode(node, node.descriptions.filter(item => item.citations.some(citation => citation.sectionId === chunk.sectionId)))))
    const heading = chunk.headingPath.map(item => item.title).join(' / ')
    const title = chunk.documentTitle ?? heading
    const text = [
      ...(isNonEmptyString(chunk.documentTitle) ? [`文档：${chunk.documentTitle}`] : []),
      ...(heading ? [`章节：${heading}`] : []),
      `原文：\n${chunk.markdown}`,
      ...(knowledge.length ? [`本节知识信息：\n${knowledge.join('\n\n')}`] : []),
    ].join('\n\n')
    return make({
      kind: 'chunk',
      sourceId: chunk.id,
      sourceRevision: chunk.sectionRevision,
      title,
      embeddingText: text,
      sources: [source(chunk)],
      wikiNodes: related.map(node => ({ id: node.id, revision: node.revision })),
      knowledgeStatus: link ? 'ready' : waiting !== undefined ? 'pending' : 'unavailable',
    })
  })
  const wikiDocuments = wiki.nodes.map((node) => {
    const edges = wiki.edges.filter(edge => edge.sourceId === node.id || edge.targetId === node.id)
    const facts = sortedUnique(node.facts.map(fact => fact.statement))
    const relations = describeRelations(edges, nodes)
    return make({
      kind: 'wiki',
      sourceId: node.id,
      sourceRevision: node.revision,
      title: node.title,
      embeddingText: [
        describeNode(node, node.descriptions),
        ...(facts.length ? [`事实：\n${facts.join('\n')}`] : []),
        ...(relations.length ? [`关系：\n${relations.join('\n')}`] : []),
      ].join('\n\n'),
      sources: sources([...node.descriptions.flatMap(item => item.citations), ...node.facts.flatMap(item => item.citations), ...edges.flatMap(edge => edge.citations)]),
      wikiNodes: [{ id: node.id, revision: node.revision }],
      knowledgeStatus: 'ready',
    })
  })
  return { schemaVersion: 1, templateVersion: 1, knowledgeBaseId: wiki.knowledgeBaseId, tokenizer: options.countTokens ? 'custom' : 'cl100k_base', maxTokens, chunks: chunkDocuments, wikiNodes: wikiDocuments }
}
