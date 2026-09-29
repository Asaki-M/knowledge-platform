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
export type AppErrorCode = HttpErrorCode | LlmErrorCode | NormalizationErrorCode | SectionSplitErrorCode | EnrichmentErrorCode | ChunkBuildErrorCode | EmbeddingErrorCode | WikiErrorCode | IngestionErrorCode | IndexingErrorCode | VectorStoreErrorCode | RerankErrorCode | QueryErrorCode

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
  /** 输入不是有效 Section，或内容与版本不一致。 */
  INVALID_INPUT: 'CHUNK_BUILD_INVALID_INPUT',
  /** 自定义 Token 计数失败或没有返回非负安全整数。 */
  TOKEN_COUNT_FAILED: 'CHUNK_BUILD_TOKEN_COUNT_FAILED',
  /** error 策略下，单个不可拆内容连同上下文超过 Token 预算。 */
  OVERSIZED_CONTENT: 'CHUNK_BUILD_OVERSIZED_CONTENT',
} as const

export type ChunkBuildErrorCode = typeof CHUNK_BUILD_ERROR_CODES[keyof typeof CHUNK_BUILD_ERROR_CODES]

/** 文本向量化的统一错误分类，不依赖通用文本生成能力。 */
export const EMBEDDING_ERROR_CODES = {
  /** 凭据、超时或适配器注册配置无效。 */
  CONFIGURATION_ERROR: 'EMBEDDING_CONFIGURATION_ERROR',
  /** 未注册请求指定的向量供应商。 */
  PROVIDER_NOT_FOUND: 'EMBEDDING_PROVIDER_NOT_FOUND',
  /** 模型、文本、维度或批量大小无效，或上游拒绝参数。 */
  INVALID_REQUEST: 'EMBEDDING_INVALID_REQUEST',
  /** 上游响应缺失向量、索引重复、维度不一致或包含无效数值。 */
  INVALID_RESPONSE: 'EMBEDDING_INVALID_RESPONSE',
  /** 上游鉴权失败或账号无权限。 */
  AUTHENTICATION_ERROR: 'EMBEDDING_AUTHENTICATION_ERROR',
  /** 上游请求频率或配额受限。 */
  RATE_LIMITED: 'EMBEDDING_RATE_LIMITED',
  /** 单次调用超过配置的等待时限。 */
  TIMEOUT: 'EMBEDDING_TIMEOUT',
  /** 调用方主动取消操作。 */
  ABORTED: 'EMBEDDING_ABORTED',
  /** 无法建立或维持上游连接。 */
  CONNECTION_ERROR: 'EMBEDDING_CONNECTION_ERROR',
  /** 上游服务异常或未分类的适配器错误。 */
  PROVIDER_ERROR: 'EMBEDDING_PROVIDER_ERROR',
} as const

export type EmbeddingErrorCode = typeof EMBEDDING_ERROR_CODES[keyof typeof EMBEDDING_ERROR_CODES]

/** Wiki 语义聚合与来源引用的错误分类。 */
export const WIKI_ERROR_CODES = {
  /** section 与知识提取结果不匹配、内容无效或输入重复。 */
  INVALID_INPUT: 'WIKI_INVALID_INPUT',
  /** 身份映射重复、过期、引用缺失或实体/概念类型不匹配。 */
  INVALID_MAPPING: 'WIKI_INVALID_MAPPING',
  /** Wiki 节点缺失、已被修改或不属于当前 section / enrichment 版本。 */
  INVALID_ASSOCIATION: 'WIKI_INVALID_ASSOCIATION',
} as const

export type WikiErrorCode = typeof WIKI_ERROR_CODES[keyof typeof WIKI_ERROR_CODES]

/** 入库前的纯函数影响计算，不执行数据库或模型操作。 */
export const INGESTION_ERROR_CODES = {
  /** Section 快照内容无效、版本不匹配或身份重复。 */
  INVALID_SNAPSHOT: 'INGESTION_INVALID_SNAPSHOT',
} as const

export type IngestionErrorCode = typeof INGESTION_ERROR_CODES[keyof typeof INGESTION_ERROR_CODES]

