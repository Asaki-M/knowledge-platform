import type { PhrasingContent, RootContent } from 'mdast'

import { plainText } from '../../../markdown.js'

const inlineTypes = new Set(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link', 'linkReference', 'image', 'imageReference', 'footnoteReference'])

/** JSX flow 容器可能混有文本与块节点，把相邻行内节点组成合法段落。 */
export function asBlocks(nodes: RootContent[]): RootContent[] {
  const result: RootContent[] = []
  let pending: PhrasingContent[] = []
  const flush = () => {
    if (pending.length) {
      result.push({ type: 'paragraph', children: pending })
      pending = []
    }
  }
  for (const node of nodes) {
    if (inlineTypes.has(node.type)) {
      pending.push(node as PhrasingContent)
    }
    else {
      flush()
      result.push(node)
    }
  }
  flush()
  return result
}

export function asInline(nodes: RootContent[]): PhrasingContent[] {
  return nodes.flatMap((node): PhrasingContent[] => {
    if (inlineTypes.has(node.type))
      return [node as PhrasingContent]
    if (node.type === 'paragraph')
      return node.children
    return [{ type: 'text', value: plainText(node) }]
  })
}
