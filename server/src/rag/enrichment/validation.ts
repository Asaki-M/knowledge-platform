import type { KnowledgeEnrichment } from './types.js'
import { ENRICHMENT_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'

function invalid(path: string): never {
  // path 仅由本文件中的固定字段名组成，不拼接模型返回值或解析器错误正文。
  throw new AppError(ENRICHMENT_ERROR_CODES.INVALID_OUTPUT, `Invalid enrichment output at ${path}`)
}

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(path)
  const record = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key)))
    invalid(path)
  return record
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000)
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
  const entityIds = new Set(entities.map(entity => entity.id))
  if (entityIds.size !== entities.length)
    invalid('entities.id')
  const entityId = (value: unknown): string => {
    const id = text(value, 'entity reference')
    if (!entityIds.has(id))
      invalid('entity reference')
    return id
  }
  const relations = array(root.relations, 'relations').map((value) => {
    const item = object(value, 'relations', ['sourceId', 'targetId', 'type', 'description', 'evidence'])
    return { sourceId: entityId(item.sourceId), targetId: entityId(item.targetId), type: text(item.type, 'relations.type'), description: text(item.description, 'relations.description'), evidence: evidence(item.evidence) }
  })
  const facts = array(root.facts, 'facts').map((value) => {
    const item = object(value, 'facts', ['statement', 'entityIds', 'evidence'])
    return { statement: text(item.statement, 'facts.statement'), entityIds: strings(item.entityIds, 'facts.entityIds').map(entityId), evidence: evidence(item.evidence) }
  })
  const knowledgeType = text(root.knowledgeType, 'knowledgeType')
  if (!Object.hasOwn(knowledgeTypes, knowledgeType))
    invalid('knowledgeType')

  return {
    summary: text(root.summary, 'summary'),
    keywords: strings(root.keywords, 'keywords'),
    aliases: strings(root.aliases, 'aliases'),
    questions: strings(root.questions, 'questions'),
    concepts: strings(root.concepts, 'concepts'),
    entities,
    relations,
    facts,
    knowledgeType,
  }
}
