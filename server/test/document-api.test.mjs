import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import process from 'node:process'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 实际 HTTP 路由调用真实 SDK，本地模拟上游和存储。
import { app } from '../dist/core/app.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证接口配置解析而不是复制其实现。
import { embeddingSelection, ingestionEmbeddingOptions, llmOptions } from '../dist/core/service/model-options.js'
// eslint-disable-next-line antfu/no-import-dist -- 替换数据库边界，实际数据库原子性由独立集成测试验证。
import { PgVectorStore } from '../dist/rag/vector-store/index.js'

const content = '# Atlas\n\n生产环境必须使用 HTTPS。'
const enrichment = { summary: '生产环境协议要求。', keywords: ['HTTPS'], aliases: [], questions: [], entities: [], concepts: [{ id: 'c1', name: 'HTTPS', aliases: [], description: '生产环境协议要求', evidence: ['生产环境必须使用 HTTPS。'] }], relations: [], facts: [], knowledgeType: 'security-rule' }
const ingestBody = { knowledgeBaseId: 'test', document: { id: 'article', content }, llm: { provider: 'ds', model: 'llm-test' }, embedding: { provider: 'siliconflow', model: 'embed-test' } }
const post = (path, body) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

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

test('four HTTP model combinations normalize, enrich, embed, store and answer via actual SDK protocols', { timeout: 20000 }, async (t) => {
  const calls = []
  let failEmbedding = false
  let invalidEnrichment = false
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
      const openai = req.url.endsWith('/responses')
      const input = openai ? body.input[1].content : body.messages[1].content
      const text = JSON.parse(input).sources ? '生产环境使用 HTTPS。[S1]' : invalidEnrichment ? '{}' : JSON.stringify(enrichment)
      response = openai
        ? { id: 'response', object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] }
        : { id: 'chat', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }
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
  const env = { VECTOR_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: `${baseURL}/v1`, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `${baseURL}/v1`, GOOGLE_API_KEY: 'test', EMBEDDING_API_KEY: 'test', EMBEDDING_BASE_URL: `${baseURL}/v1`, RERANK_API_KEY: 'test', RERANK_BASE_URL: `${baseURL}/v1` }
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
      assert.equal(result.enrichment[0].provider, llm === 'ds' ? 'deepseek' : llm)
      assert.equal(result.embedding.provider, embedding === 'gemini' ? 'google' : embedding)
      const answerResponse = await post('/api/search', { knowledgeBaseId: body.knowledgeBaseId, question: '生产环境使用什么协议？', llm: body.llm, embedding: body.embedding })
      const answer = await answerResponse.json()
      assert.equal(answerResponse.status, 200, JSON.stringify(answer))
      assert.equal(answer.status, 'answered')
      assert.equal(answer.generation.provider, result.enrichment[0].provider)
      assert.equal(answer.embedding.provider, result.embedding.provider)
      assert.equal(answer.sources.length, 2)
    }
  }
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
})
