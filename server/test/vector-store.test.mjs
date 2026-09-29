import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { test } from 'node:test'
import { Pool } from 'pg'
// eslint-disable-next-line antfu/no-import-dist -- 使用同一内容指纹规则构造测试快照。
import { contentHash } from '../dist/rag/content-hash.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证真实公共客户端，不调用远程模型。
import { EmbeddingClient } from '../dist/rag/embedding/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证入库组合入口。
import { indexAndStore } from '../dist/rag/ingestion/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 测试已构建的数据库公共入口。
import { PgVectorStore } from '../dist/rag/vector-store/index.js'

const load = async name => JSON.parse(await readFile(new URL(`./reports/dual-index/${name}.json`, import.meta.url), 'utf8'))
const vectors = await load('07-vectors')
const query = await load('08-query-check')
const wiki = (await load('05-wiki')).result
const chunks = (await load('03-chunks')).flatMap(item => item.chunks)
const connectionString = process.env.VECTOR_STORE_TEST_DATABASE_URL

function renamed(snapshot, knowledgeBaseId) {
  const result = structuredClone(snapshot)
  result.knowledgeBaseId = knowledgeBaseId
  for (const record of [...result.chunks, ...result.wikiNodes]) {
    record.knowledgeBaseId = knowledgeBaseId
    record.id = `index-${contentHash([knowledgeBaseId, record.kind, record.sourceId])}`
  }
  return result
}
const searchRequest = { knowledgeBaseId: vectors.knowledgeBaseId, provider: vectors.provider, model: vectors.model, vector: query.response.embeddings[0], kind: 'wiki', limit: 3 }

