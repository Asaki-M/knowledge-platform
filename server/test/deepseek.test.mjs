import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import process from 'node:process'
import test from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the shared error identity across compiled modules.
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled public module in integration tests.
import { DeepSeekAdapter, LlmClient } from '../dist/llm/index.js'

const messages = [
  { role: 'system', content: 'Answer from the supplied context.' },
  { role: 'user', content: 'First question' },
  { role: 'assistant', content: 'Previous answer' },
  { role: 'user', content: 'Follow-up question' },
]

function responseBody(model) {
  return {
    id: 'chat_test',
    object: 'chat.completion',
    model: `served-${model}`,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Answer from SDK', reasoning_content: 'private-reasoning' },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }
}

test('DeepSeek via OpenAI SDK maps the common contract, refusals, partial responses and errors', { timeout: 15000 }, async (t) => {
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
    if (body.model === 'length' || body.model === 'filter')
      response.choices[0].finish_reason = body.model === 'length' ? 'length' : 'content_filter'
    if (body.model === 'refusal') {
      response.choices[0].message.content = null
      response.choices[0].message.refusal = 'Request declined'
    }
    if (body.model === 'no-usage')
      delete response.usage
    if (body.model === 'empty')
      response.choices[0].message.content = null
    if (body.model === 'empty-length') {
      response.choices[0].message.content = null
      response.choices[0].finish_reason = 'length'
    }
    if (body.model === 'no-choices')
      response.choices = []
    if (body.model === 'missing-choices')
      delete response.choices
    if (body.model === 'multiple-choices')
      response.choices.push(response.choices[0])
    if (body.model === 'missing-message')
      delete response.choices[0].message
    if (body.model === 'bad-content')
      response.choices[0].message.content = 123
    if (body.model === 'bad-usage')
      delete response.usage.prompt_tokens
    if (body.model === 'unknown')
      response.choices[0].finish_reason = 'tool_calls'
    if (body.model === 'insufficient')
      response.choices[0].finish_reason = 'insufficient_system_resource'
    res.end(JSON.stringify(response))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const options = { apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 }
  const client = new LlmClient([new DeepSeekAdapter(options)])
  const input = { provider: 'deepseek', model: 'complete', messages, maxOutputTokens: 256, temperature: 0.2 }
  const result = await client.generate(input)
  assert.deepEqual(result, {
    id: 'chat_test',
    provider: 'deepseek',
    model: 'served-complete',
    text: 'Answer from SDK',
    finishReason: 'stop',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    requestId: 'req_test',
    refusal: undefined,
  })
  assert.equal(requests[0].path, '/v1/chat/completions')
  assert.equal(requests[0].authorization, 'Bearer test-key')
  assert.deepEqual(requests[0].body, {
    model: 'complete',
    messages,
    max_tokens: 256,
    temperature: 0.2,
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
  for (const model of ['unknown', 'insufficient'])
    assert.equal((await client.generate({ ...input, model })).finishReason, 'unknown')
  const emptyPartial = await client.generate({ ...input, model: 'empty-length' })
  assert.equal(emptyPartial.text, '')
  assert.equal(emptyPartial.finishReason, 'length')
  await client.generate({ provider: 'deepseek', model: 'complete', messages })
  assert.ok(!('temperature' in requests.at(-1).body))
  assert.ok(!('max_tokens' in requests.at(-1).body))

  for (const [status, code, retryable] of [[400, 'INVALID_REQUEST', false], [401, 'AUTHENTICATION_ERROR', false], [403, 'AUTHENTICATION_ERROR', false], [429, 'RATE_LIMITED', true], [500, 'PROVIDER_ERROR', true]]) {
    await assert.rejects(client.generate({ ...input, model: `http-${status}` }), (error) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, code)
      assert.equal(error.provider, 'deepseek')
      assert.equal(error.status, status)
      assert.equal(error.requestId, 'req_test')
      assert.equal(error.retryable, retryable)
      assert.ok(!error.message.includes('private-upstream-content'))
      return true
    })
  }
  for (const [model, code] of ['empty', 'no-choices', 'missing-choices', 'multiple-choices', 'missing-message', 'bad-content', 'bad-usage'].map(model => [model, 'INVALID_RESPONSE']).concat([['connection', 'CONNECTION_ERROR']]))
    await assert.rejects(client.generate({ ...input, model }), { name: 'AppError', code })

  const timeoutClient = new LlmClient([new DeepSeekAdapter({ ...options, timeoutMs: 30 })])
  await assert.rejects(timeoutClient.generate({ ...input, model: 'slow' }), { code: 'TIMEOUT', retryable: true })
  await assert.rejects(client.generate({ ...input, model: 'slow', signal: AbortSignal.timeout(30) }), { code: 'ABORTED', retryable: false })
  const count = requests.length
  await assert.rejects(client.generate({ ...input, signal: AbortSignal.abort() }), { code: 'ABORTED' })
  assert.equal(requests.length, count)
})

test('DeepSeek reads its own environment and explicit configuration takes precedence', async (t) => {
  const names = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined)
        delete process.env[name]
      else
        process.env[name] = original[name]
    }
  })
  delete process.env.DEEPSEEK_API_KEY
  process.env.OPENAI_API_KEY = 'unrelated-openai-key'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1'
  assert.throws(() => new DeepSeekAdapter(), { code: 'CONFIGURATION_ERROR', provider: 'deepseek' })
  for (const options of [{ apiKey: '' }, { apiKey: 'test', timeoutMs: 0 }, { apiKey: 'test', maxRetries: -1 }])
    assert.throws(() => new DeepSeekAdapter(options), { code: 'CONFIGURATION_ERROR', provider: 'deepseek' })
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req)
      chunks.push(chunk)
    requests.push({ path: req.url, authorization: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(responseBody(JSON.parse(Buffer.concat(chunks).toString()).model)))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  process.env.DEEPSEEK_API_KEY = 'env-deepseek-key'
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`
  const input = { provider: 'deepseek', model: 'explicit-model', messages }
  await new LlmClient([new DeepSeekAdapter({ maxRetries: 0 })]).generate(input)
  await new LlmClient([new DeepSeekAdapter({ apiKey: 'explicit-key', baseURL: `${process.env.DEEPSEEK_BASE_URL}/v1`, maxRetries: 0 })]).generate(input)
  assert.deepEqual(requests, [
    { path: '/chat/completions', authorization: 'Bearer env-deepseek-key' },
    { path: '/v1/chat/completions', authorization: 'Bearer explicit-key' },
  ])
})
