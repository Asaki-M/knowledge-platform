import type { OperationLogEnv } from '../middleware/operation-logging.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { operationLogging } from '../middleware/operation-logging.js'
import { ingest } from '../service/documents.js'

export const documentsRouter = new Hono<OperationLogEnv>()
  .post('/ingest', operationLogging('ingestion'), bodyLimit({ maxSize: 1048576 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    })
    return c.json(await ingest(body, c.req.raw.signal, c.get('operationLog')))
  })
