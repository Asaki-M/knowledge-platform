import type { LlmClient } from '../../llm/client.js'
import type { DocumentSection } from '../chunking/types.js'
import type { EnrichedSection, EnrichmentOptions } from './types.js'
import { ENRICHMENT_ERROR_CODES as CODES, LLM_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { deduplicateEnrichment, deduplicateExtracted } from './deduplication.js'
import { extractSectionData } from './extraction.js'
import { DEFAULT_KNOWLEDGE_TYPES } from './knowledge-types.js'
import { buildMessages } from './prompt.js'
import { parseEnrichment } from './validation.js'

/** 每次处理一个 section；模型调用和追踪复用 LlmClient，不另建供应商适配层。 */
export class KnowledgeEnricher {
  private readonly options: Required<Omit<EnrichmentOptions, 'knowledgeTypes'>>
  private readonly knowledgeTypes: Readonly<Record<string, string>>

  constructor(private readonly llm: LlmClient, options: EnrichmentOptions) {
    if (!options || typeof options.provider !== 'string' || !options.provider.trim() || typeof options.model !== 'string' || !options.model.trim())
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Enrichment provider and model are required')
    const maxOutputTokens = options.maxOutputTokens ?? 6000
    const maxInputCharacters = options.maxInputCharacters ?? 60000
    if (![maxOutputTokens, maxInputCharacters].every(value => Number.isSafeInteger(value) && value > 0))
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Enrichment limits must be positive integers')
    if (options.knowledgeTypes !== undefined && (!options.knowledgeTypes || typeof options.knowledgeTypes !== 'object' || Array.isArray(options.knowledgeTypes)))
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Knowledge types must be a dictionary')
    const customTypes = Object.entries(options.knowledgeTypes ?? {})
    if (customTypes.length > 100 || customTypes.some(([key, description]) => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) || key.length > 64 || typeof description !== 'string' || !description.trim() || description.length > 500))
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Knowledge types require kebab-case keys and non-empty descriptions')
    this.knowledgeTypes = Object.freeze({ ...DEFAULT_KNOWLEDGE_TYPES, ...options.knowledgeTypes })
    this.options = { provider: options.provider, model: options.model, maxOutputTokens, maxInputCharacters }
  }

  async enrich(section: DocumentSection, options: { signal?: AbortSignal } = {}): Promise<EnrichedSection> {
    if (options.signal?.aborted)
      throw new AppError(LLM_ERROR_CODES.ABORTED, 'Enrichment was cancelled', { provider: this.options.provider })
    if (!section || typeof section.id !== 'string' || !section.id.trim() || typeof section.source?.id !== 'string' || !section.source.id.trim() || typeof section.markdown !== 'string' || !section.markdown.trim()
      || (section.documentTitle !== null && typeof section.documentTitle !== 'string') || !Array.isArray(section.headingPath)
      || section.headingPath.some(heading => !heading || typeof heading.title !== 'string' || !Number.isInteger(heading.depth) || heading.depth < 1 || heading.depth > 6)) {
      throw new AppError(CODES.INVALID_INPUT, 'A section with ID, source, markdown and heading path is required')
    }
    // 先从 AST 和文档字段读取确定性数据，模型只负责尚需语义理解的字段。
    const extracted = extractSectionData(section)
    const messages = buildMessages(section, extracted, this.knowledgeTypes)
    if (messages[1].content.length > this.options.maxInputCharacters)
      throw new AppError(CODES.INPUT_TOO_LARGE, 'Section exceeds the configured enrichment input limit')
    // 保存本次调用的来源与证据，避免等待模型时调用方修改 section 影响结果归属。
    const sectionId = section.id
    const source = { ...section.source }
    const markdown = section.markdown
    const response = await this.llm.generate({
      provider: this.options.provider,
      model: this.options.model,
      maxOutputTokens: this.options.maxOutputTokens,
      messages,
      signal: options.signal,
    })
    if (options.signal?.aborted)
      throw new AppError(LLM_ERROR_CODES.ABORTED, 'Enrichment was cancelled', { provider: this.options.provider })
    const errorOptions = { provider: response.provider, requestId: response.requestId }
    if (response.refusal || response.finishReason === 'refusal')
      throw new AppError(CODES.REFUSED, 'Model declined knowledge enrichment', errorOptions)
    if (response.finishReason !== 'stop')
      throw new AppError(CODES.INCOMPLETE_RESPONSE, 'Knowledge enrichment did not complete', errorOptions)
    try {
      const validated = parseEnrichment(response.text, markdown, this.knowledgeTypes)
      const enrichment = deduplicateEnrichment(validated)
      // 合并证据后再次验证数量上限和引用，不静默截断或放宽原始证据要求。
      parseEnrichment(JSON.stringify(enrichment), markdown, this.knowledgeTypes)
      return {
        schemaVersion: 2,
        sectionId,
        source,
        extracted: deduplicateExtracted(extracted),
        enrichment,
        generation: { provider: response.provider, model: response.model, responseId: response.id, requestId: response.requestId, usage: response.usage },
      }
    }
    catch (error) {
      if (error instanceof AppError)
        throw new AppError(error.code, error.message, errorOptions)
      throw new AppError(CODES.INVALID_OUTPUT, 'Invalid knowledge enrichment output', errorOptions)
    }
  }
}
