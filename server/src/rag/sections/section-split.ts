import type { Heading, Root, RootContent } from 'mdast'
import type { NormalizedDocument } from '../normalization/types.js'
import type { DocumentSection, SectionHeading } from './types.js'
import { SECTION_SPLIT_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { contentHash } from '../content-hash.js'
import { plainText, renderMarkdown } from '../markdown.js'
import { sourceFragment } from '../normalization/source.js'
import { indexDefinitions, withReferences } from '../references.js'
import { sectionRevision } from './revision.js'

/** 只依据标准 AST 的顶层标题切分，列表、引用、代码、表格内部的标题不产生章节。 */
export function splitSections(document: NormalizedDocument): DocumentSection[] {
  if (!document || document.schemaVersion !== 2 || !isNonEmptyString(document.source?.id) || document.ast?.type !== 'root' || !Array.isArray(document.ast.children) || typeof document.originalContent !== 'string' || !Array.isArray(document.blockSources) || document.blockSources.length !== document.ast.children.length)
    throw new AppError(SECTION_SPLIT_ERROR_CODES.INVALID_DOCUMENT, 'A normalized document with a source ID and root AST is required')

  try {
    const blocks = document.ast.children
    const definitions = indexDefinitions(document.ast)
    const contains = (root: RootContent, target: RootContent): boolean => root === target || ('children' in root && root.children.some(child => contains(child, target)))
    const sections: DocumentSection[] = []
    const path: SectionHeading[] = []
    const occurrences = new Map<string, number>()
    let start = 0

    const emit = (end: number) => {
      if (start === end)
        return
      const ownBlocks = blocks.slice(start, end)
      const first = ownBlocks[0]
      const heading = first.type === 'heading' && first.depth <= 3 ? first as Heading & { depth: 1 | 2 | 3 } : undefined
      const index = sections.length
      const title = heading ? plainText(heading) : null
      const depth = heading?.depth ?? 0

      // 同级或更浅标题关闭当前路径；父节只持有自己的正文，避免递归复制子节内容。
      while (path.length && path[path.length - 1].depth >= depth)
        path.pop()
      const parentId = path.at(-1)?.sectionId ?? null
      const identity = JSON.stringify([parentId, depth, title])
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      const id = `section-${contentHash([document.source.id, path.map(item => item.sectionId), depth, title, occurrence])}`
      if (heading)
        path.push({ sectionId: id, title: title!, depth: heading.depth })

      const firstPosition = first.position
      const lastPosition = ownBlocks.at(-1)?.position
      const position = firstPosition && lastPosition
        ? structuredClone({ start: firstPosition.start, end: lastPosition.end })
        : undefined
      // 克隆每节及补入的定义，后续知识补充修改某节时不影响原文或其他 section。
      const children = withReferences(ownBlocks, definitions)
      const ast: Root = structuredClone({ type: 'root', children, position })
      const section: DocumentSection = {
        id,
        documentId: document.source.id,
        sourcePath: document.source.path ?? null,
        revision: '',
        sourceFragments: structuredClone(document.blockSources.slice(start, end)),
        referenceSources: children.flatMap((node, blockIndex) => {
          if (ownBlocks.includes(node))
            return []
          const documentBlockIndex = blocks.findIndex(block => contains(block, node))
          return [{ blockIndex, documentBlockIndex, source: sourceFragment(node, document.originalContent) }]
        }),
        documentTitle: document.title,
        metadata: structuredClone(document.metadata),
        index,
        title,
        depth,
        parentId,
        headingPath: path.map(item => ({ ...item })),
        blockRange: { start, end },
        position,
        ast,
        markdown: renderMarkdown(ast),
        // 补齐脚注是为独立解释引用；其文本不重复拼进多节正文。
        text: plainText({ type: 'root', children: ownBlocks }).trim(),
      }
      section.revision = sectionRevision(section)
      sections.push(section)
      start = end
    }

    for (let index = 0; index < blocks.length; index++) {
      const node = blocks[index]
      if (node.type === 'heading') {
        if (!Number.isInteger(node.depth) || node.depth < 1 || node.depth > 6)
          throw new AppError(SECTION_SPLIT_ERROR_CODES.INVALID_DOCUMENT, 'Heading depth must be between 1 and 6')
        if (node.depth <= 3)
          emit(index)
      }
    }
    emit(blocks.length)
    return sections
  }
  catch (error) {
    if (error instanceof AppError)
      throw error
    // 不把序列化器的异常片段或文档正文透出给调用方。
    throw new AppError(SECTION_SPLIT_ERROR_CODES.INVALID_DOCUMENT, 'Could not split the normalized document AST')
  }
}