/** 双索引文本构造与向量组合的错误分类，SDK 错误沿用 Embedding 错误码。 */
export const INDEXING_ERROR_CODES = {
  /** Token 预算、计数器或批量生成选项无效。 */
  INVALID_OPTIONS: 'INDEXING_INVALID_OPTIONS',
  /** 输入快照、身份、来源关联或文本版本不一致。 */
  INVALID_INPUT: 'INDEXING_INVALID_INPUT',
  /** Chunk 与 Wiki 引用的 Section 版本不同。 */
  STALE_SOURCE: 'INDEXING_STALE_SOURCE',
  /** 完整向量化文本超限，需要调用方调整切分或预算。 */
  INPUT_TOO_LARGE: 'INDEXING_INPUT_TOO_LARGE',
  /** Token 计数器异常或返回无效值。 */
  TOKEN_COUNT_FAILED: 'INDEXING_TOKEN_COUNT_FAILED',
  /** 不同批次返回的实际模型或维度不一致，无法组成同一向量空间。 */
  INCONSISTENT_SPACE: 'INDEXING_INCONSISTENT_SPACE',
} as const

export type IndexingErrorCode = typeof INDEXING_ERROR_CODES[keyof typeof INDEXING_ERROR_CODES]

export const VECTOR_STORE_ERROR_CODES = {
  /** 数据库连接或超时配置无效。 */
  CONFIGURATION_ERROR: 'VECTOR_STORE_CONFIGURATION_ERROR',
  /** 向量、来源、文本版本或写入范围不合法。 */
  INVALID_INPUT: 'VECTOR_STORE_INVALID_INPUT',
  /** 数据库不可用或事务失败，不透出连接串和 SQL 参数。 */
  DATABASE_ERROR: 'VECTOR_STORE_DATABASE_ERROR',
  /** 读取后快照已被其他任务修改，拒绝覆盖新数据。 */
  CONFLICT: 'VECTOR_STORE_CONFLICT',
  /** 查询与库内模型或维度不同。 */
  INCONSISTENT_SPACE: 'VECTOR_STORE_INCONSISTENT_SPACE',
  /** 提交前收到取消信号，事务回滚。 */
  ABORTED: 'VECTOR_STORE_ABORTED',
} as const

export type VectorStoreErrorCode = typeof VECTOR_STORE_ERROR_CODES[keyof typeof VECTOR_STORE_ERROR_CODES]

/** 重排 SDK 的统一错误，不暴露上游正文。 */
export const RERANK_ERROR_CODES = {
  /** 模型服务配置缺失或无效。 */
  CONFIGURATION_ERROR: 'RERANK_CONFIGURATION_ERROR',
  /** 查询、候选文本或返回数量无效。 */
  INVALID_REQUEST: 'RERANK_INVALID_REQUEST',
  /** 返回索引重复、缺失、越界或分数无效。 */
  INVALID_RESPONSE: 'RERANK_INVALID_RESPONSE',
  /** 鉴权失败。 */
  AUTHENTICATION_ERROR: 'RERANK_AUTHENTICATION_ERROR',
  /** 请求频率或配额受限。 */
  RATE_LIMITED: 'RERANK_RATE_LIMITED',
  /** 调用超时。 */
  TIMEOUT: 'RERANK_TIMEOUT',
  /** 调用方取消。 */
  ABORTED: 'RERANK_ABORTED',
  /** 网络连接失败。 */
  CONNECTION_ERROR: 'RERANK_CONNECTION_ERROR',
  /** 未分类的上游错误。 */
  PROVIDER_ERROR: 'RERANK_PROVIDER_ERROR',
} as const
export type RerankErrorCode = typeof RERANK_ERROR_CODES[keyof typeof RERANK_ERROR_CODES]

/** 双路问答编排与答案生成的错误。 */
export const QUERY_ERROR_CODES = {
  /** 问题、知识库或模型配置无效。 */
  INVALID_INPUT: 'QUERY_INVALID_INPUT',
  /** 召回结果身份冲突、缺少文本或不属于当前知识库。 */
  INVALID_RESULTS: 'QUERY_INVALID_RESULTS',
  /** 问题与 Top 5 完整上下文超过字符预算，不静默截断。 */
  CONTEXT_TOO_LARGE: 'QUERY_CONTEXT_TOO_LARGE',
  /** 生成拒答，不能视作正常回答。 */
  REFUSED: 'QUERY_REFUSED',
  /** 答案被截断或过滤。 */
  INCOMPLETE_RESPONSE: 'QUERY_INCOMPLETE_RESPONSE',
  /** 答案为空或引用了不存在的来源编号。 */
  INVALID_ANSWER: 'QUERY_INVALID_ANSWER',
  /** 调用方取消本次问答。 */
  ABORTED: 'QUERY_ABORTED',
} as const
export type QueryErrorCode = typeof QUERY_ERROR_CODES[keyof typeof QUERY_ERROR_CODES]
