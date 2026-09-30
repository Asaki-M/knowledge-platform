import { Hono } from 'hono'
import { getOperationLog, listOperationLogs } from '../service/operation-logs.js'

export const logsRouter = new Hono()
  .get('/', async c => c.json(await listOperationLogs(c.req.query())))
  .get('/:id', async c => c.json(await getOperationLog(c.req.param('id'))))
