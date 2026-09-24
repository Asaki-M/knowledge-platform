import type { Root, RootContent } from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'

/** Normalization 和 Section Split 共用输出规则，避免后续阶段依赖某个文档适配器。 */
export function renderMarkdown(ast: Root): string {
  return toMarkdown(ast, { extensions: [gfmToMarkdown()], bullet: '-', fences: true })
}

/** 通用 mdast 纯文本投影；代码内部的空格和换行保持原样。 */
export function plainText(node: Root | RootContent): string {
  if (node.type === 'definition')
    return ''
  if (node.type === 'image' || node.type === 'imageReference')
    return node.alt ?? ''
  if (node.type === 'break')
    return '\n'
  if ('value' in node)
    return node.value
  if ('children' in node) {
    const separator = node.type === 'tableRow' ? '\t' : ['root', 'blockquote', 'list', 'listItem', 'table', 'footnoteDefinition'].includes(node.type) ? '\n\n' : ''
    return node.children.map(child => plainText(child)).join(separator)
  }
  return ''
}
