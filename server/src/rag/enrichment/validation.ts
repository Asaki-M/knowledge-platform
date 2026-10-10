import type { z } from 'zod'
import type { ValidationReason } from '../../errors.js'
import type { KnowledgeEnrichment } from './types.js'
import { ENRICHMENT_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { deduplicateEnrichment } from './deduplication.js'
import { createEnrichmentSchema } from './schema.js'

function invalid(path: string, reason: ValidationReason): never {
  // 路径仅由固定字段和数组序号组成，诊断不能拼接模型返回值或解析器正文。
  throw new AppError(ENRICHMENT_ERROR_CODES.INVALID_OUTPUT, `Invalid enrichment output at ${path}`, { validation: { path, reason } })
}

function issuePath(parts: readonly PropertyKey[]): string {
  return parts.reduce<string>((path, part) => typeof part === 'number' ? `${path}[${part}]` : `${path ? `${path}.` : ''}${String(part)}`, '') || 'root'
}

/** 只转换规则代码和固定路径，不把 Zod 原始错误消息、输入或任意未知键传到 HTTP/日志。 */
function invalidSchema(issue: z.core.$ZodIssue, parsed: unknown): never {
  let path = issuePath(issue.path)
  if (issue.code === 'unrecognized_keys') {
    const known = issue.keys.find(key => ['id', 'name', 'type', 'aliases', 'description', 'evidence', 'sourceId', 'targetId', 'statement', 'nodeIds'].includes(key))
    if (known && path !== 'root')
      path = `${path}.${known}`
    invalid(path, 'unexpected-field')
  }
  if (issue.code === 'invalid_type') {
    const value = issue.path.reduce<unknown>((current, part) => current && typeof current === 'object' ? Reflect.get(current, part) : undefined, parsed)
    if (value === undefined && issue.path.length)
      invalid(path, 'missing-field')
    invalid(path, issue.expected === 'object' ? 'invalid-object' : issue.expected === 'array' ? 'invalid-array' : 'invalid-text')
  }
  if (issue.code === 'too_big')
    invalid(path, issue.origin === 'string' ? 'text-too-long' : 'too-many-items')
  if (issue.code === 'too_small')
    invalid(path, issue.origin === 'array' ? 'empty-evidence' : 'invalid-text')
  if (issue.code === 'invalid_format')
    invalid(path, 'invalid-id')
  if (issue.code === 'invalid_value')
    invalid(path, 'unsupported-value')
  invalid(path, 'invalid-object')
}

/** 先严格 Zod 校验，再检查引用和逐字证据；不修复、补字段或删除未知字段。 */
export function parseEnrichment(output: string, markdown: string, knowledgeTypes: Readonly<Record<string, string>>): KnowledgeEnrichment {
  if (typeof output !== 'string')
    invalid('JSON', 'invalid-json')
  if (output.length > 200000)
    invalid('JSON', 'text-too-long')
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  }
  catch {
    invalid('JSON', 'invalid-json')
  }
  return finalizeEnrichment(parsed, markdown, knowledgeTypes)
}

/** 对象入口直接检查字段和证据，不经 JSON 往返隐式丢弃未知字段。 */
export function validateEnrichment(parsed: unknown, markdown: string, knowledgeTypes: Readonly<Record<string, string>>): KnowledgeEnrichment {
  const result = createEnrichmentSchema(knowledgeTypes).safeParse(parsed)
  if (!result.success)
    invalidSchema(result.error.issues[0]!, parsed)
  const value = result.data
  if (JSON.stringify(value).length > 200000)
    invalid('JSON', 'text-too-long')
  const evidence = (quotes: string[], path: string) => {
    const unmatched = quotes.findIndex(quote => !markdown.includes(quote))
    if (unmatched !== -1)
      invalid(`${path}[${unmatched}]`, 'evidence-not-found')
  }
  const nodeIds = new Set<string>()
  for (const [key, nodes] of [['entities', value.entities], ['concepts', value.concepts]] as const) {
    for (const [index, node] of nodes.entries()) {
      const path = `${key}[${index}]`
      if (nodeIds.has(node.id))
        invalid(`${path}.id`, 'duplicate-id')
      nodeIds.add(node.id)
      evidence(node.evidence, `${path}.evidence`)
    }
  }
  const nodeId = (id: string, path: string) => {
    if (!nodeIds.has(id))
      invalid(path, 'unknown-reference')
  }
  for (const [index, relation] of value.relations.entries()) {
    const path = `relations[${index}]`
    nodeId(relation.sourceId, `${path}.sourceId`)
    nodeId(relation.targetId, `${path}.targetId`)
    evidence(relation.evidence, `${path}.evidence`)
  }
  for (const [index, fact] of value.facts.entries()) {
    const path = `facts[${index}]`
    fact.nodeIds.forEach((id, nodeIndex) => nodeId(id, `${path}.nodeIds[${nodeIndex}]`))
    evidence(fact.evidence, `${path}.evidence`)
  }
  return value
}

/** 先校验再合并，合并后复查证据数量和引用，提取与 Wiki 共用同一流程。 */
export function finalizeEnrichment(input: unknown, markdown: string, knowledgeTypes: Readonly<Record<string, string>>): KnowledgeEnrichment {
  const validated = validateEnrichment(input, markdown, knowledgeTypes)
  return validateEnrichment(deduplicateEnrichment(validated), markdown, knowledgeTypes)
}
