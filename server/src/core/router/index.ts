import { Hono } from 'hono'
import { healthRouter } from './health.js'

export const apiRouter = new Hono().route('/health', healthRouter)
