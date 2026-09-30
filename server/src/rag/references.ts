import type { Definition, FootnoteDefinition, Root, RootContent } from 'mdast'
import { visitMarkdown } from './markdown.js'

type ReferenceDefinition = Definition | FootnoteDefinition

/** Markdown 引用标识符忽略大小写，多个空白与单个空格等价。 */
export function referenceIdentifier(identifier: string): string {
  return identifier.replace(/\s+/g, ' ').trim().toUpperCase()
}

function key(type: ReferenceDefinition['type'], identifier: string): string {
  return `${type}:${referenceIdentifier(identifier)}`
}

/** 文档只索引一次，保持 Markdown 首个同名定义生效的语义。 */
export function indexDefinitions(ast: Root): Map<string, ReferenceDefinition> {
  const definitions = new Map<string, ReferenceDefinition>()
  visitMarkdown(ast, (node) => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const id = key(node.type, node.identifier)
      if (!definitions.has(id))
        definitions.set(id, node)
    }
  })
  return definitions
}

/** 给每节补齐用到的跨节引用，包含脚注内的引用；已访问集合防止循环脚注无限展开。 */
export function withReferences(children: RootContent[], definitions: Map<string, ReferenceDefinition>): RootContent[] {
  const result = [...children]
  const available = new Map<string, ReferenceDefinition>()
  const ast: Root = { type: 'root', children }
  visitMarkdown(ast, (node) => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const id = key(node.type, node.identifier)
      if (!available.has(id))
        available.set(id, node)
    }
  })
  const visited = new Set<string>()
  const collect = (node: Root | RootContent) => {
    let id: string | undefined
    if (node.type === 'linkReference' || node.type === 'imageReference')
      id = key('definition', node.identifier)
    else if (node.type === 'footnoteReference')
      id = key('footnoteDefinition', node.identifier)
    if (!id || visited.has(id))
      return
    visited.add(id)
    const definition = definitions.get(id)
    if (!definition)
      return // 未定义的引用沿用输入语义，不在 Split 阶段猜测链接。
    if (available.get(id) !== definition) {
      // 放在其他同名定义之前，避免截取后较晚的定义意外覆盖原文首个定义。
      if (available.has(id))
        result.unshift(definition)
      else
        result.push(definition)
      available.set(id, definition)
    }
    visitMarkdown(definition, collect)
  }
  visitMarkdown(ast, collect)
  return result
}
