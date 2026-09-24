import type { AppErrorCode } from './error-codes.js'

/** 各能力按需补充定位信息；禁止放入凭据、文档正文或 SDK 原始响应。 */
export interface AppErrorOptions {
  provider?: string
  /** 上游响应的 HTTP 状态，不等于对外 API 应返回的状态。 */
  status?: number
  requestId?: string
  /** 仅描述能否重试，不会自动发起重试；未明确指定时为 false。 */
  retryable?: boolean
  /** 文档解析位置，行列从 1 开始。 */
  location?: { line: number, column: number }
}

/**
 * 服务端唯一业务异常类。调用方通过 instanceof AppError 和 code 识别错误。
 * message 应是可控的说明；HTTP 层仍负责对外响应，不能直接透传上游 status/message。
 */
export class AppError extends Error {
  readonly code: AppErrorCode
  readonly provider?: string
  readonly status?: number
  readonly requestId?: string
  readonly retryable: boolean
  readonly location?: { line: number, column: number }

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.provider = options.provider
    this.status = options.status
    this.requestId = options.requestId
    this.retryable = options.retryable ?? false
    this.location = options.location
  }
}
