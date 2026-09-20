import type { Attributes } from '@opentelemetry/api'
import type { RequestIdVariables } from 'hono/request-id'
import { isSpanContextValid, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import { log } from '../../telemetry/logger.js'

const tracer = trace.getTracer('knowledge-server')

export const tracingMiddleware = createMiddleware<{ Variables: RequestIdVariables }>(async (c, next) => {
  const parentContext = propagation.extract(ROOT_CONTEXT, c.req.header())
  const startedAt = performance.now()
  const attributes: Attributes = {
    'http.request.method': c.req.method,
    'url.path': c.req.path,
    'request.id': c.get('requestId'),
  }

  return tracer.startActiveSpan(c.req.method, { kind: SpanKind.SERVER, attributes }, parentContext, async (span) => {
    const spanContext = span.spanContext()
    if (isSpanContextValid(spanContext))
      c.header('X-Trace-Id', spanContext.traceId)

    let failure: unknown
    try {
      await next()
    }
    catch (error) {
      failure = error
      throw error
    }
    finally {
      // Hono handles route exceptions before returning from next().
      const error = c.error ?? failure
      const status = failure ? 500 : c.res.status
      const route = matchedRoutes(c).findLast(item => item.method !== 'ALL')?.path
      if (route) {
        attributes['http.route'] = route
        span.updateName(`${c.req.method} ${route}`)
      }
      attributes['http.response.status_code'] = status
      attributes['http.server.request.duration_ms'] = performance.now() - startedAt
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        if (error instanceof Error) {
          span.recordException(error)
          attributes['exception.type'] = error.name
          attributes['exception.message'] = error.message
          attributes['exception.stacktrace'] = error.stack
        }
      }
      span.setAttributes(attributes)
      // Emit while the span is active so the SDK attaches traceId and spanId.
      const write = status >= 500 ? log.error : status >= 400 ? log.warn : log.info
      write('http.request.completed', attributes)
      span.end()
    }
  })
})
