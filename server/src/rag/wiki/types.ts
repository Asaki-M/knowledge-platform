import type { EnrichedSection, KnowledgeEnrichment } from '../enrichment/types.js'
import type { DocumentSection, SectionHeading } from '../sections/types.js'

export type WikiNodeKind = 'entity' | 'concept'
export interface WikiBuildInput {
  section: DocumentSection
  enrichedSection: EnrichedSection
}

export interface CanonicalNode {
  id: string
  kind: WikiNodeKind
  title: string
}

export interface WikiIdentityMapping {
  sectionId: string
  sectionRevision: string
  localNodeId: string
  canonicalId: string
}

/** 每次传入当前有效的完整映射；不凭名称推断跨节身份。 */
export interface WikiBuildOptions {
  knowledgeBaseId: string
  canonicalNodes: readonly CanonicalNode[]
  mappings: readonly WikiIdentityMapping[]
}

export interface WikiCitation {
  documentId: string
  sectionId: string
  sectionRevision: string
  sourcePath: string | null
  headingPath: SectionHeading[]
  evidence: string[]
  generation: EnrichedSection['generation']
}

/** 保存各节的独立贡献，撤销某节时不损伤其他来源；不复制完整原文。 */
export interface WikiSectionContribution {
  documentId: string
  sectionId: string
  sectionRevision: string
  sourcePath: string | null
  headingPath: SectionHeading[]
  generation: EnrichedSection['generation']
  knowledge: Pick<KnowledgeEnrichment, 'entities' | 'concepts' | 'relations' | 'facts'>
}

export interface WikiDescription {
  name: string
  type: string | null
  aliases: string[]
  description: string
  citations: WikiCitation[]
}

export interface WikiFact {
  statement: string
  nodeIds: string[]
  citations: WikiCitation[]
}

export interface WikiEdge {
  id: string
  revision: string
  sourceId: string
  targetId: string
  type: string
  description: string
  citations: WikiCitation[]
}

export interface WikiNode {
  id: string
  canonicalId: string | null
  kind: WikiNodeKind
  title: string
  revision: string
  sectionIds: string[]
  descriptions: WikiDescription[]
  facts: WikiFact[]
  relationIds: string[]
  markdown: string
}

export interface WikiBuildResult {
  schemaVersion: 2
  knowledgeBaseId: string
  nodes: WikiNode[]
  edges: WikiEdge[]
  sectionLinks: { sectionId: string, sectionRevision: string, nodeIds: string[] }[]
  contributions: WikiSectionContribution[]
  /** 已撤销旧贡献，等待新 enrichment 的 section。 */
  pendingSections: { sectionId: string, sectionRevision: string }[]
}

export interface WikiUpdate {
  inputs: readonly WikiBuildInput[]
  removedSectionIds: readonly string[]
  /** 有新原文但尚无提取结果的章节，不能继续展示旧贡献。 */
  pendingSections?: readonly DocumentSection[]
  /** 内容未变，仅刷新路径、标题位置等来源信息，不调用模型。 */
  sourceUpdates?: readonly DocumentSection[]
}
