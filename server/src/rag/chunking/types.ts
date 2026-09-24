import type { Heading, Root } from 'mdast'
import type { Position } from 'unist'
import type { EnrichedSection } from '../enrichment/types.js'
import type { DocumentSource, NormalizedDocument } from '../normalization/types.js'

export interface SectionHeading {
  sectionId: string
  title: string
  depth: Heading['depth']
}

/** 按文档顺序排列的 section；后续知识补充和 Chunk Build 使用此结构。 */
export interface DocumentSection {
  /** 同一文档、同一顺序下可复现；插入/删除章节后序号可能变化，不是内容哈希。 */
  id: string
  source: DocumentSource
  documentTitle: string | null
  /** 原文 frontmatter 的独立副本，供后续规则提取使用，不由模型推断。 */
  metadata: NormalizedDocument['metadata']
  /** 从 0 开始的文档内顺序。 */
  index: number
  /** 无标题的前言为 null，depth 为 0；不伪造标题节点。 */
  title: string | null
  depth: 0 | Heading['depth']
  parentId: string | null
  /** 从祖先标题到当前标题；跳级时不补造缺失的层级。 */
  headingPath: SectionHeading[]
  /** 本节拥有的原文顶层块区间，[start, end)，不包含补入的跨节引用定义。 */
  blockRange: { start: number, end: number }
  /** 本节原文范围；缺少端点位置时不推测，补入的引用定义不扩大此范围。 */
  position?: Position
  /** 包含本节标题与正文，以及独立使用所需的链接/图片/脚注定义。 */
  ast: Root
  markdown: string
  text: string
}

export interface ChunkBuildOptions {
  /** 完整 chunk Markdown 的预算，包括本节标题、表头、代码围栏和引用定义。默认 800。 */
  maxTokens?: number
  /** 相邻 chunk 尾部完整片段的重叠预算，默认 0；无法容纳时减少，不跨 section。 */
  overlapTokens?: number
  /** 不可再拆的超长内容默认保留并标记；error 模式让整次构建失败。 */
  oversized?: 'keep' | 'error'
  /** 可传目标模型的计数函数；默认 cl100k_base，函数须同步、确定且无副作用。 */
  countTokens?: (text: string) => number
}

export interface ChunkPartRange {
  /** text 是原段落纯文本的 UTF-16 偏移；其他项是从 0 开始的行/数据行/列表项索引。 */
  kind: 'text' | 'lines' | 'rows' | 'items'
  start: number
  end: number
}

export interface ChunkPart {
  /** 在输入 section.ast.children 中的索引，不是文档全局块索引。 */
  blockIndex: number
  partIndex: number
  partCount: number
  /** true 表示从上一 chunk 重复带入的上下文，不属于本 chunk 新内容。 */
  overlap: boolean
  range?: ChunkPartRange
  /** 原始完整块的范围；细分片段用 range 定位，不伪造精确行列。 */
  position?: Position
}

export interface DocumentChunk {
  id: string
  sectionId: string
  index: number
  source: DocumentSource
  documentTitle: string | null
  headingPath: SectionHeading[]
  parts: ChunkPart[]
  ast: Root
  markdown: string
  text: string
  tokenCount: number
  oversized: boolean
}

export interface ChunkBuildResult {
  schemaVersion: 1
  sectionId: string
  /** 补充信息只存一份，作用域仍是 section，不伪装成每个 chunk 的局部事实。 */
  sectionEnrichment: EnrichedSection
  tokenizer: 'cl100k_base' | 'custom'
  maxTokens: number
  overlapTokens: number
  chunks: DocumentChunk[]
}
