import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import process from 'node:process'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 实际 HTTP 路由调用真实 SDK，本地模拟上游和存储。
import { app } from '../dist/core/app.js'
// eslint-disable-next-line antfu/no-import-dist -- 观察操作记录，常规测试不访问数据库。
import { OperationLogDao } from '../dist/core/dao/operation-logs.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证接口配置解析而不是复制其实现。
import { embeddingSelection, ingestionEmbeddingOptions, ingestionLlmOptions, llmOptions } from '../dist/core/service/model-options.js'

// eslint-disable-next-line antfu/no-import-dist -- 替换数据库边界，实际数据库原子性由独立集成测试验证。
import { PgVectorStore } from '../dist/rag/vector-store/index.js'
import { stubIngestionCheckpoints } from './ingestion-checkpoint-stub.mjs'

const content = '# Atlas\n\n生产环境必须使用 HTTPS。'
const enrichment = { summary: '生产环境协议要求。', keywords: ['HTTPS'], aliases: [], questions: [], entities: [], concepts: [{ id: 'c1', name: 'HTTPS', aliases: [], description: '生产环境协议要求', evidence: ['生产环境必须使用 HTTPS。'] }], relations: [], facts: [], knowledgeType: 'security-rule' }
const ingestBody = { knowledgeBaseId: 'test', document: { id: 'article', content }, llm: { provider: 'ds', model: 'llm-test' }, embedding: { provider: 'siliconflow', model: 'embed-test' } }
const post = (path, body, headers = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('API selectors accept DS/OpenAI and Gemini/SiliconFlow, reject invalid options before accessing storage', async () => {
  assert.equal(llmOptions({ provider: 'ds', model: 'test' }).provider, 'deepseek')
  assert.equal(llmOptions({ provider: 'openai', model: 'test' }).provider, 'openai')
  assert.equal(embeddingSelection({ provider: 'gemini' }).provider, 'google')
  assert.equal(ingestionEmbeddingOptions({ provider: 'google', model: 'embed', dimensions: 512 }).dimensions, 512)
  for (const llm of [null, 'ds', { provider: 'unknown' }, { provider: 'openai', model: '' }, { provider: 'ds', apiKey: 'not-accepted' }, { provider: 'ds', dimensions: 10 }]) {
    assert.equal((await post('/api/documents/ingest', { ...ingestBody, llm })).status, 400)
    assert.equal((await post('/api/search', { knowledgeBaseId: 'kb', question: 'test', llm })).status, 400)
  }
  for (const embedding of [null, 'gemini', { provider: 'unknown' }, { provider: 'gemini', dimensions: 0 }, { provider: 'gemini', baseURL: 'https://example.com' }])
    assert.equal((await post('/api/documents/ingest', { ...ingestBody, embedding })).status, 400)
  for (const document of [null, {}, { id: 'article', content: '' }, { id: 'article', content, format: 'pdf' }, { id: 'article', content, sourcePath: 1 }])
    assert.equal((await post('/api/documents/ingest', { ...ingestBody, document })).status, 400)
  assert.equal((await app.request('/api/documents/ingest', { method: 'POST', body: '{' })).status, 400)
  assert.equal((await app.request('/api/documents/ingest', { method: 'POST', body: 'x'.repeat(1048577) })).status, 413)
})

test('ingestion budgets include reasoning and validate overrides without changing query settings', (t) => {
  const previous = process.env.ENRICHMENT_MAX_OUTPUT_TOKENS
  t.after(() => {
    if (previous === undefined)
      delete process.env.ENRICHMENT_MAX_OUTPUT_TOKENS
    else
      process.env.ENRICHMENT_MAX_OUTPUT_TOKENS = previous
  })
  delete process.env.ENRICHMENT_MAX_OUTPUT_TOKENS
  assert.equal(ingestionLlmOptions({ provider: 'ds', model: 'test' }).maxOutputTokens, 32768)
  assert.equal(ingestionLlmOptions({ provider: 'openai', model: 'test' }).maxOutputTokens, 10000)
  process.env.ENRICHMENT_MAX_OUTPUT_TOKENS = '24000'
  assert.equal(ingestionLlmOptions({ provider: 'ds', model: 'test' }).maxOutputTokens, 24000)
  assert.deepEqual(llmOptions({ provider: 'ds', model: 'test' }), { provider: 'deepseek', model: 'test' })
  for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
    process.env.ENRICHMENT_MAX_OUTPUT_TOKENS = invalid
    assert.throws(() => ingestionLlmOptions({ provider: 'ds', model: 'test' }), { code: 'ENRICHMENT_CONFIGURATION_ERROR' })
  }
  process.env.ENRICHMENT_MAX_OUTPUT_TOKENS = '  '
  assert.equal(ingestionLlmOptions({ provider: 'ds', model: 'test' }).maxOutputTokens, 32768)
})

