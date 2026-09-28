import type { EmbedContentResponse } from '@google/genai'
import type { EmbeddingResponse } from '../../types.js'
import { EMBEDDING_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'

export function toEmbeddingResponse(response: EmbedContentResponse, model: string): EmbeddingResponse {
  if (!response || !Array.isArray(response.embeddings) || response.embeddings.some(item => !item || !Array.isArray(item.values)))
    throw new AppError(CODES.INVALID_RESPONSE, 'Invalid Google embedding response', { provider: 'google' })
  const embeddings = response.embeddings.map(item => item.values!)
  return {
    provider: 'google',
    model,
    embeddings,
    dimensions: embeddings[0]?.length ?? 0,
    // 当前 Google SDK 的 EmbedContentResponse 不暴露 Token 用量，不用零冒充真实用量。
    usage: null,
    requestId: response.sdkHttpResponse?.headers?.['x-request-id'],
  }
}
