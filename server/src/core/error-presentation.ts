import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppErrorCode } from '../error-codes.js'
import type { ValidationReason } from '../errors.js'
import { EMBEDDING_ERROR_CODES, ENRICHMENT_ERROR_CODES, HTTP_ERROR_CODES, INDEXING_ERROR_CODES, INGESTION_ERROR_CODES, LLM_ERROR_CODES, MCP_AUTH_ERROR_CODES, NORMALIZATION_ERROR_CODES, OPERATION_LOG_ERROR_CODES, QUERY_ERROR_CODES, RERANK_ERROR_CODES, VECTOR_STORE_ERROR_CODES, WORKSPACE_ERROR_CODES } from '../error-codes.js'
import { AppError } from '../errors.js'

type ErrorCategory = 'cancelled' | 'configuration' | 'authentication' | 'rate-limit' | 'timeout' | 'vector-space' | 'conflict' | 'database' | 'parse' | 'invalid' | 'other'
interface ErrorPresentation {
  category: ErrorCategory
  status: ContentfulStatusCode
  /** 日志使用简短固定文案，HTTP 可另附可操作的信息。 */
  message?: string
  httpMessage?: string
  exposeMessage?: boolean
}

const presentations = new Map<AppErrorCode, ErrorPresentation>()
const groups = [LLM_ERROR_CODES, EMBEDDING_ERROR_CODES, NORMALIZATION_ERROR_CODES, ENRICHMENT_ERROR_CODES, INGESTION_ERROR_CODES, VECTOR_STORE_ERROR_CODES, RERANK_ERROR_CODES, QUERY_ERROR_CODES, OPERATION_LOG_ERROR_CODES, WORKSPACE_ERROR_CODES, MCP_AUTH_ERROR_CODES]
function register(codes: readonly AppErrorCode[], presentation: ErrorPresentation) {
  for (const code of codes)
    presentations.set(code, presentation)
}

// 按错误码常量的明确字段分类，不依赖字符串片段猜测错误含义。
register(groups.flatMap(group => 'ABORTED' in group ? [group.ABORTED] : []), { category: 'cancelled', status: 502, message: '操作已取消。' })
register([...groups.flatMap(group => 'CONFIGURATION_ERROR' in group ? [group.CONFIGURATION_ERROR] : []), INGESTION_ERROR_CODES.CHECKPOINT_CONFIGURATION_ERROR], { category: 'configuration', status: 503, message: '服务配置缺失或无效。' })
register(groups.flatMap(group => 'AUTHENTICATION_ERROR' in group ? [group.AUTHENTICATION_ERROR] : []), { category: 'authentication', status: 502, message: '模型服务鉴权失败。' })
register(groups.flatMap(group => 'RATE_LIMITED' in group ? [group.RATE_LIMITED] : []), { category: 'rate-limit', status: 502, message: '模型服务限流或配额不足。' })
register(groups.flatMap(group => 'TIMEOUT' in group ? [group.TIMEOUT] : []), { category: 'timeout', status: 502, message: '模型调用超时。' })
register([INDEXING_ERROR_CODES.INCONSISTENT_SPACE], { category: 'vector-space', status: 502, message: 'Embedding 与知识库向量空间不一致。' })
register([VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE], { category: 'vector-space', status: 409, message: 'Embedding 与知识库向量空间不一致。', httpMessage: 'Embedding 与知识库向量空间不一致，请使用入库时的供应商、模型和维度。' })
register([VECTOR_STORE_ERROR_CODES.CONFLICT, INGESTION_ERROR_CODES.TASK_CONFLICT], { category: 'conflict', status: 409, message: '知识库版本或文档共享节点发生冲突。' })
register([...groups.flatMap(group => 'DATABASE_ERROR' in group ? [group.DATABASE_ERROR] : []), INGESTION_ERROR_CODES.CHECKPOINT_DATABASE_ERROR], { category: 'database', status: 502, message: '数据库操作失败。' })
register([NORMALIZATION_ERROR_CODES.PARSE_ERROR], { category: 'parse', status: 400, message: '文档语法无法解析。', httpMessage: '文档语法无效，请检查 MDX 内容。' })
register([HTTP_ERROR_CODES.INVALID_INPUT, INGESTION_ERROR_CODES.INVALID_DOCUMENT, QUERY_ERROR_CODES.INVALID_INPUT, QUERY_ERROR_CODES.CONTEXT_TOO_LARGE], { category: 'invalid', status: 400, message: '请求参数或内容无效。', exposeMessage: true })

