import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { test } from 'node:test'
import { Pool } from 'pg'
// eslint-disable-next-line antfu/no-import-dist -- 验证实际日志 HTTP 路由。
import { app } from '../dist/core/app.js'
// eslint-disable-next-line antfu/no-import-dist -- 测试持久化边界。
import { OperationLogDao } from '../dist/core/dao/operation-logs.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证摘要白名单及查询校验。
import { parseLogFilters, summarizeIngestion, summarizeQuery } from '../dist/core/service/operation-logs.js'
// eslint-disable-next-line antfu/no-import-dist -- 使用真实统一异常。
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- 不调用模型，替换向量读取边界。
import { PgVectorStore } from '../dist/rag/vector-store/index.js'

const post = (path, body) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
function setDatabase(t, value) {
  const previous = process.env.VECTOR_DATABASE_URL
  process.env.VECTOR_DATABASE_URL = value
  t.after(() => {
    if (previous === undefined)
      delete process.env.VECTOR_DATABASE_URL
    else
      process.env.VECTOR_DATABASE_URL = previous
  })
}

function memoryLogs(t) {
  const records = []
  t.mock.method(OperationLogDao.prototype, 'initialize', async () => {})
  t.mock.method(OperationLogDao.prototype, 'start', async (input) => {
    const row = { ...input, id: String(records.length + 1), status: 'running', knowledgeBaseId: null, documentId: null, summary: {} }
    records.push(row)
    return row.id
  })
  t.mock.method(OperationLogDao.prototype, 'setScope', async (id, knowledgeBaseId, documentId) => {
    Object.assign(records.find(row => row.id === id), { knowledgeBaseId, documentId })
  })
  t.mock.method(OperationLogDao.prototype, 'finish', async (id, input) => {
    Object.assign(records.find(row => row.id === id), structuredClone(input))
  })
  return records
}

