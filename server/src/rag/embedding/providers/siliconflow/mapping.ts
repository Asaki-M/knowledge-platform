import type { CreateEmbeddingResponse } from 'openai/resources/embeddings'
import type { EmbeddingResponse } from '../../types.js'
import { EMBEDDING_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'

/** 上游数据可能乱序，必须按 index 还原，重复或缺失索引不能被覆盖掉。 */
export function toEmbeddingResponse(response: CreateEmbeddingResponse, inputCount: number, requestId?: string): EmbeddingResponse {
  const invalid = () => new AppError(CODES.INVALID_RESPONSE, 'Invalid SiliconFlow embedding response', { provider: 'siliconflow', requestId })
  if (!response || !Array.isArray(response.data) || response.data.length !== inputCount)
    throw invalid()
  const embeddings: number[][] = []
  const seen = new Set<number>()
  for (const item of response.data) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= inputCount || seen.has(item.index) || !Array.isArray(item.embedding))
      throw invalid()
    seen.add(item.index)
    embeddings[item.index] = item.embedding
  }
  return {
    provider: 'siliconflow',
    model: response.model,
    embeddings,
    dimensions: embeddings[0]?.length ?? 0,
    usage: response.usage == null ? null : { inputTokens: response.usage.prompt_tokens, totalTokens: response.usage.total_tokens },
    requestId,
  }
}
