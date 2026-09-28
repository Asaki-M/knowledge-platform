import type { KnowledgeEnrichment } from './types.js'
import { ENRICHMENT_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString, isRecord } from '../../utils/type-guards.js'

function invalid(path: string): never {
  // path 仅由本文件中的固定字段名组成，不拼接模型返回值或解析器错误正文。
  throw new AppError(ENRICHMENT_ERROR_CODES.INVALID_OUTPUT, `Invalid enrichment output at ${path}`)
}

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value))
    invalid(path)
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    invalid(path)
  return value
}

function text(value: unknown, path: string): string {
  if (!isNonEmptyString(value) || value.length > 4000)
    invalid(path)
  return value.trim()
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100)
    invalid(path)
  return value
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map(item => text(item, path))
}

/** 严格校验结构、已配置分类、实体引用和逐字证据；不尝试修复或补齐模型缺失字段。 */
export function parseEnrichment(output: string, markdown: string, knowledgeTypes: Readonly<Record<string, string>>): KnowledgeEnrichment {
  if (typeof output !== 'string' || output.length > 200000)
    invalid('JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  }
  catch {
    invalid('JSON')
  }
  const root = object(parsed, 'root', ['summary', 'keywords', 'aliases', 'questions', 'entities', 'concepts', 'relations', 'facts', 'knowledgeType'])
  const evidence = (value: unknown): string[] => {
    const quotes = strings(value, 'evidence')
    if (!quotes.length || quotes.length > 10 || quotes.some(quote => !markdown.includes(quote)))
      invalid('evidence')
    return quotes
  }
  const entities = array(root.entities, 'entities').map((value) => {
    const item = object(value, 'entities', ['id', 'name', 'type', 'aliases', 'description', 'evidence'])
    const id = text(item.id, 'entities.id')
    if (!/^[\w-]{1,80}$/.test(id))
      invalid('entities.id')
    return { id, name: text(item.name, 'entities.name'), type: text(item.type, 'entities.type'), aliases: strings(item.aliases, 'entities.aliases'), description: text(item.description, 'entities.description'), evidence: evidence(item.evidence) }
  })
  const concepts = array(root.concepts, 'concepts').map((value) => {
    const item = object(value, 'concepts', ['id', 'name', 'aliases', 'description', 'evidence'])
    const id = text(item.id, 'concepts.id')
    if (!/^[\w-]{1,80}$/.test(id))
      invalid('concepts.id')
    return { id, name: text(item.name, 'concepts.name'), aliases: strings(item.aliases, 'concepts.aliases'), description: text(item.description, 'concepts.description'), evidence: evidence(item.evidence) }
  })
  const nodes = [...entities, ...concepts]
  const nodeIds = new Set(nodes.map(node => node.id))
  if (nodeIds.size !== nodes.length)
    invalid('nodes.id')
  const nodeId = (value: unknown): string => {
    const id = text(value, 'node reference')
    if (!nodeIds.has(id))
      invalid('node reference')
    return id
  }
  const relations = array(root.relations, 'relations').map((value) => {
    const item = object(value, 'relations', ['sourceId', 'targetId', 'type', 'description', 'evidence'])
    return { sourceId: nodeId(item.sourceId), targetId: nodeId(item.targetId), type: text(item.type, 'relations.type'), description: text(item.description, 'relations.description'), evidence: evidence(item.evidence) }
  })
  const facts = array(root.facts, 'facts').map((value) => {
    const item = object(value, 'facts', ['statement', 'nodeIds', 'evidence'])
    return { statement: text(item.statement, 'facts.statement'), nodeIds: strings(item.nodeIds, 'facts.nodeIds').map(nodeId), evidence: evidence(item.evidence) }
  })
  const knowledgeType = text(root.knowledgeType, 'knowledgeType')
  if (!Object.hasOwn(knowledgeTypes, knowledgeType))
    invalid('knowledgeType')

  return {
    summary: text(root.summary, 'summary'),
    keywords: strings(root.keywords, 'keywords'),
    aliases: strings(root.aliases, 'aliases'),
    questions: strings(root.questions, 'questions'),
    concepts,
    entities,
    relations,
    facts,
    knowledgeType,
  }
}
