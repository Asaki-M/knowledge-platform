import type { EmbeddingErrorCode } from '../../error-codes.js'
import { EMBEDDING_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'

/** 两家 SDK 共用 HTTP 分类，不传入或记录上游可能回显正文的错误消息。 */
export function embeddingHttpError(provider: string, status: number | undefined, requestId?: string): AppError {
  let code: EmbeddingErrorCode = CODES.PROVIDER_ERROR
  if (status === 401 || status === 403)
    code = CODES.AUTHENTICATION_ERROR
  else if (status === 429)
    code = CODES.RATE_LIMITED
  else if (status === 400 || status === 404 || status === 422)
    code = CODES.INVALID_REQUEST
  else if (status === 408 || status === 504)
    code = CODES.TIMEOUT
  return new AppError(code, 'Embedding provider rejected the request', {
    provider,
    status,
    requestId,
    retryable: status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500),
  })
}
