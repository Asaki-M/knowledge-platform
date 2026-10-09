import type { LlmJsonValue, LlmStructuredOutput } from '../../llm/types.js'
import { z } from 'zod'

// 先检查原字符串长度再去掉首尾空白，保持已有文本与逐字证据校验语义。
const text = z.string().max(4000).trim().min(1)
const texts = z.array(text).max(100)
const evidence = z.array(text).min(1).max(10)
const node = {
  id: text.regex(/^[\w-]{1,80}$/),
  name: text,
  aliases: texts,
  description: text,
  evidence,
}

// strictObject 必须拒绝未知字段，不能使用默认 object 行为悄悄删除字段。
export const conceptSchema = z.strictObject(node)
export const entitySchema = z.strictObject({ ...node, type: text })
export const relationSchema = z.strictObject({ sourceId: text, targetId: text, type: text, description: text, evidence })
export const factSchema = z.strictObject({ statement: text, nodeIds: texts, evidence })

/** Zod 是结构、类型、长度与分类的统一契约；引用和证据匹配由 validation 继续检查。 */
export function createEnrichmentSchema(knowledgeTypes: Readonly<Record<string, string>>) {
  return z.strictObject({
    summary: text,
    keywords: texts,
    aliases: texts,
    questions: texts,
    entities: z.array(entitySchema).max(100),
    concepts: z.array(conceptSchema).max(100),
    relations: z.array(relationSchema).max(100),
    facts: z.array(factSchema).max(100),
    knowledgeType: text.pipe(z.enum(Object.keys(knowledgeTypes))),
  })
}

/** 将同一契约投影为模型支持的 JSON Schema；本地 Zod 仍执行全部限制。 */
export function buildEnrichmentSchema(knowledgeTypes: Readonly<Record<string, string>>): LlmStructuredOutput {
  const schema = z.toJSONSchema(createEnrichmentSchema(knowledgeTypes), {
    target: 'draft-07',
    override: ({ jsonSchema }) => {
      // 供应商支持的长度/正则关键字不一致，请求仅使用公共结构子集，不削弱本地校验。
      for (const key of ['minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'] as const)
        delete jsonSchema[key]
    },
  })
  delete schema.$schema
  return { name: 'knowledge_enrichment', schema: schema as Record<string, LlmJsonValue> }
}
