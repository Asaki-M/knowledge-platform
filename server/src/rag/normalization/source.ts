import type { RootContent } from 'mdast'
import type { Position } from 'unist'
import type { SourceFragment } from './types.js'

/** 标准化产生的新容器没有精确范围时，仅返回其子节点的原文包围范围。 */
export function sourceFragment(node: RootContent, content: string): SourceFragment {
  const positions: Position[] = []
  const visit = (item: RootContent) => {
    if (item.position)
      positions.push(item.position)
    else if ('children' in item)
      item.children.forEach(visit)
  }
  visit(node)
  const usable = positions.filter(position => Number.isSafeInteger(position.start.offset) && Number.isSafeInteger(position.end.offset)
    && position.start.offset! >= 0 && position.end.offset! >= position.start.offset! && position.end.offset! <= content.length)
  if (!usable.length)
    return { text: null, exact: false }
  const start = usable.reduce((a, b) => a.start.offset! < b.start.offset! ? a : b).start
  const end = usable.reduce((a, b) => a.end.offset! > b.end.offset! ? a : b).end
  return { text: content.slice(start.offset, end.offset), position: structuredClone({ start, end }), exact: !!node.position && usable.length === 1 }
}
