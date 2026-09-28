import type { WikiBuildOptions, WikiBuildResult, WikiCitation, WikiDescription, WikiEdge, WikiFact, WikiNode, WikiNodeKind, WikiSectionContribution } from '../types.js'
import { WIKI_ERROR_CODES as CODES } from '../../../error-codes.js'
import { AppError } from '../../../errors.js'
import { isNonEmptyString } from '../../../utils/type-guards.js'
import { contentHash } from '../../content-hash.js'
import { renderWikiNode } from './markdown.js'

const invalid = () => new AppError(CODES.INVALID_MAPPING, 'Wiki identity mappings must reference current compatible nodes')
const sorted = (values: readonly string[]) => [...new Set(values)].sort()
const order = <T>(values: T[]): T[] => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

/** 合并同一主张的来源；引用仍按 section 隔离，不能把多节证据混成一条。 */
function aggregate<T extends { citations: WikiCitation[] }>(values: T[]): T[] {
  const groups = new Map<string, T>()
  for (const value of values) {
    const { citations, ...claim } = value
    const key = contentHash(claim)
    const previous = groups.get(key)
    if (previous) {
      for (const citation of citations) {
        const source = previous.citations.find(item => item.sectionId === citation.sectionId)
        if (source)
          source.evidence = sorted([...source.evidence, ...citation.evidence])
        else
          previous.citations.push(structuredClone(citation))
      }
    }
    else {
      groups.set(key, structuredClone(value))
    }
  }
  return order([...groups.values()].map(value => ({ ...value, citations: order(value.citations) })))
}

