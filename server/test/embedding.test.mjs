import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 验证构建后的统一异常契约。
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- 使用真实 SDK 访问本地模拟服务。
import { EMBEDDING_ERROR_CODES as CODES, EmbeddingClient, GoogleEmbeddingAdapter, SiliconFlowEmbeddingAdapter } from '../dist/rag/embedding/index.js'

async function mockApi(t) {
  const requests = []
  const api = { status: 200, mode: 'ok', requests }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req)
      chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-request-id', 'request-test')
    res.setHeader('x-siliconcloud-trace-id', 'silicon-test')
    if (api.mode === 'connection') {
      req.socket.destroy()
      return
    }
    if (api.mode === 'slow')
      return
    if (api.status !== 200) {
      res.writeHead(api.status).end(JSON.stringify({ error: { code: api.status, message: 'private-upstream-body' } }))
      return
    }
    if (api.mode === 'invalid-json') {
      res.end('not-json-private-upstream-body')
      return
    }
    if (api.mode === 'null-response') {
      res.end('null')
      return
    }
    const google = req.url.includes('batchEmbedContents')
    const count = google ? body.requests.length : body.input.length
    const vectors = Array.from({ length: count }, (_, index) => [index + 1, 0.5, -0.25])
    if (api.mode === 'empty-vector')
      vectors[0] = []
    if (api.mode === 'bad-number')
      vectors[0][0] = null
    if (api.mode === 'wrong-dimensions')
      vectors[0].push(0.25)
    if (api.mode === 'missing')
      vectors.pop()
    let response
    if (google) {
      response = { embeddings: vectors.map(values => ({ values })) }
    }
    else {
      const data = vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })).reverse()
      if (api.mode === 'duplicate-index')
        data[0].index = data[1].index
      if (api.mode === 'bad-index')
        data[0].index = count
      response = { object: 'list', model: body.model, data, usage: { prompt_tokens: 5, total_tokens: 5 } }
      if (api.mode === 'no-usage')
        delete response.usage
      if (api.mode === 'bad-usage')
        response.usage.prompt_tokens = -1
    }
    res.end(JSON.stringify(response))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  api.baseURL = `http://127.0.0.1:${server.address().port}`
  return api
}

function createClient(provider, baseURL, timeoutMs = 2000) {
  const options = { apiKey: 'test-key', baseURL, timeoutMs }
  return new EmbeddingClient([provider === 'google'
    ? new GoogleEmbeddingAdapter(options)
    : new SiliconFlowEmbeddingAdapter({ ...options, baseURL: `${baseURL}/v1` })])
}

function isError(code, provider, retryable = false) {
  return (error) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, code)
    if (provider)
      assert.equal(error.provider, provider)
    assert.equal(error.retryable, retryable)
    assert.ok(!error.message.includes('private-upstream-body'))
    assert.ok(!error.message.includes('test-key'))
    return true
  }
}

test('SiliconFlow SDK sends float embeddings, restores indices and retains usage and trace ID', async (t) => {
  const api = await mockApi(t)
  const client = createClient('siliconflow', api.baseURL)
  const request = { provider: 'siliconflow', model: 'BAAI/bge-m3', input: ['中文文档', 'English document'] }
  const result = await client.embed(request)
  assert.deepEqual(result, {
    provider: 'siliconflow',
    model: request.model,
    embeddings: [[1, 0.5, -0.25], [2, 0.5, -0.25]],
    dimensions: 3,
    usage: { inputTokens: 5, totalTokens: 5 },
    requestId: 'silicon-test',
  })
  assert.equal(api.requests[0].path, '/v1/embeddings')
  assert.equal(api.requests[0].headers.authorization, 'Bearer test-key')
  assert.deepEqual(api.requests[0].body, { model: request.model, input: request.input, encoding_format: 'float' })
  await client.embed({ ...request, model: 'Qwen/Qwen3-Embedding-0.6B', dimensions: 3 })
  assert.equal(api.requests[1].body.dimensions, 3)
  api.mode = 'no-usage'
  assert.equal((await client.embed(request)).usage, null)
  for (const mode of ['duplicate-index', 'bad-index', 'bad-usage']) {
    api.mode = mode
    await assert.rejects(client.embed(request), isError(CODES.INVALID_RESPONSE, 'siliconflow'))
  }
})

test('Google SDK preserves separate inputs for Embedding 2 and uses synchronous batchEmbedContents', async (t) => {
  const api = await mockApi(t)
  const client = createClient('google', api.baseURL)
  const request = { provider: 'google', model: 'gemini-embedding-2', input: ['中文文档', 'English document'], dimensions: 3 }
  const result = await client.embed(request)
  assert.deepEqual(result.embeddings, [[1, 0.5, -0.25], [2, 0.5, -0.25]])
  assert.equal(result.model, request.model)
  assert.equal(result.dimensions, 3)
  assert.equal(result.usage, null)
  assert.equal(result.requestId, 'request-test')
  assert.equal(api.requests[0].path, '/v1beta/models/gemini-embedding-2:batchEmbedContents')
  assert.equal(api.requests[0].headers['x-goog-api-key'], 'test-key')
  assert.equal(api.requests[0].headers.authorization, undefined)
  assert.deepEqual(api.requests[0].body.requests.map(item => ({ model: item.model, content: item.content, dimensions: item.outputDimensionality })), request.input.map(text => ({
    model: 'models/gemini-embedding-2',
    content: { parts: [{ text }] },
    dimensions: 3,
  })))
  await client.embed({ ...request, input: ['单条文本'], dimensions: undefined })
  assert.equal(api.requests[1].body.requests.length, 1)
  assert.equal(api.requests[1].body.requests[0].outputDimensionality, undefined)
})

