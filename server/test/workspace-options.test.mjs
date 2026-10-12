import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'
import { Pool } from 'pg'
// eslint-disable-next-line antfu/no-import-dist -- 验证真实 HTTP 入口，数据库边界使用本地 stub。
import { app } from '../dist/core/app.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证 MCP 复用目录读取时不查询操作日志。
import { mcpServices } from '../dist/core/service/mcp.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证配置白名单。
import { configuredModels, ingestionEmbeddingOptions, llmOptions } from '../dist/core/service/model-options.js'

function env(t, values) {
  const previous = { ...process.env }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
  t.after(() => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined)
        delete process.env[key]
      else
        process.env[key] = previous[key]
    }
  })
}

test('model options expose only configured provider/model pairs, never credentials or endpoints', (t) => {
  env(t, { DEEPSEEK_API_KEY: 'private-key', DEEPSEEK_MODEL: undefined, OPENAI_API_KEY: '', OPENAI_MODEL: 'unavailable', EMBEDDING_API_KEY: 'private-key', EMBEDDING_MODEL: 'BAAI/bge-m3', GOOGLE_API_KEY: 'private-key', GOOGLE_EMBEDDING_MODEL: ' ', DEEPSEEK_BASE_URL: 'https://private.example' })
  assert.deepEqual(configuredModels(), { llm: [{ provider: 'deepseek', model: 'deepseek-flash' }], embedding: [{ provider: 'siliconflow', model: 'BAAI/bge-m3' }] })
  assert.ok(!JSON.stringify(configuredModels()).includes('private'))
})

test('workspace choices and request defaults stay aligned without caching environment or restricting explicit models', (t) => {
  env(t, { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: ' deepseek-default ', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: ' openai-default ', EMBEDDING_API_KEY: 'test-key', EMBEDDING_MODEL: ' vector-default ', GOOGLE_API_KEY: 'test-key', GOOGLE_EMBEDDING_MODEL: ' google-default ' })
  for (const choice of configuredModels().llm)
    assert.deepEqual(llmOptions({ provider: choice.provider }), choice)
  for (const choice of configuredModels().embedding)
    assert.deepEqual(ingestionEmbeddingOptions({ provider: choice.provider }), choice)
  assert.equal(llmOptions({ provider: 'ds' }).model, 'deepseek-default')
  assert.equal(ingestionEmbeddingOptions({ provider: 'gemini' }).model, 'google-default')
  process.env.DEEPSEEK_MODEL = 'updated-default'
  assert.equal(configuredModels().llm[0].model, llmOptions().model)
  delete process.env.DEEPSEEK_MODEL
  assert.equal(configuredModels().llm[0].model, 'deepseek-flash')
  process.env.DEEPSEEK_MODEL = ''
  assert.ok(!configuredModels().llm.some(item => item.provider === 'deepseek'))
  assert.throws(() => llmOptions(), { code: 'CONFIGURATION_ERROR' })
  assert.equal(llmOptions({ provider: 'deepseek', model: ' explicit-model ' }).model, 'explicit-model')
  assert.equal(ingestionEmbeddingOptions({ provider: 'google', model: 'explicit-vector' }).model, 'explicit-vector')
})

