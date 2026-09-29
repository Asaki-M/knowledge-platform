import { Hono } from 'hono'
import { documentsRouter } from './documents.js'
import { healthRouter } from './health.js'
import { searchRouter } from './search.js'

export const apiRouter = new Hono().route('/health', healthRouter).route('/search', searchRouter).route('/documents', documentsRouter)
