import type { Paragraph, RootContent } from 'mdast'
import type { WikiCitation, WikiEdge, WikiNode } from '../types.js'
import { renderMarkdown } from '../../markdown.js'

/** 每条知识紧邻自己的引用；模型文本作为纯文本转义，不成为 Markdown 指令。 */
export function renderWikiNode(node: Omit<WikiNode, 'markdown'>, edges: WikiEdge[]): string {
  const paragraph = (value: string): Paragraph => ({ type: 'paragraph', children: [{ type: 'text', value }] })
  const children: RootContent[] = [{ type: 'heading', depth: 1, children: [{ type: 'text', value: node.title }] }]
  const citations = (sources: WikiCitation[]): RootContent[] => sources.flatMap(source => [
    paragraph(`来源：${source.documentId} · ${source.sourcePath ?? '未提供路径'} · ${source.headingPath.map(item => item.title).join(' / ') || '前言'}；Section：${source.sectionId}；版本：${source.sectionRevision}`),
    ...source.evidence.map(value => ({ type: 'blockquote' as const, children: [paragraph(value)] })),
  ])
  const group = (title: string, blocks: RootContent[]) => {
    if (blocks.length)
      children.push({ type: 'heading', depth: 2, children: [{ type: 'text', value: title }] }, ...blocks)
  }
  group('描述与证据', node.descriptions.flatMap(item => [paragraph(`${item.name}${item.type ? `（${item.type}）` : ''}：${item.description}${item.aliases.length ? `；别名：${item.aliases.join('、')}` : ''}`), ...citations(item.citations)]))
  group('事实与证据', node.facts.flatMap(item => [paragraph(item.statement), ...citations(item.citations)]))
  group('关系与证据', edges.flatMap(item => [paragraph(`${item.sourceId} → ${item.targetId}（${item.type}）：${item.description}`), ...citations(item.citations)]))
  return renderMarkdown({ type: 'root', children })
}
