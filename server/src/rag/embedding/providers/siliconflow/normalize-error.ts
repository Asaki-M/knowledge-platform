import OpenAI from 'openai'
import { EMBEDDING_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { embeddingHttpError } from '../../http-error.js'

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError)
    return error
  const provider = 'siliconflow'
  if (error instanceof OpenAI.APIUserAbortError)
    return new AppError(CODES.ABORTED, 'Embedding request was cancelled', { provider })
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new AppError(CODES.TIMEOUT, 'Embedding request timed out', { provider, retryable: true })
  if (error instanceof OpenAI.APIConnectionError)
    return new AppError(CODES.CONNECTION_ERROR, 'Could not connect to embedding provider', { provider, retryable: true })
  if (error instanceof OpenAI.APIError) {
    const requestId = error.headers?.get('x-siliconcloud-trace-id') ?? error.requestID ?? undefined
    return embeddingHttpError(provider, error.status, requestId)
  }
  if (error instanceof SyntaxError)
    return new AppError(CODES.INVALID_RESPONSE, 'Invalid embedding JSON response', { provider })
  return new AppError(CODES.PROVIDER_ERROR, 'Embedding provider request failed', { provider })
}
