import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { ingest } from '../service/documents.js'

export const documentsRouter = new Hono()
  .use('*', bodyLimit({ maxSize: 1048576 }))
  .post('/ingest', async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    })
    return c.json(await ingest(body, c.req.raw.signal))
  })
