import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { HTTP_ERROR_CODES } from '../error-codes.js'
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
