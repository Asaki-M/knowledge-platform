import { Hono } from 'hono'
import { documentsRouter } from './documents.js'
import { healthRouter } from './health.js'
import { logsRouter } from './logs.js'
import { searchRouter } from './search.js'
import { workspaceRouter } from './workspace.js'

export const apiRouter = new Hono().route('/health', healthRouter).route('/search', searchRouter).route('/documents', documentsRouter).route('/logs', logsRouter).route('/workspace', workspaceRouter)