test('workspace catalog distinguishes fresh database, stored knowledge bases and failed reads', async (t) => {
  env(t, { VECTOR_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/test' })
  let initialized = false
  let fail = false
  let reads = 0
  let closes = 0
  const kb = { id: 'existing-kb', description: '', embedding: { provider: 'siliconflow', model: 'BAAI/bge-m3', dimensions: 1024 }, documents: [{ id: 'doc-1', label: 'guide.mdx' }] }
  t.mock.method(Pool.prototype, 'query', async (sql) => {
    reads++
    assert.match(sql, /^SELECT/)
    assert.doesNotMatch(sql, /CREATE|INSERT|UPDATE|DELETE|embedding::text|metadata AS document/)
    if (fail)
      throw new Error('private database connection and SQL')
    if (sql.includes('to_regclass'))
      return { rows: [{ snapshots: initialized ? 'rag_vector_snapshots' : null, vectors: initialized ? 'rag_vectors' : null, logs: initialized ? 'operation_logs' : null }] }
    if (sql.includes('FROM rag_vector_snapshots'))
      return { rows: [kb] }
    assert.ok(sql.includes('FROM operation_logs'))
    return { rows: [{ knowledgeBaseId: 'failed-only-kb', documentId: 'failed-doc' }] }
  })
  t.mock.method(Pool.prototype, 'end', async () => {
    closes++
  })
  let response = await app.request('/api/workspace/options')
  assert.equal(response.status, 200)
  let data = await response.json()
  assert.deepEqual(data.knowledgeBases, [])
  assert.deepEqual(data.logScopes, [])
  assert.equal(reads, 1)
  initialized = true
  response = await app.request('/api/workspace/options')
  data = await response.json()
  assert.deepEqual(data.knowledgeBases, [kb])
  assert.deepEqual(data.logScopes, [{ knowledgeBaseId: 'failed-only-kb', documentId: 'failed-doc' }])
  fail = true
  response = await app.request('/api/workspace/options')
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'WORKSPACE_DATABASE_ERROR')
  assert.equal(closes, 3)
})

test('missing database config fails options explicitly while health remains available', async (t) => {
  env(t, { VECTOR_DATABASE_URL: undefined })
  const response = await app.request('/api/workspace/options')
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'WORKSPACE_CONFIGURATION_ERROR')
  assert.equal((await app.request('/api/health')).status, 200)
})

test('MCP knowledge base listing reuses catalog metadata without reading historical logs', async (t) => {
  env(t, { VECTOR_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/test' })
  t.mock.method(Pool.prototype, 'query', async (sql) => {
    if (sql.includes('to_regclass'))
      return { rows: [{ snapshots: 'rag_vector_snapshots', vectors: 'rag_vectors', logs: 'operation_logs' }] }
    assert.ok(sql.includes('FROM rag_vector_snapshots'))
    assert.ok(!sql.includes('FROM operation_logs'))
    return { rows: [{ id: 'kb', description: '', embedding: { provider: 'stub', model: 'private-model' }, documents: [{ id: 'doc', label: 'private-path' }] }] }
  })
  t.mock.method(Pool.prototype, 'end', async () => {})
  assert.deepEqual(await mcpServices.listKnowledgeBases(), { knowledgeBases: [{ id: 'kb', description: '', documentCount: 1 }] })
})

test('catalog merges persisted descriptions with legacy snapshots and lists empty bases without fixing a vector model', async (t) => {
  env(t, { VECTOR_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/test' })
  let indexed = true
  t.mock.method(Pool.prototype, 'query', async (sql) => {
    assert.match(sql, /^SELECT/)
    if (sql.includes('to_regclass'))
      return { rows: [{ snapshots: indexed ? 'rag_vector_snapshots' : null, vectors: indexed ? 'rag_vectors' : null, knowledgeBases: 'knowledge_bases', logs: null }] }
    if (sql.includes('FROM rag_vector_snapshots')) {
      return { rows: [
        { id: 'legacy', description: '', embedding: { provider: 'stub', model: 'vector', dimensions: 2 }, documents: [{ id: 'doc', label: 'guide.md' }] },
        { id: 'described', description: '', embedding: { provider: 'stub', model: 'vector', dimensions: 2 }, documents: [{ id: 'doc-2', label: 'notes.md' }] },
      ] }
    }
    assert.ok(sql.includes('FROM knowledge_bases'))
    return { rows: [{ id: 'described', description: '前端实践与排查' }, { id: 'empty', description: '待整理的资料' }] }
  })
  t.mock.method(Pool.prototype, 'end', async () => {})
  assert.deepEqual(await mcpServices.listKnowledgeBases(), { knowledgeBases: [
    { id: 'legacy', description: '', documentCount: 1 },
    { id: 'described', description: '前端实践与排查', documentCount: 1 },
    { id: 'empty', description: '待整理的资料', documentCount: 0 },
  ] })
  const options = await (await app.request('/api/workspace/options')).json()
  assert.equal(options.knowledgeBases[1].embedding.model, 'vector')
  assert.deepEqual(options.knowledgeBases[2], { id: 'empty', description: '待整理的资料', embedding: null, documents: [] })
  indexed = false
  const fresh = await (await app.request('/api/workspace/options')).json()
  assert.equal(fresh.knowledgeBases.length, 2)
  assert.ok(fresh.knowledgeBases.every(kb => kb.embedding === null && kb.documents.length === 0))
})
