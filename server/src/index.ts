import process from 'node:process'
import { serve } from '@hono/node-server'
import { log } from './telemetry/logger.js'
import { shutdownTelemetry } from './telemetry/sdk.js'

// eslint-disable-next-line antfu/no-top-level-await -- Register telemetry providers before loading routes.
const { app } = await import('./core/app.js')

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? '127.0.0.1'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  log.info('server.started', { 'server.address': hostname, 'server.port': info.port })
})

let closing = false

async function shutdown(signal: string) {
  if (closing)
    return
  closing = true
  const timeout = setTimeout(() => process.exit(1), 10000)
  timeout.unref()
  try {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    log.info('server.stopped', { signal })
    await shutdownTelemetry()
  }
  catch (error) {
    // Telemetry may already be unavailable during shutdown.
    console.error('Failed to shut down cleanly', error)
    process.exitCode = 1
  }
  finally {
    clearTimeout(timeout)
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
