import type { PhrasingContent, RootContent } from 'mdast'
import type { ChunkPartRange } from './types.js'
import { plainText } from '../markdown.js'

type Fits = (node: RootContent) => boolean
interface BlockFragment {
  node: RootContent
  range?: ChunkPartRange
}

/** 合并相邻单元；单个不可拆单元仍保留，是否报错由上层 oversized 策略决定。 */
function pack<T>(items: T[], make: (items: T[], start: number) => RootContent, fits: Fits): { node: RootContent, start: number, end: number }[] {
  const result: { node: RootContent, start: number, end: number }[] = []
  let start = 0
  let group: T[] = []
  for (let index = 0; index < items.length; index++) {
    if (group.length && !fits(make([...group, items[index]], start))) {
      result.push({ node: make(group, start), start, end: index })
      start = index
      group = []
    }
    group.push(items[index])
  }
  if (group.length)
    result.push({ node: make(group, start), start, end: items.length })
  return result
}

/** 按完整字素切分，避免拆坏 emoji/组合字符；优先在已容纳片段后半部的句界或空白处结束。 */
function splitText(value: string, fits: (text: string) => boolean): string[] {
  const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), item => item.segment)
  const result: string[] = []
  let start = 0
  while (start < characters.length) {
    if (fits(characters.slice(start).join(''))) {
      result.push(characters.slice(start).join(''))
      break
    }
    let low = 1
    let high = characters.length - start
    let length = 0
    // Token 数不保证严格单调；这里只选择实际检查过可容纳的前缀，不承诺最大装箱率。
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (fits(characters.slice(start, start + middle).join(''))) {
        length = middle
        low = middle + 1
      }
      else {
        high = middle - 1
      }
    }
    if (!length) {
      result.push(characters.slice(start).join(''))
      break
    }
    for (let boundary = length; boundary >= Math.ceil(length / 2); boundary--) {
      if (/[\s。！？.!?;；]$/u.test(characters[start + boundary - 1]) && fits(characters.slice(start, start + boundary).join(''))) {
        length = boundary
        break
      }
    }
    result.push(characters.slice(start, start + length).join(''))
    start += length
  }
  return result
}

function splitInline(node: PhrasingContent, fits: (node: PhrasingContent) => boolean): PhrasingContent[] {
  if (fits(node))
    return [node]
  if (node.type === 'text')
    return splitText(node.value, value => fits({ type: 'text', value })).map(value => ({ type: 'text', value }))
  if (node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') {
    const atoms = node.children.flatMap(child => splitInline(child, part => fits({ ...node, children: [part] })))
    return pack(atoms, children => ({ ...node, children }), item => fits(item as PhrasingContent)).map(item => item.node as PhrasingContent)
  }
  // 链接、图片、行内代码等保留完整语义，不把 URL 或代码拆成无法使用的片段。
  return [node]
}

/** 按 AST 结构拆分超长块，不退化成对 Markdown 字符串直接截断。 */
export function fragmentBlock(node: RootContent, fits: Fits): BlockFragment[] {
  if (fits(node))
    return [{ node }]
  if (node.type === 'paragraph') {
    const atoms = node.children.flatMap(child => splitInline(child, part => fits({ ...node, children: [part] })))
    let offset = 0
    return pack(atoms, children => ({ ...node, children }), fits).map(({ node: part }) => {
      const start = offset
      offset += plainText(part).length
      return { node: part, range: { kind: 'text', start, end: offset } }
    })
  }
  if (node.type === 'code') {
    return pack(node.value.split('\n'), lines => ({ ...node, value: lines.join('\n') }), fits)
      .map(({ node: part, start, end }) => ({ node: part, range: { kind: 'lines', start, end } }))
  }
  if (node.type === 'table' && node.children.length > 1) {
    const header = node.children[0]
    return pack(node.children.slice(1), rows => ({ ...node, children: [header, ...rows] }), fits)
      .map(({ node: part, start, end }) => ({ node: part, range: { kind: 'rows', start, end } }))
  }
  if (node.type === 'list') {
    return pack(node.children, (children, start) => ({ ...node, children, start: node.ordered ? (node.start ?? 1) + start : node.start }), fits)
      .map(({ node: part, start, end }) => ({ node: part, range: { kind: 'items', start, end } }))
  }
  // 引用块、单个超长表格行/列表项等不强行破坏结构，上层会标明超限。
  return [{ node }]
}