test('vector store validates snapshots, vectors and configuration before connecting', async () => {
  assert.throws(() => new PgVectorStore({ connectionString: '' }), { code: 'VECTOR_STORE_CONFIGURATION_ERROR' })
  assert.throws(() => new PgVectorStore({ connectionString: 'https://localhost' }), { code: 'VECTOR_STORE_CONFIGURATION_ERROR' })
  const store = new PgVectorStore({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
  try {
    for (const change of [
      input => input.chunks[0].vector = [],
      input => input.chunks[0].vector.fill(0),
      input => input.chunks[0].vector[0] = Infinity,
      input => input.chunks[0].vector[0] = 1e100,
      input => input.chunks[0].embeddingText += 'changed',
      input => input.chunks[0].embeddingRevision = 'stale',
      input => input.chunks.push(input.chunks[0]),
      input => input.chunks[0].knowledgeBaseId = 'wrong',
      input => input.model = 'different-model',
    ]) {
      const input = structuredClone(vectors)
      change(input)
      await assert.rejects(store.replaceSnapshot(input, { expectedRevision: null }), { code: 'VECTOR_STORE_INVALID_INPUT' })
    }
    await assert.rejects(store.replaceSnapshot(vectors, {}), { code: 'VECTOR_STORE_INVALID_INPUT' })
    await assert.rejects(store.replaceSnapshot(vectors, { expectedRevision: null, signal: AbortSignal.abort() }), { code: 'VECTOR_STORE_ABORTED' })
    await assert.rejects(store.search({ ...searchRequest, vector: [0] }), { code: 'VECTOR_STORE_INVALID_INPUT' })
    await assert.rejects(store.search({ ...searchRequest, limit: 101 }), { code: 'VECTOR_STORE_INVALID_INPUT' })
    await assert.rejects(store.getSnapshot(''), { code: 'VECTOR_STORE_INVALID_INPUT' })
    await assert.rejects(store.getSnapshot('test'), (error) => {
      assert.equal(error.code, 'VECTOR_STORE_DATABASE_ERROR')
      assert.ok(!error.message.includes('unused'))
      return true
    })
  }
  finally {
    await store.close()
  }
})

test('indexAndStore prepares all vectors before a single version-checked write; failures leave storage untouched', async () => {
  const calls = []
  const embedding = new EmbeddingClient([{ provider: 'stub', async embed(request) {
    calls.push('embed')
    return { provider: 'stub', model: request.model, embeddings: request.input.map(() => [1, 0.5, 0.25]), dimensions: 3, usage: null }
  } }])
  const store = {
    async getSnapshot() {
      calls.push('read')
      return { revision: 'previous' }
    },
    async replaceSnapshot(input, options) {
      calls.push('write')
      assert.equal(options.expectedRevision, 'previous')
      assert.equal(input.chunks.length, 2)
      assert.equal(input.wikiNodes.length, 10)
      return { revision: 'next' }
    },
  }
  const result = await indexAndStore({ chunks, wiki }, embedding, store, { embedding: { provider: 'stub', model: 'test', batchSize: 5 } })
  assert.deepEqual(calls, ['read', 'embed', 'embed', 'embed', 'write'])
  assert.equal(result.stored.revision, 'next')
  calls.length = 0
  const failing = new EmbeddingClient([{ provider: 'stub', async embed() {
    throw new Error('upstream failed')
  } }])
  await assert.rejects(indexAndStore({ chunks, wiki }, failing, store, { embedding: { provider: 'stub', model: 'test' } }), { code: 'EMBEDDING_PROVIDER_ERROR' })
  assert.deepEqual(calls, ['read'])
})

test('pgvector transactions persist, search, replace, roll back and reject concurrent stale writers', { skip: !connectionString, timeout: 60000 }, async (t) => {
  // 显式启用的数据库测试使用独立临时数据库，绝不清空用户知识库。
  const database = `knowledge_vector_test_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString, max: 1 })
  let store
  let control
  t.after(async () => {
    await store?.close()
    await control?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  store = new PgVectorStore({ connectionString: url.href })
  control = new Pool({ connectionString: url.href, max: 1 })
  await store.initialize()
  await store.initialize()
  assert.equal(await store.getSnapshot(vectors.knowledgeBaseId), null)
  const first = await store.replaceSnapshot(vectors, { expectedRevision: null })
  assert.deepEqual([first.chunks, first.wikiNodes, first.dimensions], [2, 10, 1024])
  const rows = await control.query('SELECT kind, count(*)::int AS count FROM rag_vectors GROUP BY kind ORDER BY kind')
  assert.deepEqual(rows.rows, [{ kind: 'chunk', count: 2 }, { kind: 'wiki', count: 10 }])
  const dual = await store.searchDual({ ...searchRequest, limit: 30, expectedRevision: first.revision })
  assert.equal(dual.snapshotRevision, first.revision)
  assert.deepEqual([dual.chunks.length, dual.wikiNodes.length], [2, 10])
  assert.ok(dual.chunks.every(hit => hit.document.kind === 'chunk'))
  assert.ok(dual.wikiNodes.every(hit => hit.document.kind === 'wiki'))
  await assert.rejects(store.searchDual({ ...searchRequest, expectedRevision: 'stale' }), { code: 'VECTOR_STORE_CONFLICT' })
  await assert.rejects(store.searchDual({ ...searchRequest, expectedRevision: first.revision, model: 'wrong' }), { code: 'VECTOR_STORE_INCONSISTENT_SPACE' })
  await assert.rejects(store.searchDual({ ...searchRequest, expectedRevision: first.revision, signal: AbortSignal.abort() }), { code: 'VECTOR_STORE_ABORTED' })
  const wikiHits = await store.search(searchRequest)
  assert.equal(wikiHits[0].document.title, 'Wiki 索引')
  assert.ok(Math.abs(wikiHits[0].score - query.wikiHits[0].score) < 1e-6)
  const chunkHits = await store.search({ ...searchRequest, kind: 'chunk' })
  assert.equal(chunkHits[0].document.sources[0].headingPath.at(-1).title, '双索引')
  assert.equal((await store.replaceSnapshot(vectors, { expectedRevision: first.revision })).revision, first.revision)
  await assert.rejects(store.replaceSnapshot(vectors, { expectedRevision: null }), { code: 'VECTOR_STORE_CONFLICT' })
  await assert.rejects(store.search({ ...searchRequest, model: 'another-model' }), { code: 'VECTOR_STORE_INCONSISTENT_SPACE' })
  await assert.rejects(store.search({ ...searchRequest, vector: [1, 2] }), { code: 'VECTOR_STORE_INCONSISTENT_SPACE' })
  assert.deepEqual(await store.search({ ...searchRequest, knowledgeBaseId: 'missing' }), [])

  const other = renamed(vectors, 'other-kb')
  await store.replaceSnapshot(other, { expectedRevision: null })
  const large = renamed(vectors, 'large-kb')
  for (const [kind, records] of [['chunk', large.chunks], ['wiki', large.wikiNodes]]) {
    while (records.length < 35) {
      const record = structuredClone(records[0])
      record.sourceId = `extra-${kind}-${records.length}`
      record.id = `index-${contentHash([large.knowledgeBaseId, kind, record.sourceId])}`
      records.push(record)
    }
  }
  const largeInfo = await store.replaceSnapshot(large, { expectedRevision: null })
  const top30 = await store.searchDual({ ...searchRequest, knowledgeBaseId: 'large-kb', expectedRevision: largeInfo.revision, limit: 30 })
  assert.deepEqual([top30.chunks.length, top30.wikiNodes.length], [30, 30])
  const smaller = structuredClone(vectors)
  smaller.chunks.pop()
  const shrunk = await store.replaceSnapshot(smaller, { expectedRevision: first.revision })
  assert.equal((await store.search({ ...searchRequest, kind: 'chunk' })).length, 1)
  assert.equal((await store.getSnapshot('other-kb')).chunks, 2)

  // 第二批写入触发真实数据库约束错误，确认第一批与快照版本均回滚。
  await control.query('ALTER TABLE rag_vectors ADD CONSTRAINT reject_marker CHECK (metadata->>\'title\' <> \'rollback-marker\')')
  const broken = structuredClone(vectors)
  for (let i = 0; i < 140; i++) {
    const record = structuredClone(vectors.chunks[0])
    record.sourceId = `test-chunk-${i}`
    record.id = `index-${contentHash([broken.knowledgeBaseId, record.kind, record.sourceId])}`
    broken.chunks.push(record)
  }
  const ordered = [...broken.chunks, ...broken.wikiNodes].sort((a, b) => a.id.localeCompare(b.id))
  ordered.at(-1).title = 'rollback-marker'
  await assert.rejects(store.replaceSnapshot(broken, { expectedRevision: shrunk.revision }), { code: 'VECTOR_STORE_DATABASE_ERROR' })
  assert.equal((await store.getSnapshot(vectors.knowledgeBaseId)).revision, shrunk.revision)
  assert.equal((await control.query('SELECT count(*)::int AS count FROM rag_vectors WHERE knowledge_base_id = $1', [vectors.knowledgeBaseId])).rows[0].count, 11)
  await control.query('ALTER TABLE rag_vectors DROP CONSTRAINT reject_marker')

  const a = structuredClone(smaller)
  const b = structuredClone(smaller)
  a.chunks[0].title = 'writer-a'
  b.chunks[0].title = 'writer-b'
  const concurrent = await Promise.allSettled([store.replaceSnapshot(a, { expectedRevision: shrunk.revision }), store.replaceSnapshot(b, { expectedRevision: shrunk.revision })])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'VECTOR_STORE_CONFLICT')

  // 关闭再连接，确认数据不是仅留在客户端内存中。
  await store.close()
  store = new PgVectorStore({ connectionString: url.href })
  const current = await store.getSnapshot(vectors.knowledgeBaseId)
  assert.equal(current.chunks, 1)
  const empty = { ...vectors, model: null, dimensions: null, chunks: [], wikiNodes: [], usage: null, batches: [] }
  await store.replaceSnapshot(empty, { expectedRevision: current.revision })
  assert.deepEqual(await store.search(searchRequest), [])
  assert.equal((await store.getSnapshot('other-kb')).wikiNodes, 10)
})