test('log filters validate enums, pagination and ISO ranges before database access', async () => {
  assert.equal(parseLogFilters({}).limit, 20)
  assert.equal(parseLogFilters({ knowledgeBaseId: ' kb ' }).knowledgeBaseId, 'kb')
  for (const query of ['type=other', 'status=done', 'limit=0', 'limit=101', 'limit=1.5', 'cursor=0', 'cursor=9223372036854775808', 'from=2026-09-01', 'from=2026-02-30T00:00:00Z', 'from=2026-09-01T24:00:00Z', 'from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z', 'knowledgeBaseId=', 'unexpected=true']) {
    const response = await app.request(`/api/logs?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal((await response.json()).error.code, 'HTTP_INVALID_INPUT')
  }
  assert.equal((await app.request('/api/logs/not-an-id')).status, 400)
})

test('log summaries retain counts/model usage, never document text, question, answer, paths or raw response', () => {
  const marker = 'private-content-must-not-be-logged'
  const model = { provider: 'test', model: 'test-model', usage: null, text: marker, refusal: marker }
  const ingestion = summarizeIngestion({ status: 'stored', counts: { chunks: 2 }, normalization: { characters: 40, title: marker, warnings: [{ message: marker }] }, stored: { revision: 'r1' }, enrichment: [{ ...model, sectionId: marker }], embedding: { ...model, dimensions: 3, embeddings: [[1, 2, 3]] }, content: marker })
  const query = summarizeQuery({ status: 'answered', counts: { selected: 5 }, snapshotRevision: 'r1', generation: model, embedding: { ...model, dimensions: 3 }, rerank: { ...model, results: [{ index: 0, score: 1 }] }, question: marker, answer: marker, sources: [{ text: marker, sourcePath: marker }] })
  assert.ok(!JSON.stringify([ingestion, query]).includes(marker))
  assert.deepEqual(ingestion.normalization, { characters: 40, warningCount: 1 })
  assert.equal(query.models.llm[0].usage, null)
  assert.equal(query.counts.selected, 5)
})

test('HTTP logging records running/success/failure/cancellation and scopes without changing responses', async (t) => {
  setDatabase(t, 'postgresql://unused:unused@127.0.0.1:1/test')
  const records = memoryLogs(t)
  let cancellation = false
  t.mock.method(PgVectorStore.prototype, 'getSnapshot', async () => {
    assert.equal(records.at(-1).status, 'running')
    assert.equal(records.at(-1).knowledgeBaseId, 'test-kb')
    if (cancellation)
      throw new AppError('QUERY_ABORTED', 'private-provider-error')
    return null
  })
  const answered = await post('/api/search', { knowledgeBaseId: 'test-kb', question: 'private-question' })
  assert.equal(answered.status, 200)
  assert.equal(records.at(-1).status, 'succeeded')
  assert.equal(records.at(-1).summary.resultStatus, 'no_results')
  assert.equal(records.at(-1).requestId, answered.headers.get('x-request-id'))
  assert.ok(records.at(-1).durationMs >= 0)
  assert.ok(records.at(-1).finishedAt >= records.at(-1).startedAt)
  const invalid = await post('/api/documents/ingest', { knowledgeBaseId: 'test-kb', document: { id: 'doc-a', content: '' } })
  assert.equal(invalid.status, 400)
  assert.equal(records.at(-1).type, 'ingestion')
  assert.equal(records.at(-1).documentId, 'doc-a')
  assert.equal(records.at(-1).error.code, 'HTTP_INVALID_INPUT')
  const malformed = await app.request('/api/documents/ingest', { method: 'POST', body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal(records.at(-1).status, 'failed')
  assert.equal(records.at(-1).knowledgeBaseId, null)
  const oversized = await app.request('/api/search', { method: 'POST', body: 'x'.repeat(33000) })
  assert.equal(oversized.status, 413)
  assert.equal(records.at(-1).httpStatus, 413)
  cancellation = true
  assert.equal((await post('/api/search', { knowledgeBaseId: 'test-kb', question: 'private-question' })).status, 502)
  assert.equal(records.at(-1).status, 'cancelled')
  assert.equal(records.at(-1).error.code, 'QUERY_ABORTED')
  assert.ok(!JSON.stringify(records).includes('private-'))
  const before = records.length
  assert.equal((await app.request('/api/health')).status, 200)
  assert.equal((await app.request('/api/documents/not-a-route')).status, 404)
  assert.equal((await app.request('/api/search')).status, 404)
  assert.equal(records.length, before)
})

test('logging initialization/completion failures do not replace original success or errors; read errors are explicit', async (t) => {
  setDatabase(t, 'postgresql://unused:unused@127.0.0.1:1/test')
  t.mock.method(PgVectorStore.prototype, 'getSnapshot', async () => null)
  const error = new AppError('OPERATION_LOG_DATABASE_ERROR', 'safe-database-error')
  let failingMethod
  t.mock.method(OperationLogDao.prototype, 'initialize', async () => {
    if (failingMethod === 'initialize')
      throw error
  })
  t.mock.method(OperationLogDao.prototype, 'start', async () => '1')
  t.mock.method(OperationLogDao.prototype, 'setScope', async () => {})
  t.mock.method(OperationLogDao.prototype, 'finish', async () => {
    if (failingMethod === 'finish')
      throw error
  })
  for (const method of ['initialize', 'finish']) {
    failingMethod = method
    assert.equal((await post('/api/search', { knowledgeBaseId: 'kb', question: 'test' })).status, 200)
    assert.equal((await post('/api/documents/ingest', {})).status, 400)
  }
  failingMethod = undefined
  t.mock.method(OperationLogDao.prototype, 'list', async () => {
    throw error
  })
  const failed = await app.request('/api/logs')
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).error.code, 'OPERATION_LOG_DATABASE_ERROR')
  t.mock.method(OperationLogDao.prototype, 'get', async () => null)
  assert.equal((await app.request('/api/logs/1')).status, 404)
})

const connectionString = process.env.VECTOR_STORE_TEST_DATABASE_URL
test('PostgreSQL logs persist across reconnects and support type/status/scope/request/time filters and stable cursors', { skip: !connectionString, timeout: 60000 }, async (t) => {
  const database = `knowledge_log_test_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString, max: 1 })
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  let dao
  t.after(async () => {
    await dao?.close()
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  setDatabase(t, url.href)
  dao = new OperationLogDao(url.href)
  const second = new OperationLogDao(url.href)
  try {
    await Promise.all([dao.initialize(), second.initialize()])
  }
  finally {
    await second.close()
  }
  assert.deepEqual(await dao.list({ limit: 20 }), { items: [], nextCursor: null })
  const ids = []
  for (let i = 0; i < 5; i++) {
    const id = await dao.start({ type: i % 2 ? 'query' : 'ingestion', requestId: `req-${i}`, traceId: null, startedAt: `2026-09-29T00:00:0${i}.000Z` })
    ids.push(id)
    await dao.setScope(id, i === 4 ? 'other-kb' : 'kb', i % 2 ? null : `doc-${i}`)
    if (i < 4)
      await dao.finish(id, { status: i === 2 ? 'failed' : 'succeeded', finishedAt: `2026-09-29T00:00:0${i}.025Z`, durationMs: 25, httpStatus: i === 2 ? 400 : 200, summary: { counts: { chunks: 2 } }, error: i === 2 ? { code: 'HTTP_INVALID_INPUT', message: 'Invalid document', retryable: false } : null })
  }
  assert.equal((await dao.list({ type: 'ingestion', status: 'failed', knowledgeBaseId: 'kb', documentId: 'doc-2', requestId: 'req-2', limit: 10 })).items[0].id, ids[2])
  assert.deepEqual((await dao.list({ from: '2026-09-29T00:00:01Z', to: '2026-09-29T00:00:03Z', limit: 20 })).items.map(item => item.id), [ids[2], ids[1]])
  assert.equal((await dao.list({ status: 'running', limit: 20 })).items[0].id, ids[4])
  assert.deepEqual((await dao.list({ knowledgeBaseId: 'kb\' OR 1=1 --', limit: 20 })).items, [])
  const first = await dao.list({ limit: 2 })
  assert.equal(first.nextCursor, ids[3])
  const inserted = await dao.start({ type: 'query', requestId: 'new-request', traceId: null, startedAt: '2026-09-30T00:00:00Z' })
  const next = await dao.list({ limit: 2, cursor: first.nextCursor })
  assert.deepEqual(next.items.map(item => item.id), [ids[2], ids[1]])
  assert.deepEqual((await dao.list({ limit: 2, cursor: next.nextCursor })).items.map(item => item.id), [ids[0]])
  assert.equal((await dao.list({ limit: 2, cursor: ids[0] })).nextCursor, null)
  await dao.close()
  dao = new OperationLogDao(url.href)
  assert.equal((await dao.get(ids[2])).error.code, 'HTTP_INVALID_INPUT')
  assert.equal((await dao.get(ids[0])).startedAt, '2026-09-29T00:00:00.000Z')
  assert.equal((await dao.get(inserted)).finishedAt, null)
  const list = await app.request('/api/logs?type=ingestion&status=failed&knowledgeBaseId=kb&limit=1')
  assert.equal(list.status, 200)
  assert.equal((await list.json()).items[0].id, ids[2])
  const detail = await app.request(`/api/logs/${ids[2]}`)
  assert.equal(detail.status, 200)
  assert.equal((await detail.json()).documentId, 'doc-2')
  assert.equal((await app.request('/api/logs/999999')).status, 404)
  // 实际路由 + 实际日志库，解析错误不需要模型或向量表。
  const invalid = await post('/api/documents/ingest', { knowledgeBaseId: 'http-kb', document: { id: 'http-doc', content: '' } })
  assert.equal(invalid.status, 400)
  const logged = (await dao.list({ requestId: invalid.headers.get('x-request-id'), limit: 20 })).items
  assert.equal(logged.length, 1)
  assert.equal(logged[0].status, 'failed')
  assert.equal(logged[0].knowledgeBaseId, 'http-kb')
  assert.equal(logged[0].documentId, 'http-doc')
  // 跨越 9→10 后仍按 bigint 排序，不能被 SELECT id::text 转成字典序。
  for (let i = 0; i < 8; i++)
    await dao.start({ type: 'query', requestId: `numeric-${i}`, traceId: null, startedAt: '2026-09-30T00:00:00Z' })
  const numeric = (await dao.list({ limit: 100 })).items.map(item => BigInt(item.id))
  assert.ok(numeric[0] > 9n)
  assert.ok(numeric.every((id, index) => index === 0 || numeric[index - 1] > id))
})
