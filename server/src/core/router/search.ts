import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { search } from '../service/search.js'

export const searchRouter = new Hono()
  .use('*', bodyLimit({ maxSize: 32768 }))
  .post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    })
    return c.json(await search(body, c.req.raw.signal))
  })
