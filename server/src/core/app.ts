import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { HTTP_ERROR_CODES, QUERY_ERROR_CODES, VECTOR_STORE_ERROR_CODES } from '../error-codes.js'
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
    const invalid = error.code === QUERY_ERROR_CODES.INVALID_INPUT || error.code === QUERY_ERROR_CODES.CONTEXT_TOO_LARGE
    const status = invalid ? 400 : error.code === VECTOR_STORE_ERROR_CODES.CONFLICT ? 409 : error.code.endsWith('CONFIGURATION_ERROR') ? 503 : 502
    return c.json({ error: { code: error.code, message: invalid ? '请提供有效的知识库 ID 和问题；检索上下文不能超出预算。' : '检索回答未完成，请检查服务配置或稍后重试。' }, requestId: c.get('requestId') }, status)
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