for (const provider of ['siliconflow', 'google']) {
  test(`${provider}: invalid vectors, count, dimensions and JSON fail without partial success`, async (t) => {
    const api = await mockApi(t)
    const client = createClient(provider, api.baseURL)
    const request = { provider, model: 'test-model', input: ['one', 'two'] }
    for (const mode of ['missing', 'empty-vector', 'bad-number', 'wrong-dimensions', 'invalid-json', 'null-response']) {
      api.mode = mode
      await assert.rejects(client.embed(request), isError(CODES.INVALID_RESPONSE, provider))
    }
    api.mode = 'ok'
    const model = provider === 'siliconflow' ? 'Qwen/Qwen3-Embedding-0.6B' : request.model
    await assert.rejects(client.embed({ ...request, model, dimensions: 4 }), isError(CODES.INVALID_RESPONSE, provider))
  })

  test(`${provider}: HTTP errors preserve classification and retryability without retrying`, async (t) => {
    const api = await mockApi(t)
    const client = createClient(provider, api.baseURL)
    for (const [status, code, retryable] of [
      [400, CODES.INVALID_REQUEST, false],
      [401, CODES.AUTHENTICATION_ERROR, false],
      [403, CODES.AUTHENTICATION_ERROR, false],
      [404, CODES.INVALID_REQUEST, false],
      [429, CODES.RATE_LIMITED, true],
      [503, CODES.PROVIDER_ERROR, true],
      [504, CODES.TIMEOUT, true],
    ]) {
      api.status = status
      const before = api.requests.length
      await assert.rejects(client.embed({ provider, model: 'test-model', input: ['private-text'] }), (error) => {
        isError(code, provider, retryable)(error)
        assert.equal(error.status, status)
        if (provider === 'siliconflow')
          assert.equal(error.requestId, 'silicon-test')
        return true
      })
      assert.equal(api.requests.length, before + 1)
    }
  })

  test(`${provider}: cancellation, timeout and connection failures remain distinct`, async (t) => {
    const api = await mockApi(t)
    const client = createClient(provider, api.baseURL, 100)
    const request = { provider, model: 'test-model', input: ['private-text'] }
    await assert.rejects(client.embed({ ...request, signal: AbortSignal.abort() }), isError(CODES.ABORTED, provider))
    assert.equal(api.requests.length, 0)
    api.mode = 'slow'
    await assert.rejects(client.embed(request), isError(CODES.TIMEOUT, provider, true))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20)
    try {
      await assert.rejects(client.embed({ ...request, signal: controller.signal }), isError(CODES.ABORTED, provider))
    }
    finally {
      clearTimeout(timer)
    }
    api.mode = 'connection'
    await assert.rejects(client.embed(request), isError(CODES.CONNECTION_ERROR, provider, true))
  })
}

test('registration and common inputs fail before invoking adapters; snapshots preserve request identity', async () => {
  let calls = 0
  const adapter = {
    provider: 'test',
    async embed(request) {
      calls++
      await new Promise(resolve => setImmediate(resolve))
      return { provider: 'test', model: request.model, embeddings: request.input.map(() => [1]), dimensions: 1, usage: null }
    },
  }
  const client = new EmbeddingClient([adapter])
  assert.throws(() => client.register(adapter), isError(CODES.CONFIGURATION_ERROR))
  assert.throws(() => client.register({ provider: ' ', embed() {} }), isError(CODES.CONFIGURATION_ERROR))
  const valid = { provider: 'test', model: 'test-model', input: ['text'] }
  for (const overrides of [{ input: [] }, { input: [' '] }, { input: Array.from({ length: 1 }) }, { input: [null] }, { input: 'text' }, { model: '' }, { dimensions: 0 }, { dimensions: 1.5 }, { dimensions: Infinity }])
    await assert.rejects(client.embed({ ...valid, ...overrides }), isError(CODES.INVALID_REQUEST))
  await assert.rejects(client.embed({ ...valid, provider: 'missing' }), isError(CODES.PROVIDER_NOT_FOUND, 'missing'))
  assert.equal(calls, 0)
  const pending = client.embed(valid)
  valid.input.push('later modification')
  assert.equal((await pending).embeddings.length, 1)
  const broken = new EmbeddingClient([{
    provider: 'test',
    async embed() {
      throw new Error('private-upstream-body')
    },
  }])
  await assert.rejects(broken.embed(valid), isError(CODES.PROVIDER_ERROR, 'test'))
})

test('adapter configuration and provider limits reject unsupported operations locally', async (t) => {
  for (const Adapter of [SiliconFlowEmbeddingAdapter, GoogleEmbeddingAdapter]) {
    assert.throws(() => new Adapter({ apiKey: '' }), isError(CODES.CONFIGURATION_ERROR))
    for (const timeoutMs of [0, -1, Infinity, 2147483648])
      assert.throws(() => new Adapter({ apiKey: 'test-key', timeoutMs }), isError(CODES.CONFIGURATION_ERROR))
  }
  const api = await mockApi(t)
  const siliconflow = createClient('siliconflow', api.baseURL)
  await assert.rejects(siliconflow.embed({ provider: 'siliconflow', model: 'BAAI/bge-m3', input: ['text'], dimensions: 768 }), isError(CODES.INVALID_REQUEST, 'siliconflow'))
  for (const [provider, size] of [['siliconflow', 33], ['google', 101]])
    await assert.rejects(createClient(provider, api.baseURL).embed({ provider, model: 'test-model', input: Array.from({ length: size }).fill('text') }), isError(CODES.INVALID_REQUEST, provider))
  assert.equal(api.requests.length, 0)
})
