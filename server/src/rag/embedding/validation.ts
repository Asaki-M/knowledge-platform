import type { EmbeddingResponse, EmbedRequest } from './types.js'
import { EMBEDDING_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'

export function validateRequest(request: EmbedRequest) {
  if (!request || !isNonEmptyString(request.provider) || !isNonEmptyString(request.model)
    || !Array.isArray(request.input) || !request.input.length
    || !Array.from(request.input).every(isNonEmptyString)
    || (request.dimensions !== undefined && (!Number.isSafeInteger(request.dimensions) || request.dimensions <= 0))) {
    throw new AppError(CODES.INVALID_REQUEST, 'Provider, model, non-empty texts and positive dimensions are required')
  }
}

/** 所有适配器都必须满足一条输入对应一个向量的契约，不能静默丢失或合并文本。 */
export function validateResponse(response: EmbeddingResponse, request: EmbedRequest) {
  const invalid = () => new AppError(CODES.INVALID_RESPONSE, 'Invalid embedding response', { provider: request.provider })
  if (!response || response.provider !== request.provider || !isNonEmptyString(response.model)
    || !Number.isSafeInteger(response.dimensions) || response.dimensions <= 0
    || (request.dimensions !== undefined && response.dimensions !== request.dimensions)
    || !Array.isArray(response.embeddings) || response.embeddings.length !== request.input.length) {
    throw invalid()
  }
  for (const vector of response.embeddings) {
    // Array.from 同时让稀疏数组中的空位参与校验，避免 every 跳过缺失元素。
    if (!Array.isArray(vector) || vector.length !== response.dimensions || !Array.from(vector).every(Number.isFinite))
      throw invalid()
  }
  if (response.usage !== null && (!response.usage
    || !Number.isSafeInteger(response.usage.inputTokens) || response.usage.inputTokens < 0
    || !Number.isSafeInteger(response.usage.totalTokens) || response.usage.totalTokens < response.usage.inputTokens)) {
    throw invalid()
  }
}
