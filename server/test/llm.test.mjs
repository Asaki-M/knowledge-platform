import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the shared error identity across compiled modules.
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled public module in integration tests.
import { LlmClient, OpenAIAdapter } from '../dist/llm/index.js'

const messages = [
  { role: 'system', content: 'Answer from the supplied context.' },
  { role: 'user', content: 'First question' },
  { role: 'assistant', content: 'Previous answer' },
  { role: 'user', content: 'Follow-up question' },
]

function responseBody(model) {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    model: `served-${model}`,
    error: null,
    incomplete_details: null,
    output: [{
      type: 'message',
      id: 'msg_test',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Answer from SDK', annotations: [] }],
    }],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  }
}

test('OpenAI SDK maps the common contract, refusals, partial responses and errors', { timeout: 15000 }, async (t) => {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req)
      chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ body, path: req.url, authorization: req.headers.authorization })
    res.setHeader('x-request-id', 'req_test')
    res.setHeader('content-type', 'application/json')
    if (body.model.startsWith('http-')) {
      res.writeHead(Number(body.model.slice(5))).end(JSON.stringify({ error: { message: 'private-upstream-content', type: 'test_error' } }))
      return
    }
    if (body.model === 'connection') {
      req.socket.destroy()
      return
    }
    if (body.model === 'slow') {
      setTimeout(() => res.end(JSON.stringify(responseBody(body.model))), 150)
      return
    }
    const response = responseBody(body.model)
    if (body.model === 'length' || body.model === 'filter') {
      response.status = 'incomplete'
      response.incomplete_details = { reason: body.model === 'length' ? 'max_output_tokens' : 'content_filter' }
    }
    if (body.model === 'refusal')
      response.output[0].content = [{ type: 'refusal', refusal: 'Request declined' }]
    if (body.model === 'no-usage')
      delete response.usage
    if (body.model === 'failed') {
      response.status = 'failed'
      response.error = { code: 'server_error', message: 'private-upstream-content' }
    }
    if (body.model === 'queued')
      response.status = 'queued'
    if (body.model === 'empty')
      response.output = []
    res.end(JSON.stringify(response))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const options = { apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 }
  const client = new LlmClient([new OpenAIAdapter(options)])
  const input = { provider: 'openai', model: 'complete', messages, maxOutputTokens: 256, temperature: 0.2 }
  const result = await client.generate(input)
  assert.deepEqual(result, {
    id: 'resp_test',
    provider: 'openai',
    model: 'served-complete',
    text: 'Answer from SDK',
    finishReason: 'stop',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    requestId: 'req_test',
    refusal: undefined,
  })
  assert.equal(requests[0].path, '/v1/responses')
  assert.equal(requests[0].authorization, 'Bearer test-key')
  assert.deepEqual(requests[0].body, {
    model: 'complete',
    input: messages,
    max_output_tokens: 256,
    temperature: 0.2,
    store: false,
    stream: false,
  })
  for (const [model, finishReason] of [['length', 'length'], ['filter', 'content_filter'], ['refusal', 'refusal']]) {
    const response = await client.generate({ ...input, model })
    assert.equal(response.finishReason, finishReason)
    if (model === 'refusal') {
      assert.equal(response.text, '')
      assert.equal(response.refusal, 'Request declined')
    }
  }
  assert.equal((await client.generate({ ...input, model: 'no-usage' })).usage, null)
  await client.generate({ provider: 'openai', model: 'complete', messages })
  assert.ok(!('temperature' in requests.at(-1).body))
  assert.ok(!('max_output_tokens' in requests.at(-1).body))

  for (const [status, code, retryable] of [[400, 'INVALID_REQUEST', false], [401, 'AUTHENTICATION_ERROR', false], [403, 'AUTHENTICATION_ERROR', false], [429, 'RATE_LIMITED', true], [500, 'PROVIDER_ERROR', true]]) {
    await assert.rejects(client.generate({ ...input, model: `http-${status}` }), (error) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      assert.equal(error.requestId, 'req_test')
      assert.equal(error.retryable, retryable)
      assert.ok(!error.message.includes('private-upstream-content'))
      return true
    })
  }
  for (const [model, code] of [['failed', 'PROVIDER_ERROR'], ['queued', 'INVALID_RESPONSE'], ['empty', 'INVALID_RESPONSE'], ['connection', 'CONNECTION_ERROR']])
    await assert.rejects(client.generate({ ...input, model }), { name: 'AppError', code })

  const timeoutClient = new LlmClient([new OpenAIAdapter({ ...options, timeoutMs: 30 })])
  await assert.rejects(timeoutClient.generate({ ...input, model: 'slow' }), { code: 'TIMEOUT', retryable: true })
  await assert.rejects(client.generate({ ...input, model: 'slow', signal: AbortSignal.timeout(30) }), { code: 'ABORTED', retryable: false })
  const count = requests.length
  await assert.rejects(client.generate({ ...input, signal: AbortSignal.abort() }), { code: 'ABORTED' })
  assert.equal(requests.length, count)
})

test('new adapters plug in without SDK types and invalid input fails before invocation', async () => {
  const calls = []
  const adapter = {
    provider: 'another-sdk',
    async generate(request) {
      calls.push(request)
      return { id: 'other-response', provider: 'another-sdk', model: request.model, text: 'Other answer', finishReason: 'stop', usage: null }
    },
  }
  const client = new LlmClient().register(adapter)
  const input = { provider: 'another-sdk', model: 'other-model', messages }
  assert.equal((await client.generate(input)).text, 'Other answer')
  assert.deepEqual(calls[0], { model: 'other-model', messages })
  assert.throws(() => client.register(adapter), { code: 'CONFIGURATION_ERROR' })
  await assert.rejects(client.generate({ ...input, provider: 'missing' }), { code: 'PROVIDER_NOT_FOUND' })
  for (const invalid of [{ model: '' }, { messages: [] }, { messages: [{ role: 'tool', content: 'unsupported' }] }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { temperature: Number.NaN }, { temperature: 3 }])
    await assert.rejects(client.generate({ ...input, ...invalid }), { code: 'INVALID_REQUEST' })
  assert.equal(calls.length, 1)
  assert.throws(() => new OpenAIAdapter({ apiKey: '' }), { code: 'CONFIGURATION_ERROR' })
  assert.throws(() => new OpenAIAdapter({ apiKey: 'test', timeoutMs: 0 }), { code: 'CONFIGURATION_ERROR' })
  assert.throws(() => new OpenAIAdapter({ apiKey: 'test', maxRetries: -1 }), { code: 'CONFIGURATION_ERROR' })
})
