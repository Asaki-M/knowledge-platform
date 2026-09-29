import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 不启动端口，直接验证 HTTP 输入与错误响应。
import { app } from '../dist/core/app.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证模型客户端的真实公共契约。
import { LlmClient } from '../dist/llm/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证模型客户端的真实公共契约。
import { EmbeddingClient } from '../dist/rag/embedding/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证构建后的公共问答入口。
import { searchAndAnswer } from '../dist/rag/query/index.js'

const request = { knowledgeBaseId: 'kb', question: '如何查询？' }
const options = { rerankModel: 'rerank', generation: { provider: 'stub', model: 'answer' } }
function fixture(count = 30) {
  const calls = []
  const hit = (kind, i) => ({ document: { id: `${kind}-${i}`, kind, knowledgeBaseId: 'kb', sourceId: `${kind}-${i}`, title: `${kind} ${i}`, embeddingText: i === 0 ? 'shared text' : `${kind} text ${i}`, sources: [{ documentId: 'doc', sectionId: `${kind}-${i}`, sectionRevision: 'r' }] }, score: 1 - i / 100 })
  const state = { snapshot: { knowledgeBaseId: 'kb', revision: 'v1', provider: 'stub', requestedModel: 'embed', model: 'embed', dimensions: 2, chunks: count, wikiNodes: count }, hits: { snapshotRevision: 'v1', chunks: Array.from({ length: count }, (_, i) => hit('chunk', i)), wikiNodes: Array.from({ length: count }, (_, i) => hit('wiki', i)) }, answer: { id: 'answer', provider: 'stub', model: 'answer', text: '查询结论 [S1]', finishReason: 'stop', usage: null } }
  const deps = {
    store: { async getSnapshot() {
      calls.push('snapshot')
      return state.snapshot
    }, async searchDual(input) {
      calls.push(['search', input])
      return state.hits
    } },
    embedding: new EmbeddingClient([{ provider: 'stub', async embed(input) {
      calls.push(['embed', input])
      return { provider: 'stub', model: input.model, embeddings: [[1, 0.5]], dimensions: 2, usage: null }
    } }]),
    reranker: { async rerank(input) {
      calls.push(['rerank', input])
      return { provider: 'stub', model: input.model, results: Array.from({ length: input.topN }, (_, i) => ({ index: input.documents.length - i - 1, score: 1 - i / 10 })), usage: null }
    } },
    llm: new LlmClient([{ provider: 'stub', async generate(input) {
      calls.push(['generate', input])
      return state.answer
    } }]),
  }
  return { calls, state, deps }
}

test('dual search takes 30 per route, deduplicates 60 to 59, reranks all and sends only top 5 to LLM', async () => {
  const { calls, deps } = fixture()
  const result = await searchAndAnswer(request, deps, options)
  assert.deepEqual(result.counts, { chunks: 30, wikiNodes: 30, merged: 59, duplicates: 1, selected: 5 })
  const get = name => calls.find(item => Array.isArray(item) && item[0] === name)[1]
  assert.equal(get('search').limit, 30)
  assert.equal(get('search').expectedRevision, 'v1')
  assert.deepEqual(get('embed').input, [request.question])
  assert.equal(get('rerank').documents.length, 59)
  assert.equal(get('rerank').topN, 5)
  assert.equal(result.sources[0].id, 'wiki-29')
  const payload = JSON.parse(get('generate').messages[1].content)
  assert.deepEqual(payload.sources.map(item => item.text), result.sources.map(item => item.text))
  assert.equal(payload.sources.length, 5)
  assert.ok(!get('generate').messages[1].content.includes('chunk text 1'))
  assert.equal(result.status, 'answered')
  assert.equal(result.embedding.embeddings, undefined)
})

test('identical text preserves both provenance records; fewer than 5 remain valid', async () => {
  const { deps } = fixture(1)
  const result = await searchAndAnswer(request, deps, options)
  assert.equal(result.sources.length, 1)
  assert.deepEqual(result.sources[0].matches.map(match => match.kind), ['chunk', 'wiki'])
})

test('empty or missing snapshot avoids all model calls', async () => {
  for (const missing of [false, true]) {
    const { deps, state, calls } = fixture(0)
    if (missing)
      state.snapshot = null
    const result = await searchAndAnswer(request, deps, options)
    assert.equal(result.status, 'no_results')
    assert.deepEqual(calls, ['snapshot'])
  }
})

test('invalid query, cancellation, wrong space, wrong scope, stale snapshot and bad ranking fail explicitly', async () => {
  const cases = [
    [f => f.state.snapshot.dimensions = 3, 'VECTOR_STORE_INCONSISTENT_SPACE'],
    [f => f.state.hits.snapshotRevision = 'v2', 'VECTOR_STORE_CONFLICT'],
    [f => f.state.hits.wikiNodes[0].document.knowledgeBaseId = 'other', 'QUERY_INVALID_RESULTS'],
    [f => f.state.hits.chunks.push({ ...f.state.hits.chunks[0], document: { ...f.state.hits.chunks[0].document, embeddingText: 'conflict' } }), 'QUERY_INVALID_RESULTS'],
    [f => f.deps.reranker.rerank = async () => ({ results: [{ index: 999, score: 1 }] }), 'RERANK_INVALID_RESPONSE'],
    [f => f.state.answer.finishReason = 'length', 'QUERY_INCOMPLETE_RESPONSE'],
    [f => f.state.answer.refusal = 'refused', 'QUERY_REFUSED'],
    [f => f.state.answer.text = 'unknown [S99]', 'QUERY_INVALID_ANSWER'],
    [f => f.state.answer.text = '', 'QUERY_INVALID_ANSWER'],
  ]
  for (const [change, code] of cases) {
    const f = fixture(3)
    change(f)
    await assert.rejects(searchAndAnswer(request, f.deps, options), { code })
  }
  const f = fixture()
  await assert.rejects(searchAndAnswer({ ...request, question: '' }, f.deps, options), { code: 'QUERY_INVALID_INPUT' })
  await assert.rejects(searchAndAnswer({ ...request, signal: AbortSignal.abort() }, f.deps, options), { code: 'QUERY_ABORTED' })
  await assert.rejects(searchAndAnswer(request, f.deps, { ...options, generation: { ...options.generation, maxContextCharacters: 1 } }), { code: 'QUERY_CONTEXT_TOO_LARGE' })
  assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'generate'))
})

test('search HTTP endpoint rejects malformed/oversized input without model configuration', async () => {
  for (const body of ['{', '{}', JSON.stringify({ knowledgeBaseId: 'kb', question: '' })]) {
    const response = await app.request('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    assert.equal(response.status, 400)
    assert.ok((await response.json()).error.code)
  }
  const response = await app.request('/api/search', { method: 'POST', body: 'x'.repeat(33000) })
  assert.equal(response.status, 413)
  assert.equal((await app.request('/api/health')).status, 200)
})
