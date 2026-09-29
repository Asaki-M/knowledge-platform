import type { RerankRequest, RerankResponse } from '../../types.js'
import { RERANK_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { isRecord } from '../../../../utils/type-guards.js'
import { validateRanking } from '../../validation.js'

export function toRerankResponse(data: unknown, request: RerankRequest, requestId?: string): RerankResponse {
  if (!isRecord(data) || !Array.isArray(data.results))
    throw new AppError(CODES.INVALID_RESPONSE, 'Invalid rerank response')
  const results = data.results.map((item: unknown) => {
    if (!isRecord(item) || typeof item.index !== 'number' || typeof item.relevance_score !== 'number')
      throw new AppError(CODES.INVALID_RESPONSE, 'Invalid rerank result')
    return { index: item.index, score: item.relevance_score }
  })
  validateRanking(results, request.documents.length, request.topN)
  const tokens = isRecord(data.meta) && isRecord(data.meta.tokens) ? data.meta.tokens : null
  const usage = tokens && typeof tokens.input_tokens === 'number' && Number.isSafeInteger(tokens.input_tokens) && tokens.input_tokens >= 0
    && typeof tokens.output_tokens === 'number' && Number.isSafeInteger(tokens.output_tokens) && tokens.output_tokens >= 0
    ? { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens }
    : null
  return { provider: 'siliconflow', model: request.model, results: results.sort((a, b) => b.score - a.score || a.index - b.index), usage, requestId }
}
