import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { ENRICHMENT_ERROR_CODES, HTTP_ERROR_CODES, INGESTION_ERROR_CODES, NORMALIZATION_ERROR_CODES, QUERY_ERROR_CODES, VECTOR_STORE_ERROR_CODES } from '../error-codes.js'
import { AppError } from '../errors.js'
import { tracingMiddleware } from './middleware/tracing.js'
import { apiRouter } from './router/index.js'

export const app = new Hono()

app.use('*', requestId())
app.use('*', tracingMiddleware)
app.route('/api', apiRouter)
app.notFound(c =>
  c.json(
    {
      error: { code: HTTP_ERROR_CODES.NOT_FOUND, message: 'Route not found' },
      requestId: c.get('requestId'),
    },
    404,
  ),
)
app.onError((error, c) => {
  if (error instanceof AppError) {
    // 对外只返回稳定错误码和可控文案，不透传数据库或上游模型错误内容。
    const invalid = error.code === HTTP_ERROR_CODES.INVALID_INPUT || error.code === INGESTION_ERROR_CODES.INVALID_DOCUMENT || error.code === QUERY_ERROR_CODES.INVALID_INPUT || error.code === QUERY_ERROR_CODES.CONTEXT_TOO_LARGE
    const parseError = error.code === NORMALIZATION_ERROR_CODES.PARSE_ERROR
    const conflict = error.code === VECTOR_STORE_ERROR_CODES.CONFLICT || error.code === VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE
    const status = invalid || parseError ? 400 : conflict ? 409 : error.code.endsWith('CONFIGURATION_ERROR') ? 503 : 502
    const enrichmentMessages: Partial<Record<string, string>> = {
      [ENRICHMENT_ERROR_CODES.OUTPUT_TRUNCATED]: '知识提取达到生成长度限制，结果不完整，本次文档未写入。请将较长内容拆成更短的 H1–H3 章节，或调整提取输出预算后重新提交。',
      [ENRICHMENT_ERROR_CODES.CONTENT_FILTERED]: '知识提取被模型服务的内容过滤中止，本次文档未写入。请检查输入内容或更换模型。',
      [ENRICHMENT_ERROR_CODES.INCOMPLETE_RESPONSE]: '知识提取未正常结束，模型未提供可识别的结束原因，本次文档未写入。请检查模型响应与服务端日志。',
      [ENRICHMENT_ERROR_CODES.REFUSED]: '模型拒绝了本次知识提取，本次文档未写入。请检查输入内容或更换模型。',
    }
    return c.json({ error: { code: error.code, message: enrichmentMessages[error.code] ?? (parseError ? '文档语法无效，请检查 MDX 内容。' : invalid ? error.message : error.code === VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE ? 'Embedding 与知识库向量空间不一致，请使用入库时的供应商、模型和维度。' : '操作未完成，请检查服务配置或稍后重试。') }, requestId: c.get('requestId') }, status)
  }
  if (error instanceof HTTPException) {
    return c.json(
      {
        error: { code: HTTP_ERROR_CODES.HTTP_ERROR, message: error.message },
        requestId: c.get('requestId'),
      },
      error.status,
    )
  }
  return c.json(
    {
      error: {
        code: HTTP_ERROR_CODES.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
      requestId: c.get('requestId'),
    },
    500,
  )
})
