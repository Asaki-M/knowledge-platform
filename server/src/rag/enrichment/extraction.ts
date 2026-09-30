import type { Definition } from 'mdast'
import type { MetadataValue } from '../normalization/types.js'
import type { DocumentSection } from '../sections/types.js'
import type { ExtractedSectionData } from './types.js'
import { ENRICHMENT_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isRecord } from '../../utils/type-guards.js'
import { plainText, visitMarkdown } from '../markdown.js'
import { referenceIdentifier } from '../references.js'

function invalid(): never {
  throw new AppError(CODES.INVALID_INPUT, 'Section requires valid AST, headings and JSON metadata')
}

/** 元数据只接受 JSON 值，拒绝循环引用和不可序列化值，不静默丢字段。 */
function validateMetadata(value: unknown, ancestors = new Set<object>()): value is MetadataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value))
    return false
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false
  ancestors.add(value)
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => validateMetadata(item, ancestors))
  ancestors.delete(value)
  return valid
}

const nullableText = (value: unknown) => value === undefined || value === null || typeof value === 'string'

/** 单节规则提取：只读标准 AST 与 Split 携带的 frontmatter，无模型、网络或代码执行。 */
export function extractSectionData(section: DocumentSection): ExtractedSectionData {
  try {
    if (!section || (section.title !== null && typeof section.title !== 'string')
      || !Array.isArray(section.headingPath) || section.headingPath.some(heading => !heading || typeof heading.sectionId !== 'string' || typeof heading.title !== 'string' || !Number.isInteger(heading.depth) || heading.depth < 1 || heading.depth > 3)
      || section.ast?.type !== 'root' || !Array.isArray(section.ast.children)
      || !isRecord(section.metadata) || !validateMetadata(section.metadata)) {
      invalid()
    }
    const result: ExtractedSectionData = {
      title: section.title,
      headingPath: structuredClone(section.headingPath),
      metadata: structuredClone(section.metadata),
      codeBlocks: [],
      links: [],
    }
    // 引用定义可能由 Split 从别节补入；Markdown 同名定义采用首次出现的值。
    const definitions = new Map<string, Definition>()
    visitMarkdown(section.ast, (node) => {
      if (node.type === 'definition' && !definitions.has(referenceIdentifier(node.identifier)))
        definitions.set(referenceIdentifier(node.identifier), node)
    })
    visitMarkdown(section.ast, (node) => {
      if (node.type === 'code') {
        if (typeof node.value !== 'string' || !nullableText(node.lang) || !nullableText(node.meta))
          invalid()
        result.codeBlocks.push({ language: node.lang ?? null, meta: node.meta ?? null, code: node.value })
      }
      if (node.type === 'link' || node.type === 'image' || node.type === 'linkReference' || node.type === 'imageReference') {
        const target = node.type === 'linkReference' || node.type === 'imageReference'
          ? definitions.get(referenceIdentifier(node.identifier))
          : node
        if (!target || typeof target.url !== 'string' || !nullableText(target.title))
          invalid()
        result.links.push({ kind: node.type === 'image' || node.type === 'imageReference' ? 'image' : 'link', text: plainText(node), url: target.url, title: target.title ?? null })
      }
    })
    return result
  }
  catch (error) {
    if (error instanceof AppError)
      throw error
    return invalid()
  }
}
