import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { test } from 'node:test'
import { Pool } from 'pg'
// eslint-disable-next-line antfu/no-import-dist -- 显式启用时在临时数据库验证真实断点持久化及会话锁。
import { DocumentIngestionDao } from '../dist/core/dao/document-ingestions.js'

const connectionString = process.env.VECTOR_STORE_TEST_DATABASE_URL

test('ingestion checkpoints survive reconnects and process-like lock release, with cancellation and isolated job data', { skip: !connectionString, timeout: 60000 }, async (t) => {
  const database = `knowledge_checkpoint_test_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString, max: 1 })
  const daos = []
  t.after(async () => {
    for (const dao of daos)
      await dao.close()
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  const create = () => {
    const dao = new DocumentIngestionDao(url.href)
    daos.push(dao)
    return dao
  }
  const owner = create()
  const other = create()
  await owner.initialize()
  await other.initialize()
  const id = randomUUID()
  await owner.acquire(id)
  await owner.create({ id, version: 1, fingerprint: 'fingerprint', input: { request: { knowledgeBaseId: 'test', documentId: 'document', content: '# 正文' }, options: { llm: { provider: 'stub', model: 'test' }, embedding: { provider: 'stub', model: 'test' } } } })
  await owner.start(id, 'request-1')
  await owner.checkpoints(id).save('section:1', { enrichment: { summary: '已完成的章节' } })
  await owner.checkpoints(id).save('progress:enrichment', { id: 'enrichment', status: 'running', durationMs: 12, progress: { completed: 1, total: 2 } })
  await assert.rejects(other.acquire(id), { code: 'INGESTION_TASK_CONFLICT' })
  assert.equal(await other.isActive(id), true)
  await other.cancel(id)
  assert.equal(await owner.cancellationRequested(id), true)
  await owner.close()
  daos.splice(daos.indexOf(owner), 1)
  assert.equal(await other.isActive(id), false)
  await other.acquire(id)
  assert.equal((await other.get(id)).status, 'running')
  assert.deepEqual(await other.checkpoints(id).load('section:1'), { enrichment: { summary: '已完成的章节' } })
  assert.equal(await other.checkpoints(id).load('missing'), undefined)
  assert.equal((await other.stages(id))[0].progress.completed, 1)
  await other.start(id, 'request-2')
  assert.equal(await other.cancellationRequested(id), false)
  await other.finish(id, 'interrupted', { code: 'INGESTION_ABORTED', message: '中断' })
  assert.equal((await other.get(id)).error.code, 'INGESTION_ABORTED')
  assert.equal(await other.get(randomUUID()), null)
  assert.equal(await other.checkpoints(randomUUID()).load('section:1'), undefined)
})
