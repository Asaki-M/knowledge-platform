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

/** 标准 mdast 的前序遍历；结构错误由调用能力转换为自己的 AppError。 */
export function visitMarkdown(node: Root | RootContent, callback: (node: Root | RootContent) => void): void {
  if (!node || typeof node.type !== 'string')
    throw new TypeError('Invalid Markdown node')
  callback(node)
  if ('children' in node) {
    if (!Array.isArray(node.children))
      throw new TypeError('Invalid Markdown children')
    for (const child of node.children)
      visitMarkdown(child, callback)
  }
}
