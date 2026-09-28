import { ApiError } from '@google/genai'
import { EMBEDDING_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { embeddingHttpError } from '../../http-error.js'

export function normalizeError(error: unknown, aborted: boolean, timedOut: boolean): AppError {
  const provider = 'google'
  if (aborted)
    return new AppError(CODES.ABORTED, 'Embedding request was cancelled', { provider })
  if (timedOut)
    return new AppError(CODES.TIMEOUT, 'Embedding request timed out', { provider, retryable: true })
  if (error instanceof AppError)
    return error
  if (error instanceof ApiError)
    return embeddingHttpError(provider, error.status)
  if (error instanceof SyntaxError)
    return new AppError(CODES.INVALID_RESPONSE, 'Invalid embedding JSON response', { provider })
  if (error instanceof TypeError) {
    // Node fetch 的网络错误携带底层 cause；SDK 解析畸形响应的 TypeError 不应误报连接失败。
    if (error.cause instanceof Error)
      return new AppError(CODES.CONNECTION_ERROR, 'Could not connect to embedding provider', { provider, retryable: true })
    return new AppError(CODES.INVALID_RESPONSE, 'Invalid embedding response', { provider })
  }
  return new AppError(CODES.PROVIDER_ERROR, 'Embedding provider request failed', { provider })
}
