import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import process from 'node:process'
import test from 'node:test'

function attributes(record) {
  return Object.fromEntries((record.attributes ?? []).map(({ key, value }) => [
    key,
    value.stringValue ?? Number(value.intValue ?? value.doubleValue),
  ]))
}

test('HTTP logs and spans reach OTLP with propagation, isolated contexts, errors and shutdown flush', { timeout: 20000 }, async (t) => {
  const exports = []
  const collector = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req)
      chunks.push(chunk)
    exports.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  collector.listen(0, '127.0.0.1')
  await once(collector, 'listening')
  t.after(() => new Promise(resolve => collector.close(resolve)))

  const portReservation = createServer()
  portReservation.listen(0, '127.0.0.1')
  await once(portReservation, 'listening')
  const port = portReservation.address().port
  await new Promise(resolve => portReservation.close(resolve))

  // Test-only routes never enter the production app or build.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    await import('./dist/telemetry/sdk.js')
    const { app } = await import('./dist/core/app.js')
    const { log } = await import('./dist/telemetry/logger.js')
    app.get('/test/failure', () => { throw new Error('test-only-failure') })
    app.get('/test/work/:id', async (c) => {
      await new Promise(resolve => setTimeout(resolve, Number(c.req.param('id'))))
      log.info('test.work', { 'work.id': c.req.param('id') })
      return c.text('ok')
    })
    await import('./dist/index.js')
    await new Promise(setImmediate)
    process.send('ready')
    process.disconnect()
  `], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_'))),
      HOST: '127.0.0.1',
      PORT: String(port),
      OTEL_SERVICE_NAME: 'knowledge-test',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
      // Keep records buffered until SIGTERM to exercise shutdown flushing.
      OTEL_BSP_SCHEDULE_DELAY: '60000',
      OTEL_BLRP_SCHEDULE_DELAY: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', chunk => output += chunk)
  child.stderr.on('data', chunk => output += chunk)
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  })
  const exited = once(child, 'exit')
  const ready = await Promise.race([
    once(child, 'message').then(() => true),
    exited.then(() => false),
  ])
  assert.ok(ready, output)

  const base = `http://127.0.0.1:${port}`
  const upstreamTrace = '1234567890abcdef1234567890abcdef'
  const upstreamSpan = '1234567890abcdef'
  const health = await fetch(`${base}/api/health?token=must-not-be-logged`, {
    headers: {
      traceparent: `00-${upstreamTrace}-${upstreamSpan}-01`,
      authorization: 'Bearer must-not-be-logged',
    },
  })
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('x-trace-id'), upstreamTrace)
  const healthRequestId = health.headers.get('x-request-id')
  assert.ok(healthRequestId)
  await health.json()

  const missing = await fetch(`${base}/missing`)
  assert.equal(missing.status, 404)
  const missingTrace = missing.headers.get('x-trace-id')
  await missing.json()
  const failure = await fetch(`${base}/test/failure`)
  assert.equal(failure.status, 500)
  const failureTrace = failure.headers.get('x-trace-id')
  assert.equal((await failure.json()).error.message, 'Internal server error')

  const work = await Promise.all([25, 5].map(async (id) => {
    const response = await fetch(`${base}/test/work/${id}`)
    await response.text()
    return { id: String(id), traceId: response.headers.get('x-trace-id') }
  }))
  assert.notEqual(work[0].traceId, work[1].traceId)

  child.kill('SIGTERM')
  const [exitCode, signal] = await exited
  assert.equal(exitCode, 0, output)
  assert.equal(signal, null, output)

  const spans = exports.filter(item => item.path === '/v1/traces')
    .flatMap(item => item.body.resourceSpans)
    .flatMap((resource) => {
      assert.equal(attributes(resource.resource)['service.name'], 'knowledge-test')
      return resource.scopeSpans.flatMap(scope => scope.spans)
    })
  const logs = exports.filter(item => item.path === '/v1/logs')
    .flatMap(item => item.body.resourceLogs)
    .flatMap((resource) => {
      assert.equal(attributes(resource.resource)['service.name'], 'knowledge-test')
      return resource.scopeLogs.flatMap(scope => scope.logRecords)
    })
  assert.equal(spans.length, 5)
  const healthSpan = spans.find(span => span.traceId === upstreamTrace)
  assert.equal(healthSpan.parentSpanId, upstreamSpan)
  assert.equal(healthSpan.name, 'GET /api/health')
  assert.equal(attributes(healthSpan)['request.id'], healthRequestId)
  const completed = logs.filter(log => log.body.stringValue === 'http.request.completed')
  assert.equal(completed.length, 5)
  for (const span of spans) {
    const log = completed.find(item => item.spanId === span.spanId)
    assert.equal(log.traceId, span.traceId)
    assert.ok(attributes(log)['http.server.request.duration_ms'] >= 0)
  }
  assert.equal(completed.find(log => log.traceId === missingTrace).severityText, 'WARN')
  const errorSpan = spans.find(span => span.traceId === failureTrace)
  assert.equal(errorSpan.status.code, 2)
  assert.equal(errorSpan.events[0].name, 'exception')
  const errorLog = completed.find(log => log.traceId === failureTrace)
  assert.equal(errorLog.severityText, 'ERROR')
  assert.equal(attributes(errorLog)['exception.message'], 'test-only-failure')
  for (const item of work) {
    const log = logs.find(log => attributes(log)['work.id'] === item.id)
    assert.equal(log.traceId, item.traceId)
    assert.equal(spans.find(span => span.traceId === item.traceId).name, 'GET /test/work/:id')
  }
  assert.ok(logs.some(log => log.body.stringValue === 'server.stopped'))
  assert.ok(!JSON.stringify(exports).includes('must-not-be-logged'))
})
