import type { Root } from 'mdast'
import type { Position } from 'unist'
import type { NormalizedDocument, SourceFragment } from '../normalization/types.js'

export interface SectionHeading {
  sectionId: string
  title: string
  depth: 1 | 2 | 3
}

/** 按文档顺序排列的 section；后续知识补充和 Chunk Build 使用此结构。 */
export interface DocumentSection {
  /** 按文档、标题路径与同父级重名序号生成；改名或换父级视为替换。 */
  id: string
  documentId: string
  sourcePath: string | null
  revision: string
  sourceFragments: SourceFragment[]
  referenceSources: { blockIndex: number, documentBlockIndex: number, source: SourceFragment }[]
  documentTitle: string | null
  /** 原文 frontmatter 的独立副本，供后续规则提取使用，不由模型推断。 */
  metadata: NormalizedDocument['metadata']
  /** 从 0 开始的文档内顺序。 */
  index: number
  /** 无标题的前言为 null，depth 为 0；不伪造标题节点。 */
  title: string | null
  depth: 0 | 1 | 2 | 3
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
