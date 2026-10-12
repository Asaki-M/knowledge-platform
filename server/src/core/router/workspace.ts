import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { createKnowledgeBase, updateKnowledgeBaseDescription } from '../service/knowledge-bases.js'
import { workspaceOptions } from '../service/workspace-options.js'

export const workspaceRouter = new Hono()
  .get('/options', async c => c.json(await workspaceOptions()))
  .post('/knowledge-bases', bodyLimit({ maxSize: 16384 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    })
    return c.json(await createKnowledgeBase(body), 201)
  })
  .patch('/knowledge-bases/:id', bodyLimit({ maxSize: 16384 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    })
    return c.json(await updateKnowledgeBaseDescription(c.req.param('id'), body))
  })
