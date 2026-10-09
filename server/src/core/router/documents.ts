import type { OperationLogEnv } from '../middleware/operation-logging.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { stream } from 'hono/streaming'
import { isRecord } from '../../utils/type-guards.js'
import { errorResponse } from '../error-response.js'
import { operationLogging } from '../middleware/operation-logging.js'
import { ingest, ingestionTask, interruptIngestion, withIngestionId } from '../service/documents.js'

export const documentsRouter = new Hono<OperationLogEnv>()
  .get('/ingestions/:id', async c => c.json(await ingestionTask(c.req.param('id'))))
  .post('/ingestions/:id/interrupt', async c => c.json(await interruptIngestion(c.req.param('id'))))
  .post('/ingest', operationLogging('ingestion'), bodyLimit({ maxSize: 1048576 }), async (c) => {
    const body: unknown = withIngestionId(await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    }))
    const operation = c.get('operationLog')
    if (c.req.header('Accept') !== 'application/x-ndjson')
      return c.json(await ingest(body, c.req.raw.signal, operation, undefined, c.get('requestId')))

    operation.completionDeferred = true
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
    c.header('Cache-Control', 'no-store')
    c.header('X-Accel-Buffering', 'no')
    c.header('X-Content-Type-Options', 'nosniff')
    return stream(c, async (output) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
      output.onAbort(() => controller.abort())
      // 断开连接只取消后续处理，不能把已提交的事务改写为失败。
      const send = async (event: unknown) => {
        if (signal.aborted)
          return
        try {
          await output.writeln(JSON.stringify(event))
        }
        catch { controller.abort() }
      }
      const heartbeat = setInterval(() => {
        void send({ type: 'ping' })
      }, 15000)
      try {
        await send({ type: 'start', requestId: c.get('requestId'), ...(isRecord(body) && typeof body.ingestionId === 'string' && /^[0-9a-f-]{36}$/i.test(body.ingestionId) ? { ingestionId: body.ingestionId } : {}) })
        const result = await ingest(body, signal, operation, stage => send({ type: 'stage', stage }), c.get('requestId'))
        await operation.finish(200)
        await send({ type: 'result', result })
      }
      catch (error) {
        const failure = errorResponse(error, c.get('requestId'))
        await operation.finish(failure.status, error)
        await send({ type: 'error', ...failure.body })
      }
      finally { clearInterval(heartbeat) }
    })
  })
