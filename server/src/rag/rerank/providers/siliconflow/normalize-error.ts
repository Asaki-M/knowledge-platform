import OpenAI from 'openai'
import { RERANK_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError)
    return error
  const provider = 'siliconflow'
  if (error instanceof OpenAI.APIUserAbortError)
    return new AppError(CODES.ABORTED, 'Rerank request was cancelled', { provider })
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new AppError(CODES.TIMEOUT, 'Rerank request timed out', { provider, retryable: true })
  if (error instanceof OpenAI.APIConnectionError)
    return new AppError(CODES.CONNECTION_ERROR, 'Could not connect to rerank provider', { provider, retryable: true })
  if (error instanceof OpenAI.APIError) {
    const status = error.status
    const code = status === 401 || status === 403 ? CODES.AUTHENTICATION_ERROR : status === 429 ? CODES.RATE_LIMITED : CODES.PROVIDER_ERROR
    return new AppError(code, 'Rerank provider rejected the request', { provider, status, requestId: error.requestID ?? undefined, retryable: status === 429 || (status !== undefined && status >= 500) })
  }
  return new AppError(error instanceof SyntaxError ? CODES.INVALID_RESPONSE : CODES.PROVIDER_ERROR, 'Rerank request failed', { provider })
}