test('four HTTP model combinations normalize, enrich, embed, store and answer via actual SDK protocols', { timeout: 20000 }, async (t) => {
  stubIngestionCheckpoints(t)
  const completedLogs = []
  let logId = 0
  let nextCompletion
  t.mock.method(OperationLogDao.prototype, 'initialize', async () => {})
  t.mock.method(OperationLogDao.prototype, 'start', async input => `${input.type}-${++logId}`)
  t.mock.method(OperationLogDao.prototype, 'setScope', async () => {})
  t.mock.method(OperationLogDao.prototype, 'finish', async (id, input) => {
    completedLogs.push({ id, ...input })
    nextCompletion?.(input)
    nextCompletion = undefined
  })
  const calls = []
  let failEmbedding = false
  let failLlm = false
  let invalidEnrichment = false
  let invalidEvidence = false
  let unexpectedConceptField = false
  let finishReason = 'stop'
  let llmGate
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req)
      chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    calls.push({ path: req.url, body })
    res.setHeader('content-type', 'application/json')
    let response
    if (req.url.includes('embed')) {
      if (failEmbedding) {
        res.writeHead(500).end(JSON.stringify({ error: { message: 'private-error' } }))
        return
      }
      const google = req.url.includes('batchEmbedContents')
      const count = google ? body.requests.length : body.input.length
      const vectors = Array.from({ length: count }, (_, i) => [1, 0.5, (i + 1) / 10])
      response = google ? { embeddings: vectors.map(values => ({ values })) } : { model: body.model, data: vectors.map((embedding, index) => ({ index, embedding })), usage: { prompt_tokens: 4, total_tokens: 4 } }
    }
    else if (req.url.endsWith('/rerank')) {
      response = { results: Array.from({ length: body.top_n }, (_, index) => ({ index, relevance_score: 1 - index / 10 })) }
    }
    else {
      if (failLlm) {
        res.writeHead(500).end(JSON.stringify({ error: { message: 'private-llm-error' } }))
        return
      }
      const responses = req.url.endsWith('/responses')
      const openai = req.headers.authorization === 'Bearer openai-test'
      const input = responses ? body.input[1].content : body.messages[1].content
      const query = Boolean(JSON.parse(input).sources)
      if (!query && llmGate)
        await llmGate
      assert.equal(responses ? body.max_output_tokens : body.max_tokens, query ? 8000 : openai ? 10000 : 32768)
      if (!query) {
        assert.equal(responses, true)
        assert.equal(body.text.format.type, 'json_schema')
        assert.equal(body.text.format.schema.properties.concepts.items.additionalProperties, false)
        assert.equal(Object.hasOwn(body.text.format.schema.properties.concepts.items.properties, 'type'), false)
        assert.equal(body.text.format.strict, openai ? true : undefined)
      }
      else {
        assert.equal(body.text, undefined)
        assert.equal(responses, openai)
      }
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.thinking, undefined)
      const text = JSON.parse(input).sources ? '生产环境使用 HTTPS。[S1]' : invalidEnrichment ? '{}' : JSON.stringify(invalidEvidence ? { ...enrichment, concepts: [{ ...enrichment.concepts[0], evidence: ['private-invalid-evidence'] }] } : unexpectedConceptField ? { ...enrichment, concepts: [{ ...enrichment.concepts[0], type: 'private-extra-value' }] } : enrichment)
      response = responses
        ? { id: 'response', object: 'response', model: body.model, status: finishReason === 'stop' ? 'completed' : 'incomplete', incomplete_details: finishReason === 'stop' ? null : { reason: finishReason === 'length' ? 'max_output_tokens' : finishReason }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] }
        : { id: 'chat', model: body.model, choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: text } }] }
    }
    res.end(JSON.stringify(response))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const env = { ENRICHMENT_MAX_OUTPUT_TOKENS: '', VECTOR_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', DEEPSEEK_API_KEY: 'deepseek-test', DEEPSEEK_BASE_URL: `${baseURL}/v1`, OPENAI_API_KEY: 'openai-test', OPENAI_BASE_URL: `${baseURL}/v1`, GOOGLE_API_KEY: 'test', EMBEDDING_API_KEY: 'test', EMBEDDING_BASE_URL: `${baseURL}/v1`, RERANK_API_KEY: 'test', RERANK_BASE_URL: `${baseURL}/v1` }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })
  // Google SDK 的固定官方地址只在测试内改写，所有请求都必须命中本地模拟服务。
  const fetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.hostname === 'generativelanguage.googleapis.com')
      return fetch(`${baseURL}${url.pathname}${url.search}`, init)
    assert.equal(url.origin, baseURL)
    return fetch(input, init)
  })
  const saved = new Map()
  let writes = 0
  t.mock.method(PgVectorStore.prototype, 'initialize', async () => {})
  t.mock.method(PgVectorStore.prototype, 'close', async () => {})
  t.mock.method(PgVectorStore.prototype, 'getSnapshot', async kb => saved.get(kb)?.info ?? null)
  t.mock.method(PgVectorStore.prototype, 'replaceDocument', async (vectors, documentId, options) => {
    assert.equal(options.expectedRevision, saved.get(vectors.knowledgeBaseId)?.info.revision ?? null)
    assert.ok(vectors.chunks.every(record => record.sources.every(source => source.documentId === documentId)))
    const info = { knowledgeBaseId: vectors.knowledgeBaseId, revision: `revision-${++writes}`, provider: vectors.provider, requestedModel: vectors.requestedModel, model: vectors.model, dimensions: vectors.dimensions, chunks: vectors.chunks.length, wikiNodes: vectors.wikiNodes.length }
    saved.set(vectors.knowledgeBaseId, { vectors, info })
    return info
  })
  t.mock.method(PgVectorStore.prototype, 'searchDual', async (request) => {
    const { vectors, info } = saved.get(request.knowledgeBaseId)
    assert.equal(request.expectedRevision, info.revision)
    assert.equal(request.limit, 30)
    return { snapshotRevision: info.revision, chunks: vectors.chunks.map(document => ({ document, score: 0.9 })), wikiNodes: vectors.wikiNodes.map(document => ({ document, score: 0.8 })) }
  })
  for (const llm of ['ds', 'openai']) {
    for (const embedding of ['siliconflow', 'gemini']) {
      const body = { ...ingestBody, knowledgeBaseId: `${llm}-${embedding}`, llm: { provider: llm, model: 'llm-test' }, embedding: { provider: embedding, model: 'embed-test', ...(embedding === 'gemini' ? { dimensions: 3 } : {}) } }
      const response = await post('/api/documents/ingest', body)
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      assert.deepEqual(result.counts, { sections: 1, chunks: 1, wikiNodes: 1, wikiEdges: 0, vectors: 2 })
      assert.equal(completedLogs.at(-1).status, 'succeeded')
      assert.equal(completedLogs.at(-1).summary.resultStatus, 'stored')
      assert.deepEqual(completedLogs.at(-1).summary.counts, result.counts)
      assert.ok(completedLogs.at(-1).id.startsWith('ingestion-'))
      assert.equal(result.enrichment[0].provider, llm === 'ds' ? 'deepseek' : llm)
      assert.equal(result.embedding.provider, embedding === 'gemini' ? 'google' : embedding)
      const answerResponse = await post('/api/search', { knowledgeBaseId: body.knowledgeBaseId, question: '生产环境使用什么协议？', llm: body.llm, embedding: body.embedding })
      const answer = await answerResponse.json()
      assert.equal(answerResponse.status, 200, JSON.stringify(answer))
      assert.equal(answer.status, 'answered')
      assert.equal(answer.generation.provider, result.enrichment[0].provider)
      assert.equal(answer.embedding.provider, result.embedding.provider)
      assert.equal(answer.sources.length, 2)
      assert.equal(completedLogs.at(-1).status, 'succeeded')
      assert.equal(completedLogs.at(-1).summary.resultStatus, 'answered')
      assert.deepEqual(completedLogs.at(-1).summary.counts, answer.counts)
      assert.ok(completedLogs.at(-1).id.startsWith('query-'))
    }
  }
  // 即使模型返回可解析 JSON，非正常结束也不能入库；错误原因需贯通 HTTP 与操作日志。
  for (const [reason, code, message] of [
    ['length', 'ENRICHMENT_OUTPUT_TRUNCATED', '生成长度限制'],
    ['content_filter', 'ENRICHMENT_CONTENT_FILTERED', '内容过滤'],
    ['unknown', 'ENRICHMENT_INCOMPLETE_RESPONSE', '未正常结束'],
  ]) {
    finishReason = reason
    const beforeCalls = calls.length
    const response = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: `incomplete-${reason}` })
    const failure = await response.json()
    assert.equal(response.status, 502)
    assert.equal(failure.error.code, code)
    assert.ok(failure.error.message.includes(message))
    assert.ok(failure.requestId)
    assert.equal(completedLogs.at(-1).error.code, code)
    assert.ok(completedLogs.at(-1).error.message.includes(message))
    assert.equal(completedLogs.at(-1).status, 'failed')
    assert.equal(saved.has(`incomplete-${reason}`), false)
    assert.equal(calls.length - beforeCalls, 1)
    assert.equal(writes, 4)
  }
  finishReason = 'stop'
  failLlm = true
  const beforeFailure = calls.length
  const failedLlm = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'llm-failure' })
  assert.equal(failedLlm.status, 502)
  assert.equal(calls.length - beforeFailure, 1)
  assert.equal(saved.has('llm-failure'), false)
  assert.ok(!JSON.stringify(await failedLlm.json()).includes('private-llm-error'))
  failLlm = false
  const before = calls.length
  const mismatch = await post('/api/search', { knowledgeBaseId: 'ds-siliconflow', question: 'test', embedding: { provider: 'gemini' } })
  assert.equal(mismatch.status, 409)
  assert.equal(calls.length, before)
  const conflictingIngest = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'ds-siliconflow', embedding: { provider: 'gemini', model: 'embed-test' } })
  assert.equal(conflictingIngest.status, 409)
  assert.equal(calls.length, before)
  failEmbedding = true
  const failed = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'failure' })
  assert.equal(failed.status, 502)
  assert.equal(saved.has('failure'), false)
  failEmbedding = false
  invalidEnrichment = true
  assert.equal((await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'invalid-enrichment' })).status, 502)
  assert.equal((await post('/api/documents/ingest', { ...ingestBody, document: { id: 'invalid', content: '<Broken' } })).status, 400)
  assert.equal((await post('/api/documents/ingest', { ...ingestBody, document: { id: 'empty', content: '{/* comment */}' } })).status, 400)
  assert.equal(writes, 4)
  assert.ok(calls.some(call => call.path.endsWith('/responses')))
  assert.ok(calls.some(call => call.path.endsWith('/chat/completions')))
  assert.ok(calls.some(call => call.path.includes('batchEmbedContents')))

  // 先读到知识提取运行事件，再放行模型；验证响应不是处理完才一次性返回。
  invalidEnrichment = false
  let releaseLlm
  llmGate = new Promise((resolve) => {
    releaseLlm = resolve
  })
  const logsBeforeStream = completedLogs.length
  const streamResponse = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'stream-success' }, { Accept: 'application/x-ndjson' })
  assert.equal(streamResponse.status, 200)
  assert.ok(streamResponse.headers.get('content-type').includes('application/x-ndjson'))
  const reader = streamResponse.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  async function readEvents() {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines.filter(Boolean))
      events.push(JSON.parse(line))
    return done
  }
  while (!events.some(event => event.type === 'stage' && event.stage.id === 'enrichment'))
    assert.equal(await readEvents(), false)
  assert.equal(writes, 4)
  assert.equal(completedLogs.length, logsBeforeStream)
  releaseLlm()
  llmGate = undefined
  while (!await readEvents()) {
    // 持续读取每行事件直到服务端结束响应。
  }
  reader.releaseLock()
  const stages = events.filter(event => event.type === 'stage').map(event => event.stage)
  assert.deepEqual(stages.filter(stage => stage.status === 'completed').map(stage => stage.id), ['normalize', 'sections', 'chunks', 'enrichment', 'wiki', 'indexing', 'embedding', 'storage'])
  assert.ok(stages.some(stage => stage.id === 'enrichment' && stage.progress?.completed === 1 && stage.progress.total === 1))
  assert.ok(stages.every(stage => stage.durationMs >= 0))
  assert.ok(stages.find(stage => stage.id === 'normalize' && stage.preview).preview.items[0].text.includes('HTTPS'))
  assert.ok(stages.find(stage => stage.id === 'enrichment' && stage.preview).preview.items[0].text.includes('证据：生产环境必须使用 HTTPS。'))
  assert.ok(stages.find(stage => stage.id === 'wiki' && stage.preview).preview.items[0].text.includes('HTTPS'))
  assert.ok(!JSON.stringify(events).includes('"vector":'))
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).result.status, 'stored')
  assert.equal(events[0].requestId, streamResponse.headers.get('X-Request-Id'))
  assert.equal(completedLogs.at(-1).status, 'succeeded')
  assert.ok(!JSON.stringify(completedLogs.at(-1)).includes('HTTPS'))
  assert.equal(writes, 5)

  invalidEnrichment = true
  const failedStream = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'stream-failure' }, { Accept: 'application/x-ndjson' })
  const failures = (await failedStream.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(failures.at(-1).type, 'error')
  assert.equal(failures.at(-1).error.code, 'ENRICHMENT_INVALID_OUTPUT')
  assert.ok(failures.at(-1).error.message.includes('第 1 节'))
  assert.ok(failures.at(-1).error.message.includes('字段 summary'))
  assert.equal(completedLogs.at(-1).error.message, failures.at(-1).error.message)
  assert.ok(failures.some(event => event.stage?.id === 'enrichment' && event.stage.status === 'failed'))
  assert.ok(!failures.some(event => event.stage?.id === 'wiki' || event.type === 'result'))
  assert.equal(completedLogs.at(-1).status, 'failed')
  assert.equal(completedLogs.at(-1).httpStatus, 502)
  assert.equal(saved.has('stream-failure'), false)
  assert.equal(writes, 5)

  invalidEnrichment = false
  invalidEvidence = true
  for (const headers of [{}, { Accept: 'application/x-ndjson' }]) {
    const evidenceFailure = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'invalid-evidence' }, headers)
    const failure = headers.Accept ? (await evidenceFailure.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1) : await evidenceFailure.json()
    assert.equal(failure.error.code, 'ENRICHMENT_INVALID_OUTPUT')
    assert.ok(failure.error.message.includes('第 1 节'))
    assert.ok(failure.error.message.includes('concepts[0].evidence[0]'))
    assert.ok(failure.error.message.includes('逐字匹配'))
    assert.ok(!JSON.stringify(failure).includes('private-invalid-evidence'))
    assert.equal(completedLogs.at(-1).error.message, failure.error.message)
    assert.equal(saved.has('invalid-evidence'), false)
    assert.equal(writes, 5)
  }
  invalidEvidence = false

  unexpectedConceptField = true
  for (const headers of [{}, { Accept: 'application/x-ndjson' }]) {
    const beforeCalls = calls.length
    const result = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'unexpected-concept-field' }, headers)
    const failure = headers.Accept ? (await result.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1) : await result.json()
    assert.equal(failure.error.code, 'ENRICHMENT_INVALID_OUTPUT')
    assert.ok(failure.error.message.includes('concepts[0].type'))
    assert.ok(failure.error.message.includes('约定结构之外'))
    assert.ok(!JSON.stringify(failure).includes('private-extra-value'))
    assert.equal(completedLogs.at(-1).error.message, failure.error.message)
    assert.equal(saved.has('unexpected-concept-field'), false)
    assert.equal(writes, 5)
    assert.equal(calls.length - beforeCalls, 1)
  }
  unexpectedConceptField = false

  // 客户端关闭进度流时取消待完成的模型调用，不能继续写入或留下伪成功日志。
  invalidEnrichment = false
  llmGate = new Promise((resolve) => {
    releaseLlm = resolve
  })
  const cancellationFinished = new Promise((resolve) => {
    nextCompletion = resolve
  })
  const cancelledStream = await post('/api/documents/ingest', { ...ingestBody, knowledgeBaseId: 'stream-cancelled' }, { Accept: 'application/x-ndjson' })
  const cancelledReader = cancelledStream.body.getReader()
  let cancelledBuffer = ''
  while (!cancelledBuffer.includes('"id":"enrichment"')) {
    const { value, done } = await cancelledReader.read()
    assert.equal(done, false)
    cancelledBuffer += new TextDecoder().decode(value)
  }
  await cancelledReader.cancel()
  releaseLlm()
  llmGate = undefined
  const cancelledLog = await cancellationFinished
  assert.equal(cancelledLog.status, 'cancelled')
  assert.equal(saved.has('stream-cancelled'), false)
  assert.equal(writes, 5)
})
