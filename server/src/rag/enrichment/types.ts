import type { LlmUsage } from '../../llm/types.js'
import type { NormalizedDocument } from '../normalization/types.js'
import type { SectionHeading } from '../sections/types.js'

/** 分类是可配置字典的 key，运行时校验是否已注册，不让模型自由创造分类。 */
export type KnowledgeType = string

export interface Concept {
  /** 仅在本节内唯一；跨节合并实体由后续 Wiki/KG 阶段处理。 */
  id: string
  name: string
  aliases: string[]
  description: string
  /** 来自本节 Markdown 的连续原文片段，不是模型改写的说明。 */
  evidence: string[]
}

export interface Entity extends Concept {
  type: string
}

export interface Relation {
  sourceId: string
  targetId: string
  type: string
  description: string
  evidence: string[]
}

export interface Fact {
  statement: string
  nodeIds: string[]
  evidence: string[]
}

export interface ExtractedCodeBlock {
  language: string | null
  meta: string | null
  /** 原样保留缩进、换行和大小写，不执行代码。 */
  code: string
}

export interface ExtractedLink {
  kind: 'link' | 'image'
  text: string
  /** 保留原始地址，包含相对路径、锚点和查询参数；不访问或推测绝对地址。 */
  url: string
  title: string | null
}

/** 由规则读取的结构化数据，与模型语义补充分开存储。 */
export interface ExtractedSectionData {
  title: string | null
  headingPath: SectionHeading[]
  metadata: NormalizedDocument['metadata']
  codeBlocks: ExtractedCodeBlock[]
  links: ExtractedLink[]
}

/** 模型仅补充语义字段，不返回规则已经确定的字段。 */
export interface KnowledgeEnrichment {
  summary: string
  keywords: string[]
  aliases: string[]
  questions: string[]
  entities: Entity[]
  concepts: Concept[]
  relations: Relation[]
  facts: Fact[]
  knowledgeType: KnowledgeType
}

export interface EnrichmentOptions {
  provider: string
  model: string
  /** 在默认字典上增加或覆盖分类说明，key 使用小写 kebab-case。 */
  knowledgeTypes?: Readonly<Record<string, string>>
  maxOutputTokens?: number
  /** 完整用户消息的字符上限，默认 60000；不是 Token 数，不静默截断正文。 */
  maxInputCharacters?: number
}

/** 与 section 通过 ID 关联，不覆盖原文，也不将模型输出冒充原始文档事实。 */
export interface EnrichedSection {
  /** v3 支持有证据的概念和实体统一引用，并绑定输入内容版本。 */
  schemaVersion: 3
  sectionId: string
  documentId: string
  sectionRevision: string
  extracted: ExtractedSectionData
  enrichment: KnowledgeEnrichment
  generation: {
    provider: string
    model: string
    responseId: string
    requestId?: string
    usage: LlmUsage | null
  }
}
