import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ValidationReason } from '../errors.js'
import { HTTPException } from 'hono/http-exception'
import { ENRICHMENT_ERROR_CODES, HTTP_ERROR_CODES, INGESTION_ERROR_CODES, NORMALIZATION_ERROR_CODES, QUERY_ERROR_CODES, VECTOR_STORE_ERROR_CODES } from '../error-codes.js'
import { AppError } from '../errors.js'

function response(body: { error: { code: string, message: string }, requestId: string }, status: ContentfulStatusCode) {
  return { body, status }
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

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof AppError) {
    // 对外只返回稳定错误码和可控文案，不透传数据库或上游模型错误内容。
    const invalid = error.code === HTTP_ERROR_CODES.INVALID_INPUT || error.code === INGESTION_ERROR_CODES.INVALID_DOCUMENT || error.code === QUERY_ERROR_CODES.INVALID_INPUT || error.code === QUERY_ERROR_CODES.CONTEXT_TOO_LARGE
    const parseError = error.code === NORMALIZATION_ERROR_CODES.PARSE_ERROR
    const conflict = error.code === INGESTION_ERROR_CODES.TASK_CONFLICT || error.code === VECTOR_STORE_ERROR_CODES.CONFLICT || error.code === VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE
    const status = error.code === INGESTION_ERROR_CODES.TASK_NOT_FOUND ? 404 : invalid || parseError ? 400 : conflict ? 409 : error.code.endsWith('CONFIGURATION_ERROR') ? 503 : 502
    const enrichmentMessages: Partial<Record<string, string>> = {
      [INGESTION_ERROR_CODES.TASK_NOT_FOUND]: '没有找到这个入库任务，请重新提交文档。',
      [INGESTION_ERROR_CODES.TASK_CONFLICT]: '任务仍在执行或正文、配置已变化。请等待中断完成后继续；修改内容需要新建任务。',
      [INGESTION_ERROR_CODES.CHECKPOINT_DATABASE_ERROR]: '入库检查点保存或读取失败，已停止处理。请恢复数据库后继续重试。',
      [INGESTION_ERROR_CODES.ABORTED]: '入库已中断，已完成结果保留，可继续重试。',
      [ENRICHMENT_ERROR_CODES.OUTPUT_TRUNCATED]: '知识提取达到生成长度限制，结果不完整，本次文档未写入。请将较长内容拆成更短的 H1–H3 章节，或调整提取输出预算后重新提交。',
      [ENRICHMENT_ERROR_CODES.CONTENT_FILTERED]: '知识提取被模型服务的内容过滤中止，本次文档未写入。请检查输入内容或更换模型。',
      [ENRICHMENT_ERROR_CODES.INCOMPLETE_RESPONSE]: '知识提取未正常结束，模型未提供可识别的结束原因，本次文档未写入。请检查模型响应与服务端日志。',
      [ENRICHMENT_ERROR_CODES.REFUSED]: '模型拒绝了本次知识提取，本次文档未写入。请检查输入内容或更换模型。',
    }
    return response({ error: { code: error.code, message: enrichmentValidationMessage(error) ?? enrichmentMessages[error.code] ?? (parseError ? '文档语法无效，请检查 MDX 内容。' : invalid ? error.message : error.code === VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE ? 'Embedding 与知识库向量空间不一致，请使用入库时的供应商、模型和维度。' : '操作未完成，请检查服务配置或稍后重试。') }, requestId }, status)
  }
  if (error instanceof HTTPException) {
    return response(
      {
        error: { code: HTTP_ERROR_CODES.HTTP_ERROR, message: error.message },
        requestId,
      },
      error.status,
    )
  }
  return response(
    {
      error: {
        code: HTTP_ERROR_CODES.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
      requestId,
    },
    500,
  )
}
