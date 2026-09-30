import { Hono } from 'hono'
import { workspaceOptions } from '../service/workspace-options.js'

export const workspaceRouter = new Hono().get('/options', async c => c.json(await workspaceOptions()))
