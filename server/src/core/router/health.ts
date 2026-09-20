import { Hono } from 'hono'

export const healthRouter = new Hono().get('/', c =>
  c.json({
    status: 'ok',
    service: 'knowledge-server',
    timestamp: new Date().toISOString(),
  }))
