import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { HTTP_ERROR_CODES } from '../error-codes.js'
import { errorResponse } from './error-response.js'
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
  const { body, status } = errorResponse(error, c.get('requestId'))
  return c.json(body, status)
})
