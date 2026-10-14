import type { WikiBuildResult, WikiCitation, WikiNode, WikiSectionContribution } from '../wiki/types.js'
import type { IndexBuildInput, IndexBuildResult, IndexDocument, IndexSource } from './types.js'
import { INDEXING_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { indexId, sortedUnique, textRevision } from './text.js'

const invalid = () => new AppError(CODES.INVALID_INPUT, 'Indexing requires unique, consistent current source snapshots')
const hasUniqueNonEmptyIds = (values: readonly string[]) => values.every(isNonEmptyString) && new Set(values).size === values.length
const hasSameIds = (a: readonly string[], b: readonly string[]) => JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b))

function isValidSource(source: IndexSource): boolean {
  return !!source && [source.documentId, source.sectionId, source.sectionRevision].every(isNonEmptyString)
    && (source.sourcePath === null || typeof source.sourcePath === 'string')
    && Array.isArray(source.headingPath) && source.headingPath.every(item =>
    item && isNonEmptyString(item.title) && isNonEmptyString(item.sectionId) && [1, 2, 3].includes(item.depth),
  )
}

interface WikiSourceIndex {
  nodes: Map<string, WikiNode>
  links: Map<string, WikiBuildResult['sectionLinks'][number]>
  contributions: Map<string, WikiSectionContribution>
}

function validateBuildStructure(input: IndexBuildInput): void {
  const { chunks, wiki } = input
  if (!Array.isArray(chunks) || !wiki || wiki.schemaVersion !== 2 || !isNonEmptyString(wiki.knowledgeBaseId)
    || ![wiki.nodes, wiki.edges, wiki.sectionLinks, wiki.contributions, wiki.pendingSections].every(Array.isArray)) {
    throw invalid()
  }
}

function validateUniqueBuildIds({ chunks, wiki }: IndexBuildInput): void {
  if (!hasUniqueNonEmptyIds(chunks.map(item => item.id)) || !hasUniqueNonEmptyIds(wiki.nodes.map(item => item.id))
    || !hasUniqueNonEmptyIds(wiki.edges.map(item => item.id)) || !hasUniqueNonEmptyIds(wiki.sectionLinks.map(item => item.sectionId))
    || !hasUniqueNonEmptyIds(wiki.contributions.map(item => item.sectionId)) || !hasUniqueNonEmptyIds(wiki.pendingSections.map(item => item.sectionId))) {
    throw invalid()
  }
}

function validateChunkSources(chunks: IndexBuildInput['chunks']): void {
  for (const chunk of chunks) {
    if (!isValidSource(chunk) || !isNonEmptyString(chunk.markdown)
      || (chunk.documentTitle !== null && typeof chunk.documentTitle !== 'string')) {
      throw invalid()
    }
  }
}

/** pending 节不得沿用旧贡献；关联节必须拥有同版本的来源与节点。 */
function validateSectionLinks(wiki: WikiBuildResult, index: WikiSourceIndex): void {
  const { nodes, links, contributions } = index
  if (!hasSameIds([...links.keys()], [...contributions.keys()]))
    throw invalid()
  for (const item of wiki.pendingSections) {
    if (!isNonEmptyString(item.sectionRevision) || links.has(item.sectionId))
      throw invalid()
  }
  for (const link of wiki.sectionLinks) {
    const contribution = contributions.get(link.sectionId)!
    if (!isValidSource(contribution) || link.sectionRevision !== contribution.sectionRevision
      || !Array.isArray(link.nodeIds) || !hasUniqueNonEmptyIds(link.nodeIds) || link.nodeIds.some(id => !nodes.has(id))) {
      throw invalid()
    }
  }
}

function validateCitations(citations: WikiCitation[], nodeIds: string[], index: WikiSourceIndex): void {
  const { links, contributions } = index
  if (!Array.isArray(citations) || !citations.length)
    throw invalid()
  for (const citation of citations) {
    const contribution = contributions.get(citation.sectionId)
    if (!isValidSource(citation) || !contribution || citation.sectionRevision !== contribution.sectionRevision
      || citation.documentId !== contribution.documentId || !Array.isArray(citation.evidence)
      || !citation.evidence.length || !citation.evidence.every(isNonEmptyString)
      || nodeIds.some(id => !links.get(citation.sectionId)!.nodeIds.includes(id))) {
      throw invalid()
    }
  }
}

