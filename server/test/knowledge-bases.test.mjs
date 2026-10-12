import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'
import { Pool } from 'pg'
// eslint-disable-next-line antfu/no-import-dist -- 验证真实路由、校验与 DAO，数据库使用本地 stub。
import { app } from '../dist/core/app.js'

function database(t) {
  const previous = process.env.VECTOR_DATABASE_URL
  process.env.VECTOR_DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/test'
  t.after(() => {
    if (previous === undefined)
      delete process.env.VECTOR_DATABASE_URL
    else
      process.env.VECTOR_DATABASE_URL = previous
  })
  const metadata = new Map()
  const snapshots = new Set(['legacy'])
  const statements = []
  let failWrite = false
  let released = 0
  let closed = 0
  t.mock.method(Pool.prototype, 'query', async () => {
    throw new Error('Must use the transaction connection')
  })
  t.mock.method(Pool.prototype, 'connect', async () => ({
    async query(sql, values = []) {
      statements.push({ sql, values })
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock') || sql.startsWith('CREATE TABLE'))
        return { rows: [] }
      if (sql.includes('to_regclass'))
        return { rows: [{ snapshots: 'rag_vector_snapshots' }] }
      if (sql.includes('SELECT 1 FROM rag_vector_snapshots'))
        return { rows: snapshots.has(values[0]) ? [{}] : [] }
      if (sql.includes('SELECT 1 FROM knowledge_bases'))
        return { rows: metadata.has(values[0]) ? [{}] : [] }
      assert.ok(sql.startsWith('INSERT INTO knowledge_bases'))
      if (failWrite)
        throw new Error('postgresql://private-password@private-host:5432/private-db and secret SQL')
      if (sql.includes('DO NOTHING') && metadata.has(values[0]))
        return { rows: [] }
      metadata.set(values[0], values[1])
      return { rows: [{ id: values[0], description: values[1] }] }
    },
    release() { released++ },
  }))
  t.mock.method(Pool.prototype, 'end', async () => {
    closed++
  })
  return { metadata, snapshots, statements, fail: () => {
    failWrite = true
  }, resources: () => ({ released, closed }) }
}

function send(method, path, body) {
  return app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

test('knowledge base creation persists trimmed metadata, rejects duplicate names and preserves descriptions on conflict', async (t) => {
  const db = database(t)
  const response = await send('POST', '/api/workspace/knowledge-bases', { name: ' 前端开发 ', description: ' React 与组件实践 \n' })
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { id: '前端开发', description: 'React 与组件实践' })
  assert.equal(db.metadata.get('前端开发'), 'React 与组件实践')
  const duplicate = await send('POST', '/api/workspace/knowledge-bases', { name: '前端开发', description: '覆盖原描述' })
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, 'WORKSPACE_CONFLICT')
  assert.equal(db.metadata.get('前端开发'), 'React 与组件实践')
  assert.equal((await send('POST', '/api/workspace/knowledge-bases', { name: 'legacy' })).status, 409)
  const optional = await send('POST', '/api/workspace/knowledge-bases', { name: '不填描述' })
  assert.deepEqual(await optional.json(), { id: '不填描述', description: '' })
  assert.ok(db.statements.some(({ sql }) => sql === 'COMMIT'))
  assert.ok(db.statements.some(({ sql }) => sql === 'ROLLBACK'))
  assert.deepEqual(db.resources(), { released: 4, closed: 4 })
})

test('description editing supports old and empty bases, clearing descriptions and encoded IDs without changing vector snapshots', async (t) => {
  const db = database(t)
  const legacy = await send('PATCH', '/api/workspace/knowledge-bases/legacy', { description: ' 旧库的内容范围 ' })
  assert.equal(legacy.status, 200)
  assert.equal(db.metadata.get('legacy'), '旧库的内容范围')
  assert.ok(db.snapshots.has('legacy'))
  const id = '产品/设计 #1'
  await send('POST', '/api/workspace/knowledge-bases', { name: id, description: '初始描述' })
  const update = await send('PATCH', `/api/workspace/knowledge-bases/${encodeURIComponent(id)}`, { description: '' })
  assert.equal(update.status, 200)
  assert.deepEqual(await update.json(), { id, description: '' })
  assert.equal(db.metadata.get(id), '')
  const missing = await send('PATCH', '/api/workspace/knowledge-bases/missing', { description: '不要创建' })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'WORKSPACE_NOT_FOUND')
  assert.ok(!db.metadata.has('missing'))
  assert.ok(!db.statements.some(({ sql }) => /(?:INSERT INTO|UPDATE|DELETE FROM) rag_/.test(sql)))
  const inserts = db.statements.filter(({ sql }) => sql.startsWith('INSERT INTO knowledge_bases'))
  assert.ok(inserts.every(({ sql, values }) => sql.includes('$1') && sql.includes('$2') && values.length === 2 && !sql.includes('旧库的内容范围')))
})

test('invalid metadata and oversized JSON fail before any database access', async (t) => {
  const db = database(t)
  for (const body of [null, {}, { name: ' ' }, { name: 'x'.repeat(65) }, { name: 'a', description: 1 }, { name: 'a', description: 'x'.repeat(1001) }, { name: 'a', description: '\0' }, { name: 'a', unknown: true }])
    assert.equal((await send('POST', '/api/workspace/knowledge-bases', body)).status, 400)
  for (const body of [{}, { description: null }, { description: 'x'.repeat(1001) }, { description: '', name: 'rename' }])
    assert.equal((await send('PATCH', '/api/workspace/knowledge-bases/legacy', body)).status, 400)
  assert.equal((await app.request('/api/workspace/knowledge-bases', { method: 'POST', body: '{invalid' })).status, 400)
  assert.equal((await send('POST', '/api/workspace/knowledge-bases', { name: 'a', description: 'x'.repeat(17000) })).status, 413)
  assert.deepEqual(db.statements, [])
})

test('write failures roll back and close resources without exposing database credentials', async (t) => {
  const db = database(t)
  db.fail()
  const response = await send('POST', '/api/workspace/knowledge-bases', { name: 'failed', description: '资料' })
  assert.equal(response.status, 502)
  const body = await response.text()
  assert.ok(body.includes('WORKSPACE_DATABASE_ERROR'))
  assert.ok(!body.includes('private-'))
  assert.ok(db.statements.some(({ sql }) => sql === 'ROLLBACK'))
  assert.deepEqual(db.resources(), { released: 1, closed: 1 })
})
