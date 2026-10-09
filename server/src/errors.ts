import type { AppErrorCode } from './error-codes.js'

/** 校验诊断只保留固定规则和字段位置，不包含被拒绝的实际值。 */
export type ValidationReason = 'invalid-json' | 'invalid-object' | 'missing-field' | 'unexpected-field' | 'invalid-text' | 'text-too-long' | 'invalid-array' | 'too-many-items' | 'invalid-id' | 'duplicate-id' | 'unknown-reference' | 'empty-evidence' | 'evidence-not-found' | 'unsupported-value'

export interface ValidationIssue {
  path: string
  reason: ValidationReason
  /** 原文 Section 的零基序号，供调用方定位章节；不携带标题或正文。 */
  sectionIndex?: number
}

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
  validation?: ValidationIssue
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
  readonly validation?: ValidationIssue

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.provider = options.provider
    this.status = options.status
    this.requestId = options.requestId
    this.retryable = options.retryable ?? false
    this.location = options.location
    this.validation = options.validation ? { ...options.validation } : undefined
  }
}