function validateWikiNodes(wiki: WikiBuildResult, index: WikiSourceIndex): void {
  const { nodes } = index
  for (const node of wiki.nodes) {
    if (!isNonEmptyString(node.title) || !isNonEmptyString(node.revision) || !['entity', 'concept'].includes(node.kind)
      || !Array.isArray(node.descriptions) || !node.descriptions.length || !Array.isArray(node.facts)
      || !Array.isArray(node.sectionIds) || !hasUniqueNonEmptyIds(node.sectionIds) || !Array.isArray(node.relationIds) || !hasUniqueNonEmptyIds(node.relationIds)) {
      throw invalid()
    }
    for (const item of node.descriptions) {
      if (![item.name, item.description].every(isNonEmptyString) || !Array.isArray(item.aliases)
        || !item.aliases.every(isNonEmptyString) || (item.type !== null && !isNonEmptyString(item.type))) {
        throw invalid()
      }
      validateCitations(item.citations, [node.id], index)
    }
    for (const fact of node.facts) {
      if (!isNonEmptyString(fact.statement) || !Array.isArray(fact.nodeIds) || !fact.nodeIds.includes(node.id) || fact.nodeIds.some(id => !nodes.has(id)))
        throw invalid()
      validateCitations(fact.citations, fact.nodeIds, index)
    }
    if (!hasSameIds(node.sectionIds, node.descriptions.flatMap(item => item.citations.map(citation => citation.sectionId)))
      || !hasSameIds(node.sectionIds, wiki.sectionLinks.filter(link => link.nodeIds.includes(node.id)).map(link => link.sectionId))
      || !hasSameIds(node.relationIds, wiki.edges.filter(edge => edge.sourceId === node.id || edge.targetId === node.id).map(edge => edge.id))) {
      throw invalid()
    }
  }
}

function validateWikiEdges(wiki: WikiBuildResult, index: WikiSourceIndex): void {
  const { nodes } = index
  for (const edge of wiki.edges) {
    if (![edge.revision, edge.type, edge.description].every(isNonEmptyString) || !nodes.has(edge.sourceId) || !nodes.has(edge.targetId))
      throw invalid()
    validateCitations(edge.citations, [edge.sourceId, edge.targetId], index)
  }
}

/** 在组合边界拒绝悬空关联、重复身份及 pending 旧贡献，避免生成貌似可用的错误索引。 */
export function validateBuildInput(input: IndexBuildInput): void {
  try {
    validateBuildStructure(input)
    validateUniqueBuildIds(input)
    const { chunks, wiki } = input
    const index: WikiSourceIndex = {
      nodes: new Map(wiki.nodes.map(node => [node.id, node])),
      links: new Map(wiki.sectionLinks.map(link => [link.sectionId, link])),
      contributions: new Map(wiki.contributions.map(item => [item.sectionId, item])),
    }
    validateChunkSources(chunks)
    validateSectionLinks(wiki, index)
    validateWikiNodes(wiki, index)
    validateWikiEdges(wiki, index)
  }
  catch {
    // 外层统一转换错误，保持组合边界原来的错误码与安全文案。
    throw invalid()
  }
}

/** 异步调用前检查文本指纹与命名空间，防止构造结果被改写后仍使用旧版本。 */
export function validateDocuments(result: IndexBuildResult): void {
  try {
    if (!result || result.schemaVersion !== 1 || result.templateVersion !== 1 || !isNonEmptyString(result.knowledgeBaseId)
      || !Array.isArray(result.chunks) || !Array.isArray(result.wikiNodes)
      || !Number.isSafeInteger(result.maxTokens) || result.maxTokens <= 0) {
      throw invalid()
    }
    validateIndexRecords(result.chunks, result.wikiNodes, result.knowledgeBaseId, result.maxTokens)
  }
  catch {
    throw invalid()
  }
}

function validateRecordIdentity(item: IndexDocument, kind: IndexDocument['kind'], knowledgeBaseId: string): void {
  if (item.kind !== kind || item.knowledgeBaseId !== knowledgeBaseId || !isNonEmptyString(item.sourceId)
    || !isNonEmptyString(item.sourceRevision) || item.id !== indexId(knowledgeBaseId, kind, item.sourceId)) {
    throw invalid()
  }
}

function validateRecordText(item: IndexDocument, maxTokens: number): void {
  if (typeof item.title !== 'string' || !isNonEmptyString(item.embeddingText)
    || item.textRevision !== textRevision(item.embeddingText)
    || !Number.isSafeInteger(item.tokenCount) || item.tokenCount < 0 || item.tokenCount > maxTokens) {
    throw invalid()
  }
}

function validateRecordSources(item: IndexDocument): void {
  if (!Array.isArray(item.sources) || !item.sources.length || !item.sources.every(isValidSource)
    || !Array.isArray(item.wikiNodes) || item.wikiNodes.some(node => !isNonEmptyString(node.id) || !isNonEmptyString(node.revision))
    || !['ready', 'pending', 'unavailable'].includes(item.knowledgeStatus)) {
    throw invalid()
  }
}

/** 索引产物与持久化边界共用记录校验，无需伪造构建结果的外层字段。 */
export function validateIndexRecords(chunks: readonly IndexDocument[], wikiNodes: readonly IndexDocument[], knowledgeBaseId: string, maxTokens = Number.MAX_SAFE_INTEGER): void {
  try {
    if (!isNonEmptyString(knowledgeBaseId) || !Array.isArray(chunks) || !Array.isArray(wikiNodes)
      || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || !hasUniqueNonEmptyIds([...chunks, ...wikiNodes].map(item => item.id))) {
      throw invalid()
    }
    for (const [kind, documents] of [['chunk', chunks], ['wiki', wikiNodes]] as const) {
      const records: readonly IndexDocument[] = documents
      for (const item of records) {
        validateRecordIdentity(item, kind, knowledgeBaseId)
        validateRecordText(item, maxTokens)
        validateRecordSources(item)
      }
    }
  }
  catch {
    throw invalid()
  }
}
