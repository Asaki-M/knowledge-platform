import type { LlmErrorCode } from '../../error-codes.js'
import OpenAI from 'openai'
import { LLM_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'

/** 两个文本生成适配器共用的 SDK 连接选项；环境变量仍由各厂商自己读取。 */
export interface OpenAISdkOptions {
  apiKey?: string
  baseURL?: string
  /** 单次请求超时，默认 60000 毫秒。 */
  timeoutMs?: number
  /** SDK 内置重试次数，默认 2；此层不叠加重试。 */
  maxRetries?: number
}

export function createOpenAISdk(options: OpenAISdkOptions, defaults: { provider: string, apiKey?: string, baseURL?: string, apiKeyName: string }): OpenAI {
  const { provider } = defaults
  const apiKey = options.apiKey ?? defaults.apiKey
  if (!apiKey?.trim())
    throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, `${defaults.apiKeyName} is required`, { provider })
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, 'timeoutMs must be positive', { provider })
  if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0))
    throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, 'maxRetries must be a non-negative integer', { provider })
  return new OpenAI({ apiKey, baseURL: options.baseURL ?? defaults.baseURL, timeout: options.timeoutMs ?? 60000, maxRetries: options.maxRetries ?? 2 })
}

/** 将 SDK 异常转换为统一错误，只保留错误分类、状态码和请求 ID 等元数据。 */
export function normalizeOpenAISdkError(error: unknown, provider: string): AppError {
  // 响应解析阶段已构造的统一错误直接返回，保留其具体错误码。
  if (error instanceof AppError)
    return error
  if (error instanceof OpenAI.APIUserAbortError)
    return new AppError(LLM_ERROR_CODES.ABORTED, 'LLM request was cancelled', { provider })
  // 超时异常继承连接异常，需要先判断子类，才能保留 TIMEOUT 的独立语义。
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new AppError(LLM_ERROR_CODES.TIMEOUT, 'LLM request timed out', { provider, retryable: true })
  if (error instanceof OpenAI.APIConnectionError)
    return new AppError(LLM_ERROR_CODES.CONNECTION_ERROR, 'Could not connect to LLM provider', { provider, retryable: true })
  if (error instanceof OpenAI.APIError) {
    const status = error.status
    let code: LlmErrorCode = LLM_ERROR_CODES.PROVIDER_ERROR
    if (status === 401 || status === 403)
      code = LLM_ERROR_CODES.AUTHENTICATION_ERROR
    else if (status === 429)
      code = LLM_ERROR_CODES.RATE_LIMITED
    else if (status === 400 || status === 422)
      code = LLM_ERROR_CODES.INVALID_REQUEST
    // 不使用上游原始 message，它可能回显请求内容；重试提示不代表这里会再次调用。
    return new AppError(code, 'LLM provider rejected the request', {
      provider,
      status,
      requestId: error.requestID ?? undefined,
      retryable: status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500),
    })
  }
  return new AppError(LLM_ERROR_CODES.PROVIDER_ERROR, 'LLM provider request failed', { provider })
}
