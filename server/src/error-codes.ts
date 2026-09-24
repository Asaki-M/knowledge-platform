/**
 * 服务端错误码的唯一声明位置。
 * HTTP、LLM 与 RAG 分组维护，避免独立能力依赖 HTTP 层；已有字符串值保持稳定。
 * 此处仅定义错误分类，具体错误消息、HTTP 状态和是否可重试由调用位置决定。
 */

/** HTTP/API 层的错误分类。 */
export const HTTP_ERROR_CODES = {
  /** 请求的 HTTP 路由不存在，对应当前应用的 404 响应。 */
  NOT_FOUND: 'NOT_FOUND',
  /** Hono HTTPException 表示的显式 HTTP 异常，实际状态码取自异常对象。 */
  HTTP_ERROR: 'HTTP_ERROR',
  /** 未被专门处理的服务端异常，对外返回通用 500 信息，不暴露内部细节。 */
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const

/** 模型调用的统一错误分类，所有厂商适配器复用同一组值。 */
export const LLM_ERROR_CODES = {
  /** 生成请求参数不合法，或上游拒绝请求参数；例如模型为空、消息缺失、参数不受支持。 */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** 本地适配器配置不合法；例如缺少 Key、超时或重试次数无效、供应商标识重复。 */
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  /** 请求指定的供应商未注册到 LlmClient，无法找到对应适配器。 */
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  /** 上游鉴权失败或拒绝访问；例如凭据失效、账号没有所需权限，对应 OpenAI 的 401/403。 */
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  /** 上游返回限流错误；可能涉及请求频率、Token 速率或配额限制，对应 OpenAI 的 429。 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** SDK 请求尝试超过配置的等待时限；与调用方通过 AbortSignal 主动取消区分。 */
  TIMEOUT: 'TIMEOUT',
  /** 调用方取消请求，或上游返回已取消状态；不应自动重试用户已取消的操作。 */
  ABORTED: 'ABORTED',
  /** 无法建立或维持上游连接；例如 DNS、TLS 或网络连接中断，不是已收到的 HTTP 错误响应。 */
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  /** 上游生成失败、未细分的 SDK/HTTP 异常，或适配器抛出的未知异常的兜底分类。 */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** 上游响应无法满足统一输出契约；例如同步调用返回排队状态，或正常完成却没有文本。 */
  INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const

/** 从常量推导联合类型，新增错误码时无需再维护一份字符串列表。 */
export type HttpErrorCode = typeof HTTP_ERROR_CODES[keyof typeof HTTP_ERROR_CODES]
export type LlmErrorCode = typeof LLM_ERROR_CODES[keyof typeof LLM_ERROR_CODES]

/** 文档标准化的统一错误分类，各文档适配器共用。 */
export const NORMALIZATION_ERROR_CODES = {
  /** 输入缺少来源标识、适配器名称或字符串正文。 */
  INVALID_INPUT: 'NORMALIZATION_INVALID_INPUT',
  /** 适配器标识为空、重复，或注册对象不符合契约。 */
  CONFIGURATION_ERROR: 'NORMALIZATION_CONFIGURATION_ERROR',
  /** 请求指定的文档适配器尚未注册。 */
  ADAPTER_NOT_FOUND: 'NORMALIZATION_ADAPTER_NOT_FOUND',
  /** 文档语法或元数据不合法，无法建立有效 AST。 */
  PARSE_ERROR: 'NORMALIZATION_PARSE_ERROR',
  /** AST 转换失败，或适配器出现未分类的异常。 */
  TRANSFORM_ERROR: 'NORMALIZATION_TRANSFORM_ERROR',
  /** 调用方已取消操作，不再返回标准化结果。 */
  ABORTED: 'NORMALIZATION_ABORTED',
} as const

export type NormalizationErrorCode = typeof NORMALIZATION_ERROR_CODES[keyof typeof NORMALIZATION_ERROR_CODES]

export const SECTION_SPLIT_ERROR_CODES = {
  /** 输入不是版本 1 的标准化文档，缺少来源/root AST，或 AST 无法按标准 Markdown 结构切分。 */
  INVALID_DOCUMENT: 'SECTION_SPLIT_INVALID_DOCUMENT',
} as const

export type SectionSplitErrorCode = typeof SECTION_SPLIT_ERROR_CODES[keyof typeof SECTION_SPLIT_ERROR_CODES]

/** 所有业务异常共用的错误码类型，具体字符串与中文含义仍在上面的分组中维护。 */
export type AppErrorCode = HttpErrorCode | LlmErrorCode | NormalizationErrorCode | SectionSplitErrorCode | EnrichmentErrorCode | ChunkBuildErrorCode

/** 知识补充阶段的错误；上游网络、鉴权和取消错误继续沿用 LLM 错误码。 */
export const ENRICHMENT_ERROR_CODES = {
  /** 供应商、模型、分类字典或字符/输出 Token 上限配置不合法。 */
  CONFIGURATION_ERROR: 'ENRICHMENT_CONFIGURATION_ERROR',
  /** 输入缺少有效 section ID、来源、正文或标题路径。 */
  INVALID_INPUT: 'ENRICHMENT_INVALID_INPUT',
  /** 用户消息超过字符上限，调用方需先调整输入，不静默截断证据。 */
  INPUT_TOO_LARGE: 'ENRICHMENT_INPUT_TOO_LARGE',
  /** 模型明确拒答，不能将拒答内容当成补充结果。 */
  REFUSED: 'ENRICHMENT_REFUSED',
  /** 模型生成被截断、过滤或未正常结束，即使部分文本是 JSON 也不接受。 */
  INCOMPLETE_RESPONSE: 'ENRICHMENT_INCOMPLETE_RESPONSE',
  /** 输出不是约定 JSON，字段类型、分类、实体引用或原文证据校验失败。 */
  INVALID_OUTPUT: 'ENRICHMENT_INVALID_OUTPUT',
} as const

export type EnrichmentErrorCode = typeof ENRICHMENT_ERROR_CODES[keyof typeof ENRICHMENT_ERROR_CODES]

export const CHUNK_BUILD_ERROR_CODES = {
  /** Token 预算、重叠预算、超限策略或计数函数配置不合法。 */
  INVALID_OPTIONS: 'CHUNK_BUILD_INVALID_OPTIONS',
  /** 输入不是有效 section，或 enrichment 不属于该 section/来源。 */
  INVALID_INPUT: 'CHUNK_BUILD_INVALID_INPUT',
  /** 自定义 Token 计数失败或没有返回非负安全整数。 */
  TOKEN_COUNT_FAILED: 'CHUNK_BUILD_TOKEN_COUNT_FAILED',
  /** error 策略下，单个不可拆内容连同上下文超过 Token 预算。 */
  OVERSIZED_CONTENT: 'CHUNK_BUILD_OVERSIZED_CONTENT',
} as const

export type ChunkBuildErrorCode = typeof CHUNK_BUILD_ERROR_CODES[keyof typeof CHUNK_BUILD_ERROR_CODES]
