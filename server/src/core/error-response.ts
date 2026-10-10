import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { HTTPException } from 'hono/http-exception'
import { HTTP_ERROR_CODES } from '../error-codes.js'
import { AppError } from '../errors.js'
import { describeAppError } from './error-presentation.js'

function response(body: { error: { code: string, message: string }, requestId: string }, status: ContentfulStatusCode) {
  return { body, status }
}

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof AppError) {
    const { status, httpMessage } = describeAppError(error)
    return response({ error: { code: error.code, message: httpMessage }, requestId }, status)
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
