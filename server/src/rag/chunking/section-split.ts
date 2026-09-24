import type { Heading, Root } from 'mdast'
import type { NormalizedDocument } from '../normalization/types.js'
import type { DocumentSection, SectionHeading } from './types.js'
import { SECTION_SPLIT_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { plainText, renderMarkdown } from '../markdown.js'
import { indexDefinitions, withReferences } from './references.js'

/** 只依据标准 AST 的顶层标题切分，列表、引用、代码、表格内部的标题不产生章节。 */
export function splitSections(document: NormalizedDocument): DocumentSection[] {
  if (!document || document.schemaVersion !== 1 || typeof document.source?.id !== 'string' || !document.source.id.trim() || document.ast?.type !== 'root' || !Array.isArray(document.ast.children))
    throw new AppError(SECTION_SPLIT_ERROR_CODES.INVALID_DOCUMENT, 'A normalized document with a source ID and root AST is required')

  try {
    const blocks = document.ast.children
    const definitions = indexDefinitions(document.ast)
    const sections: DocumentSection[] = []
    const path: SectionHeading[] = []
    let start = 0

    const emit = (end: number) => {
      if (start === end)
        return
      const ownBlocks = blocks.slice(start, end)
      const first = ownBlocks[0]
      const heading: Heading | undefined = first.type === 'heading' ? first : undefined
      const index = sections.length
      const id = `${document.source.id}#section-${index}`
      const title = heading ? plainText(heading) : null
      const depth = heading?.depth ?? 0

      // 同级或更浅标题关闭当前路径；父节只持有自己的正文，避免递归复制子节内容。
      while (path.length && path[path.length - 1].depth >= depth)
        path.pop()
      const parentId = path.at(-1)?.sectionId ?? null
      if (heading)
        path.push({ sectionId: id, title: title!, depth: heading.depth })

      const firstPosition = first.position
      const lastPosition = ownBlocks.at(-1)?.position
      const position = firstPosition && lastPosition
        ? structuredClone({ start: firstPosition.start, end: lastPosition.end })
        : undefined
      // 克隆每节及补入的定义，后续知识补充修改某节时不影响原文或其他 section。
      const ast: Root = structuredClone({ type: 'root', children: withReferences(ownBlocks, definitions), position })
      sections.push({
        id,
        source: { ...document.source },
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
      })
      start = end
    }

    for (let index = 0; index < blocks.length; index++) {
      const node = blocks[index]
      if (node.type === 'heading') {
        if (!Number.isInteger(node.depth) || node.depth < 1 || node.depth > 6)
          throw new AppError(SECTION_SPLIT_ERROR_CODES.INVALID_DOCUMENT, 'Heading depth must be between 1 and 6')
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