// 特定操作的 HTTP 提示不进入摘要日志，日志仅保存安全的基础说明。
presentations.set(WORKSPACE_ERROR_CODES.CONFLICT, { category: 'conflict', status: 409, httpMessage: '已存在同名知识库，请换一个名称。' })
presentations.set(WORKSPACE_ERROR_CODES.NOT_FOUND, { category: 'other', status: 404, httpMessage: '知识库不存在，请刷新列表后重试。' })
presentations.set(INGESTION_ERROR_CODES.TASK_NOT_FOUND, { category: 'other', status: 404, httpMessage: '没有找到这个入库任务，请重新提交文档。' })
presentations.set(INGESTION_ERROR_CODES.TASK_CONFLICT, { ...presentations.get(INGESTION_ERROR_CODES.TASK_CONFLICT)!, httpMessage: '任务仍在执行或正文、配置已变化。请等待中断完成后继续；修改内容需要新建任务。' })
presentations.set(INGESTION_ERROR_CODES.CHECKPOINT_DATABASE_ERROR, { ...presentations.get(INGESTION_ERROR_CODES.CHECKPOINT_DATABASE_ERROR)!, httpMessage: '入库检查点保存或读取失败，已停止处理。请恢复数据库后继续重试。' })
presentations.set(INGESTION_ERROR_CODES.ABORTED, { ...presentations.get(INGESTION_ERROR_CODES.ABORTED)!, httpMessage: '入库已中断，已完成结果保留，可继续重试。' })
presentations.set(ENRICHMENT_ERROR_CODES.OUTPUT_TRUNCATED, { category: 'other', status: 502, message: '知识提取达到生成长度限制，结果不完整，本次文档未写入。', httpMessage: '知识提取达到生成长度限制，结果不完整，本次文档未写入。请将较长内容拆成更短的 H1–H3 章节，或调整提取输出预算后重新提交。' })
presentations.set(ENRICHMENT_ERROR_CODES.CONTENT_FILTERED, { category: 'other', status: 502, message: '知识提取被模型服务的内容过滤中止，本次文档未写入。', httpMessage: '知识提取被模型服务的内容过滤中止，本次文档未写入。请检查输入内容或更换模型。' })
presentations.set(ENRICHMENT_ERROR_CODES.INCOMPLETE_RESPONSE, { category: 'other', status: 502, message: '知识提取未正常结束，需查看模型结束原因；历史记录可能包含截断或过滤。', httpMessage: '知识提取未正常结束，模型未提供可识别的结束原因，本次文档未写入。请检查模型响应与服务端日志。' })
presentations.set(ENRICHMENT_ERROR_CODES.REFUSED, { category: 'other', status: 502, message: '模型拒绝了本次知识提取，本次文档未写入。', httpMessage: '模型拒绝了本次知识提取，本次文档未写入。请检查输入内容或更换模型。' })

/** 未专门映射的领域错误统一兜底，不暴露其原始 message。 */
export function describeAppError(error: AppError) {
  const presentation: ErrorPresentation = presentations.get(error.code) ?? { category: 'other', status: 502 }
  const validation = enrichmentValidationMessage(error)
  return {
    category: presentation.category,
    status: presentation.status,
    httpMessage: validation ?? presentation.httpMessage ?? (presentation.exposeMessage ? error.message : '操作未完成，请检查服务配置或稍后重试。'),
    logMessage: validation ?? presentation.message,
  }
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof AppError && describeAppError(error).category === 'cancelled'
}

/** 仅翻译固定规则与白名单字段，不能将模型输出或任意异常 message 暴露到页面和日志。 */
export function enrichmentValidationMessage(error: AppError): string | undefined {
  if (error.code !== ENRICHMENT_ERROR_CODES.INVALID_OUTPUT)
    return
  const reasons: Record<ValidationReason, string> = {
    'invalid-json': '返回内容不是合法 JSON，不能包含代码围栏或说明文字',
    'invalid-object': '需要 JSON 对象',
    'missing-field': '缺少必填字段',
    'unexpected-field': '包含约定结构之外的字段',
    'invalid-text': '需要非空字符串',
    'text-too-long': '文本超过允许长度',
    'invalid-array': '需要数组',
    'too-many-items': '数组项数超过允许数量',
    'invalid-id': '节点 ID 必须为 1–80 个字母、数字、下划线或连字符',
    'duplicate-id': '节点 ID 重复',
    'unknown-reference': '引用的节点 ID 未在本节实体或概念中定义',
    'empty-evidence': '原文证据不能为空',
    'evidence-not-found': '证据未在本节 Markdown 中逐字匹配，不能改写、拼接或改变空格与转义',
    'unsupported-value': '知识分类不在配置字典中',
  }
  const issue = error.validation
  const safePath = /^(?:JSON|root|(?:summary|keywords|aliases|questions|entities|concepts|relations|facts|knowledgeType)(?:\[\d{1,3}\])?(?:\.(?:id|name|type|aliases|description|evidence|sourceId|targetId|statement|nodeIds)(?:\[\d{1,3}\])?)?)$/
  if (!issue || typeof issue.path !== 'string' || !safePath.test(issue.path) || !Object.hasOwn(reasons, issue.reason))
    return '知识提取结果校验失败：模型返回的 JSON、字段、节点引用或原文证据不符合要求。本次文档未写入。'
  const sectionIndex = issue.sectionIndex
  const chapter = typeof sectionIndex === 'number' && Number.isSafeInteger(sectionIndex) && sectionIndex >= 0 && sectionIndex < 100 ? `第 ${sectionIndex + 1} 节，` : ''
  return `知识提取结果校验失败（${chapter}字段 ${issue.path}）：${reasons[issue.reason]}。本次文档未写入。`
}
