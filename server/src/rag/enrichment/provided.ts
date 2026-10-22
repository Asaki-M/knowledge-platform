import type { DocumentSection } from '../sections/types.js'
import type { EnrichedSection, KnowledgeEnrichment } from './types.js'
import { z } from 'zod'
import { ENRICHMENT_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { contentHash } from '../content-hash.js'
import { deduplicateExtracted } from './deduplication.js'
import { extractSectionData } from './extraction.js'
import { DEFAULT_KNOWLEDGE_TYPES } from './knowledge-types.js'
import { createEnrichmentSchema } from './schema.js'
import { parseEnrichment } from './validation.js'

const identifier = z.string().trim().min(1).max(256)
const providedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.strictObject({ provider: identifier, model: identifier }),
  sections: z.array(z.strictObject({
    sectionId: identifier,
    sectionRevision: identifier,
    enrichment: createEnrichmentSchema(DEFAULT_KNOWLEDGE_TYPES),
  })).min(1).max(100),
})

/** 外部提取结果仍绑定完整 Section 快照，不能只传摘要或替代原始正文。 */
export type ProvidedEnrichment = z.infer<typeof providedSchema>

export function parseProvidedEnrichment(value: unknown): ProvidedEnrichment {
  const result = providedSchema.safeParse(value)
  if (!result.success)
    throw new AppError(CODES.INVALID_INPUT, '外部知识提取结果的结构或来源无效。')
  return result.data
}

function validateProvidedKnowledge(value: KnowledgeEnrichment, section: DocumentSection) {
  try {
    return parseEnrichment(JSON.stringify(value), section.markdown, DEFAULT_KNOWLEDGE_TYPES)
  }
  catch (error) {
    if (!(error instanceof AppError))
      throw error
    // 外部结果由调用方提供，校验失败是输入错误，不伪装成在线模型输出故障。
    throw new AppError(CODES.INVALID_INPUT, '外部知识提取结果未通过证据或引用校验。', {
      ...(error.validation ? { validation: { ...error.validation, sectionIndex: section.index } } : {}),
    })
  }
}

/** 所有节先通过证据和引用校验，再允许执行任何向量调用；缺节不回退到在线模型。 */
export function prepareProvidedEnrichment(value: ProvidedEnrichment, sections: DocumentSection[]) {
  const input = parseProvidedEnrichment(value)
  const supplied = new Map(input.sections.map(item => [item.sectionId, item]))
  if (supplied.size !== input.sections.length || supplied.size !== sections.length)
    throw new AppError(CODES.INVALID_INPUT, '外部知识提取结果必须逐节完整且不能重复。')
  const results = new Map<string, EnrichedSection>()
  for (const section of sections) {
    const item = supplied.get(section.id)
    if (!item || item.sectionRevision !== section.revision)
      throw new AppError(CODES.INVALID_INPUT, '外部知识提取结果与当前章节或正文版本不一致。')
    const enrichment = validateProvidedKnowledge(item.enrichment, section)
    results.set(section.id, {
      schemaVersion: 3,
      sectionId: section.id,
      documentId: section.documentId,
      sectionRevision: section.revision,
      extracted: deduplicateExtracted(extractSectionData(section)),
      enrichment,
      // 导入指纹用于追溯离线产物，不伪造供应商响应 ID 或 Token 用量。
      generation: { ...input.source, responseId: `provided:${contentHash([section.revision, enrichment])}`, usage: null },
    })
  }
  return (section: DocumentSection): EnrichedSection => {
    const result = results.get(section.id)
    if (!result || result.sectionRevision !== section.revision)
      throw new AppError(CODES.INVALID_INPUT, '外部知识提取结果与当前章节不一致。')
    return result
  }
}
