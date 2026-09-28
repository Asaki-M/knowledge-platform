import type { DocumentSection } from './types.js'
import { SECTION_SPLIT_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { contentHash } from '../content-hash.js'
import { plainText, renderMarkdown } from '../markdown.js'

/** 绝对行号、路径、顺序不是内容；本节原始片段和补入定义仍参与失效判断。 */
export function sectionRevision(section: DocumentSection): string {
  return contentHash({
    documentId: section.documentId,
    title: section.title,
    documentTitle: section.documentTitle,
    headingPath: section.headingPath,
    metadata: section.metadata,
    markdown: section.markdown,
    sources: section.sourceFragments.map(item => item.text),
    references: section.referenceSources.map(item => item.source.text),
  })
}

/** 下游统一拒绝内容被改写却未重新分节的快照。 */
export function assertSection(section: DocumentSection): void {
  try {
    if (!section || !isNonEmptyString(section.id) || !isNonEmptyString(section.documentId)
      || (section.sourcePath !== null && typeof section.sourcePath !== 'string')
      || section.ast?.type !== 'root' || renderMarkdown(section.ast) !== section.markdown
      || !Number.isInteger(section.depth) || section.depth < 0 || section.depth > 3
      || section.revision !== sectionRevision(section)) {
      throw new Error('Invalid section')
    }
    const current = section.headingPath.at(-1)
    const parent = section.headingPath.at(-2)
    if (section.headingPath.some((heading, index) => !isNonEmptyString(heading.sectionId)
      || typeof heading.title !== 'string' || !Number.isInteger(heading.depth) || heading.depth < 1 || heading.depth > 3
      || (index > 0 && section.headingPath[index - 1].depth >= heading.depth))) {
      throw new Error('Invalid heading path')
    }
    const heading = section.ast.children.find(node => node.type === 'heading' && node.depth <= 3)
    if (section.depth === 0 ? heading !== undefined : heading?.type !== 'heading' || heading.depth !== section.depth || plainText(heading) !== section.title)
      throw new Error('Heading differs from source content')
    if (section.depth === 0
      ? section.title !== null || section.parentId !== null || section.headingPath.length !== 0
      : current?.sectionId !== section.id || current.title !== section.title || current.depth !== section.depth || (parent?.sectionId ?? null) !== section.parentId) {
      throw new Error('Invalid section hierarchy')
    }
  }
  catch {
    throw new AppError(CODES.INVALID_DOCUMENT, 'Section content, identity or revision is invalid')
  }
}
