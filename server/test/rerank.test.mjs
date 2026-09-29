import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 真实 SDK 对本地模拟重排协议。
import { SiliconFlowReranker } from '../dist/rag/rerank/index.js'

async function mock(t) {
  const state = { status: 200, body: { results: [{ index: 1, relevance_score: 0.4 }, { index: 0, relevance_score: 0.9 }] }, requests: [], slow: false }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req)
      chunks.push(chunk)
    state.requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
    if (state.slow)
      return
    res.writeHead(state.status, { 'content-type': 'application/json', 'x-siliconcloud-trace-id': 'trace' })
    res.end(JSON.stringify(state.body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return { state, config: { apiKey: 'local-test', baseURL: `http://127.0.0.1:${server.address().port}/v1` } }
}
const request = { model: 'BAAI/bge-reranker-v2-m3', query: '问题', documents: ['原文', '知识'], topN: 2 }

test('rerank SDK maps request, scores, ordering, missing usage and request ID', async (t) => {
  const { state, config } = await mock(t)
  const client = new SiliconFlowReranker(config)
  const result = await client.rerank(request)
  assert.deepEqual(state.requests[0], { path: '/v1/rerank', body: { model: request.model, query: request.query, documents: request.documents, top_n: 2, return_documents: false } })
  assert.deepEqual(result.results, [{ index: 0, score: 0.9 }, { index: 1, score: 0.4 }])
  assert.equal(result.usage, null)
  assert.equal(result.requestId, 'trace')
  state.body.meta = { tokens: { input_tokens: 4, output_tokens: 0 } }
  assert.deepEqual((await client.rerank(request)).usage, { inputTokens: 4, outputTokens: 0 })
})

test('rerank rejects missing/duplicate/out-of-range indices and invalid scores', async (t) => {
  const { state, config } = await mock(t)
  for (const body of [null, {}, { results: [] }, { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }] }, { results: [{ index: 3, relevance_score: 1 }, { index: 0, relevance_score: 0 }] }, { results: [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 0 }] }]) {
    state.body = body
    await assert.rejects(new SiliconFlowReranker(config).rerank(request), { code: 'RERANK_INVALID_RESPONSE' })
  }
})

test('rerank sanitizes provider errors, does not retry, and preserves timeout/cancellation', async (t) => {
  const { state, config } = await mock(t)
  for (const [status, code] of [[401, 'RERANK_AUTHENTICATION_ERROR'], [429, 'RERANK_RATE_LIMITED'], [500, 'RERANK_PROVIDER_ERROR']]) {
    state.status = status
    state.body = { error: { message: 'private-provider-data' } }
    const before = state.requests.length
    await assert.rejects(new SiliconFlowReranker(config).rerank(request), (error) => {
      assert.equal(error.code, code)
      assert.ok(!error.message.includes('private-provider-data'))
      return true
    })
    assert.equal(state.requests.length, before + 1)
  }
  state.slow = true
  await assert.rejects(new SiliconFlowReranker({ ...config, timeoutMs: 30 }).rerank(request), { code: 'RERANK_TIMEOUT' })
  await assert.rejects(new SiliconFlowReranker(config).rerank({ ...request, signal: AbortSignal.abort() }), { code: 'RERANK_ABORTED' })
  await assert.rejects(new SiliconFlowReranker(config).rerank({ ...request, documents: [] }), { code: 'RERANK_INVALID_REQUEST' })
})
