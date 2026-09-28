import type { Root } from 'mdast'
import type { Position } from 'unist'
import type { SectionHeading } from '../sections/types.js'

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
  documentId: string
  sectionRevision: string
  /** 同一 section 内的顺序关联，不跨节猜测相邻 chunk。 */
  previousChunkId: string | null
  nextChunkId: string | null
  index: number
  sourcePath: string | null
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
  schemaVersion: 3
  sectionId: string
  documentId: string
  sectionRevision: string
  tokenizer: 'cl100k_base' | 'custom'
  maxTokens: number
  overlapTokens: number
  chunks: DocumentChunk[]
}
