import type { WikiDescription, WikiEdge, WikiNode } from '../wiki/types.js'
import { contentHash } from '../content-hash.js'

/** 排序去重只处理语义条目，不改写 chunk 原文内部的空白、代码和表格。 */
export const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort()

export function describeNode(node: WikiNode, descriptions: readonly WikiDescription[]): string {
  const names = sortedUnique(descriptions.flatMap(item => [item.name, ...item.aliases]).filter(name => name !== node.title))
  return [
    `${node.kind === 'entity' ? '实体' : '概念'}：${node.title}`,
    ...(names.length ? [`别名：${names.join('、')}`] : []),
    ...sortedUnique(descriptions.map(item => `${item.type ? `${item.type}：` : ''}${item.description}`)),
  ].join('\n')
}

/** 关系使用可读名称及方向，向量文本不掺入哈希 ID 或来源定位信息。 */
export function describeRelations(edges: readonly WikiEdge[], nodes: ReadonlyMap<string, WikiNode>): string[] {
  return sortedUnique(edges.map(edge => `${nodes.get(edge.sourceId)!.title} → ${nodes.get(edge.targetId)!.title}（${edge.type}）：${edge.description}`))
}

export const indexId = (knowledgeBaseId: string, kind: 'chunk' | 'wiki', sourceId: string) => `index-${contentHash([knowledgeBaseId, kind, sourceId])}`
export const textRevision = (embeddingText: string) => contentHash([1, embeddingText])