/** 构建引用索引后按节点收集贡献；未变化的节点复用页面快照，不重新渲染。 */
export function assembleWiki(contributions: WikiSectionContribution[], options: WikiBuildOptions, pendingSections: WikiBuildResult['pendingSections'], previous?: WikiBuildResult): WikiBuildResult {
  if (!options || !isNonEmptyString(options.knowledgeBaseId) || !Array.isArray(options.canonicalNodes) || !Array.isArray(options.mappings))
    throw invalid()
  if (options.canonicalNodes.some(node => !node) || options.mappings.some(mapping => !mapping))
    throw invalid()
  contributions = [...contributions].sort((a, b) => a.sectionId.localeCompare(b.sectionId))
  const canonical = new Map(options.canonicalNodes.map(node => [node.id, node]))
  if (canonical.size !== options.canonicalNodes.length || options.canonicalNodes.some(node => !isNonEmptyString(node.id) || !isNonEmptyString(node.title) || !['entity', 'concept'].includes(node.kind)))
    throw invalid()
  const sections = new Map(contributions.map(item => [item.sectionId, item]))
  const mappings = new Map<string, string>()
  for (const mapping of options.mappings) {
    const section = sections.get(mapping.sectionId)
    const key = JSON.stringify([mapping.sectionId, mapping.localNodeId])
    const target = canonical.get(mapping.canonicalId)
    const entity = section?.knowledge.entities.find(item => item.id === mapping.localNodeId)
    const concept = section?.knowledge.concepts.find(item => item.id === mapping.localNodeId)
    if (!section || section.sectionRevision !== mapping.sectionRevision || mappings.has(key) || !target
      || (!entity && !concept) || target.kind !== (entity ? 'entity' : 'concept')) {
      throw invalid()
    }
    mappings.set(key, mapping.canonicalId)
  }
  const buckets = new Map<string, { id: string, canonicalId: string | null, kind: WikiNodeKind, title: string, descriptions: WikiDescription[], facts: WikiFact[], sectionIds: string[] }>()
  const edgeItems: WikiEdge[] = []
  const sectionLinks: WikiBuildResult['sectionLinks'] = []
  for (const section of contributions) {
    const ids = new Map<string, string>()
    const citation = (evidence: string[]): WikiCitation => ({
      documentId: section.documentId,
      sectionId: section.sectionId,
      sectionRevision: section.sectionRevision,
      sourcePath: section.sourcePath,
      headingPath: structuredClone(section.headingPath),
      evidence: sorted(evidence),
      generation: structuredClone(section.generation),
    })
    const locals = [
      ...section.knowledge.entities.map(item => ({ ...item, kind: 'entity' as const })),
      ...section.knowledge.concepts.map(item => ({ ...item, kind: 'concept' as const, type: null })),
    ]
    for (const local of locals) {
      const canonicalId = mappings.get(JSON.stringify([section.sectionId, local.id])) ?? null
      const id = `wiki-node-${contentHash([options.knowledgeBaseId, canonicalId === null ? ['local', section.sectionId, section.sectionRevision, local.id] : ['canonical', canonicalId]])}`
      ids.set(local.id, id)
      const bucket: NonNullable<ReturnType<typeof buckets.get>> = buckets.get(id) ?? { id, canonicalId, kind: local.kind, title: canonicalId === null ? local.name : canonical.get(canonicalId)!.title, descriptions: [], facts: [], sectionIds: [] }
      bucket.sectionIds.push(section.sectionId)
      bucket.descriptions.push({ name: local.name, type: local.type, aliases: sorted(local.aliases), description: local.description, citations: [citation(local.evidence)] })
      buckets.set(id, bucket)
    }
    for (const fact of section.knowledge.facts) {
      const nodeIds = sorted(fact.nodeIds.map(id => ids.get(id)!))
      const contribution = { statement: fact.statement, nodeIds, citations: [citation(fact.evidence)] }
      for (const id of nodeIds)
        buckets.get(id)!.facts.push(contribution)
    }
    for (const relation of section.knowledge.relations) {
      const sourceId = ids.get(relation.sourceId)!
      const targetId = ids.get(relation.targetId)!
      const id = `wiki-edge-${contentHash([sourceId, targetId, relation.type, relation.description])}`
      edgeItems.push({ id, revision: '', sourceId, targetId, type: relation.type, description: relation.description, citations: [citation(relation.evidence)] })
    }
    sectionLinks.push({ sectionId: section.sectionId, sectionRevision: section.sectionRevision, nodeIds: sorted([...ids.values()]) })
  }
  // 关系也按各自贡献版本复用，避免一次章节更新重建所有关系的证据集合。
  const edgeGroups = new Map<string, WikiEdge[]>()
  for (const item of edgeItems) {
    const group = edgeGroups.get(item.id) ?? []
    group.push(item)
    edgeGroups.set(item.id, group)
  }
  const oldEdges = new Map(previous?.edges.map(edge => [edge.id, edge]))
  const edges = [...edgeGroups].map(([id, items]) => {
    const revision = contentHash(order(items))
    const old = oldEdges.get(id)
    return old?.revision === revision ? structuredClone(old) : { ...aggregate(items)[0], revision }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const oldNodes = new Map(previous?.nodes.map(node => [node.id, node]))
  const nodes: WikiNode[] = []
  for (const bucket of buckets.values()) {
    const relations = edges.filter(edge => edge.sourceId === bucket.id || edge.targetId === bucket.id)
    // 先比较该节点的原始贡献，未受影响的节点不再聚合事实或渲染页面。
    const revision = contentHash([{ ...bucket, sectionIds: sorted(bucket.sectionIds), descriptions: order(bucket.descriptions), facts: order(bucket.facts) }, relations])
    const old = oldNodes.get(bucket.id)
    if (old?.revision === revision) {
      nodes.push(structuredClone(old))
      continue
    }
    const node = { ...bucket, revision, sectionIds: sorted(bucket.sectionIds), descriptions: aggregate(bucket.descriptions), facts: aggregate(bucket.facts), relationIds: relations.map(edge => edge.id) }
    nodes.push({ ...node, markdown: renderWikiNode(node, relations) })
  }
  return structuredClone({ schemaVersion: 2, knowledgeBaseId: options.knowledgeBaseId, nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)), edges, sectionLinks: sectionLinks.sort((a, b) => a.sectionId.localeCompare(b.sectionId)), contributions: contributions.sort((a, b) => a.sectionId.localeCompare(b.sectionId)), pendingSections: [...pendingSections].sort((a, b) => a.sectionId.localeCompare(b.sectionId)) })
}
