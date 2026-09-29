import type { WikiCitation } from '../wiki/types.js'
import type { IndexBuildInput, IndexBuildResult, IndexSource } from './types.js'
import { INDEXING_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { indexId, sortedUnique, textRevision } from './text.js'

const invalid = () => new AppError(CODES.INVALID_INPUT, 'Indexing requires unique, consistent current source snapshots')
const unique = (values: readonly string[]) => values.every(isNonEmptyString) && new Set(values).size === values.length
const sameIds = (a: readonly string[], b: readonly string[]) => JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b))

function validSource(source: IndexSource): boolean {
  return !!source && [source.documentId, source.sectionId, source.sectionRevision].every(isNonEmptyString)
    && (source.sourcePath === null || typeof source.sourcePath === 'string')
    && Array.isArray(source.headingPath) && source.headingPath.every(item => item && isNonEmptyString(item.title) && isNonEmptyString(item.sectionId) && [1, 2, 3].includes(item.depth))
}

/** 在组合边界拒绝悬空关联、重复身份及 pending 旧贡献，避免生成貌似可用的错误索引。 */
export function validateBuildInput(input: IndexBuildInput): void {
  try {
    const { chunks, wiki } = input
    if (!Array.isArray(chunks) || !wiki || wiki.schemaVersion !== 2 || !isNonEmptyString(wiki.knowledgeBaseId)
      || ![wiki.nodes, wiki.edges, wiki.sectionLinks, wiki.contributions, wiki.pendingSections].every(Array.isArray)
      || !unique(chunks.map(item => item.id)) || !unique(wiki.nodes.map(item => item.id))
      || !unique(wiki.edges.map(item => item.id)) || !unique(wiki.sectionLinks.map(item => item.sectionId))
      || !unique(wiki.contributions.map(item => item.sectionId)) || !unique(wiki.pendingSections.map(item => item.sectionId))) {
      throw invalid()
    }
    const nodes = new Map(wiki.nodes.map(node => [node.id, node]))
    const links = new Map(wiki.sectionLinks.map(link => [link.sectionId, link]))
    const contributions = new Map(wiki.contributions.map(item => [item.sectionId, item]))
    for (const chunk of chunks) {
      if (!validSource(chunk) || !isNonEmptyString(chunk.markdown)
        || (chunk.documentTitle !== null && typeof chunk.documentTitle !== 'string')) {
        throw invalid()
      }
    }
    if (!sameIds([...links.keys()], [...contributions.keys()]))
      throw invalid()
    for (const item of wiki.pendingSections) {
      if (!isNonEmptyString(item.sectionRevision) || links.has(item.sectionId))
        throw invalid()
    }
    for (const link of wiki.sectionLinks) {
      const contribution = contributions.get(link.sectionId)!
      if (!validSource(contribution) || link.sectionRevision !== contribution.sectionRevision
        || !Array.isArray(link.nodeIds) || !unique(link.nodeIds) || link.nodeIds.some(id => !nodes.has(id))) {
        throw invalid()
      }
    }
    const checkCitations = (citations: WikiCitation[], nodeIds: string[]) => {
      if (!Array.isArray(citations) || !citations.length)
        throw invalid()
      for (const citation of citations) {
        const contribution = contributions.get(citation.sectionId)
        if (!validSource(citation) || !contribution || citation.sectionRevision !== contribution.sectionRevision
          || citation.documentId !== contribution.documentId || !Array.isArray(citation.evidence)
          || !citation.evidence.length || !citation.evidence.every(isNonEmptyString)
          || nodeIds.some(id => !links.get(citation.sectionId)!.nodeIds.includes(id))) {
          throw invalid()
        }
      }
    }
    for (const node of wiki.nodes) {
      if (!isNonEmptyString(node.title) || !isNonEmptyString(node.revision) || !['entity', 'concept'].includes(node.kind)
        || !Array.isArray(node.descriptions) || !node.descriptions.length || !Array.isArray(node.facts)
        || !Array.isArray(node.sectionIds) || !unique(node.sectionIds) || !Array.isArray(node.relationIds) || !unique(node.relationIds)) {
        throw invalid()
      }
      for (const item of node.descriptions) {
        if (![item.name, item.description].every(isNonEmptyString) || !Array.isArray(item.aliases)
          || !item.aliases.every(isNonEmptyString) || (item.type !== null && !isNonEmptyString(item.type))) {
          throw invalid()
        }
        checkCitations(item.citations, [node.id])
      }
      for (const fact of node.facts) {
        if (!isNonEmptyString(fact.statement) || !Array.isArray(fact.nodeIds) || !fact.nodeIds.includes(node.id) || fact.nodeIds.some(id => !nodes.has(id)))
          throw invalid()
        checkCitations(fact.citations, fact.nodeIds)
      }
      if (!sameIds(node.sectionIds, node.descriptions.flatMap(item => item.citations.map(citation => citation.sectionId)))
        || !sameIds(node.sectionIds, wiki.sectionLinks.filter(link => link.nodeIds.includes(node.id)).map(link => link.sectionId))
        || !sameIds(node.relationIds, wiki.edges.filter(edge => edge.sourceId === node.id || edge.targetId === node.id).map(edge => edge.id))) {
        throw invalid()
      }
    }
    for (const edge of wiki.edges) {
      if (![edge.revision, edge.type, edge.description].every(isNonEmptyString) || !nodes.has(edge.sourceId) || !nodes.has(edge.targetId))
        throw invalid()
      checkCitations(edge.citations, [edge.sourceId, edge.targetId])
    }
  }
  catch {
    throw invalid()
  }
}

/** 异步调用前检查文本指纹与命名空间，防止构造结果被改写后仍使用旧版本。 */
export function validateDocuments(result: IndexBuildResult): void {
  try {
    if (!result || result.schemaVersion !== 1 || result.templateVersion !== 1 || !isNonEmptyString(result.knowledgeBaseId)
      || !Array.isArray(result.chunks) || !Array.isArray(result.wikiNodes)
      || !Number.isSafeInteger(result.maxTokens) || result.maxTokens <= 0
      || !unique([...result.chunks, ...result.wikiNodes].map(item => item.id))) {
      throw invalid()
    }
    for (const [kind, documents] of [['chunk', result.chunks], ['wiki', result.wikiNodes]] as const) {
      for (const item of documents) {
        if (item.kind !== kind || item.knowledgeBaseId !== result.knowledgeBaseId || !isNonEmptyString(item.sourceId)
          || !isNonEmptyString(item.sourceRevision) || typeof item.title !== 'string' || !isNonEmptyString(item.embeddingText)
          || item.id !== indexId(result.knowledgeBaseId, kind, item.sourceId) || item.textRevision !== textRevision(item.embeddingText)
          || !Number.isSafeInteger(item.tokenCount) || item.tokenCount < 0 || item.tokenCount > result.maxTokens
          || !Array.isArray(item.sources) || !item.sources.length || !item.sources.every(validSource)
          || !Array.isArray(item.wikiNodes) || item.wikiNodes.some(node => !isNonEmptyString(node.id) || !isNonEmptyString(node.revision))
          || !['ready', 'pending', 'unavailable'].includes(item.knowledgeStatus)) {
          throw invalid()
        }
      }
    }
  }
  catch {
    throw invalid()
  }
}
