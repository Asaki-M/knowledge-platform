import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 验证实际入库 HTTP 编排，不启动外部模型服务。
import { app } from '../dist/core/app.js'
// eslint-disable-next-line antfu/no-import-dist -- 模拟已提交但尚未保存完成状态的窗口。
import { DocumentIngestionDao } from '../dist/core/dao/document-ingestions.js'
// eslint-disable-next-line antfu/no-import-dist -- 模拟操作日志边界。
import { OperationLogDao } from '../dist/core/dao/operation-logs.js'
// eslint-disable-next-line antfu/no-import-dist -- 共用异常分类。
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- 模型替身不访问网络。
import { LlmClient } from '../dist/llm/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 向量模型替身不访问网络。
import { EmbeddingClient } from '../dist/rag/embedding/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 替换事务写入边界。
import { PgVectorStore } from '../dist/rag/vector-store/index.js'
import { stubIngestionCheckpoints } from './ingestion-checkpoint-stub.mjs'

const post = (body, stream = false) => app.request('/api/documents/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify(body) })
const body = (count = 7) => ({ ingestionId: randomUUID(), knowledgeBaseId: 'resume-test', document: { id: 'document', content: Array.from({ length: count }, (_, index) => `# 章节 ${index + 1}\n\n本节说明 ${index + 1}。`).join('\n\n') }, llm: { provider: 'deepseek', model: 'local-test' }, embedding: { provider: 'siliconflow', model: 'local-embedding' } })

function setup(t) {
  const checkpoint = stubIngestionCheckpoints(t)
  const original = process.env.VECTOR_DATABASE_URL
  process.env.VECTOR_DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/stub'
  t.after(() => {
    if (original === undefined)
      delete process.env.VECTOR_DATABASE_URL
    else
      process.env.VECTOR_DATABASE_URL = original
  })
  t.mock.method(OperationLogDao.prototype, 'initialize', async () => {})
  t.mock.method(OperationLogDao.prototype, 'start', async () => '1')
  t.mock.method(OperationLogDao.prototype, 'setScope', async () => {})
  t.mock.method(OperationLogDao.prototype, 'finish', async () => {})
  const calls = { llm: [], embedding: [], writes: 0, attempts: 0 }
  let llmFailure
  let embeddingFailure
  let storageFailure = false
  const receipts = new Map()
  t.mock.method(LlmClient.prototype, 'generate', async (request) => {
    const markdown = JSON.parse(request.messages[1].content).markdown
    calls.llm.push(markdown)
    const failure = await llmFailure?.(request, markdown)
    if (failure)
      throw failure
    return { provider: request.provider, model: request.model, id: `response-${calls.llm.length}`, text: JSON.stringify({ summary: '本节说明。', keywords: [], aliases: [], questions: [], entities: [], concepts: [], relations: [], facts: [], knowledgeType: 'other' }), usage: null, finishReason: 'stop' }
  })
  t.mock.method(EmbeddingClient.prototype, 'embed', async (request) => {
    calls.embedding.push(request.input)
    if (embeddingFailure?.(request))
      throw new AppError('EMBEDDING_CONNECTION_ERROR', 'Local embedding failure')
    return { provider: request.provider, model: request.model, embeddings: request.input.map(() => [1, 0.5, 0.25]), dimensions: 3, usage: null }
  })
  t.mock.method(PgVectorStore.prototype, 'initialize', async () => {})
  t.mock.method(PgVectorStore.prototype, 'getSnapshot', async () => null)
  t.mock.method(PgVectorStore.prototype, 'replaceDocument', async (vectors, _documentId, options) => {
    calls.attempts++
    assert.equal(options.expectedRevision, null)
    assert.ok(options.writeKey)
    assert.equal(options.signal.aborted, false)
    if (receipts.has(options.writeKey))
      return receipts.get(options.writeKey)
    if (storageFailure)
      throw new AppError('VECTOR_STORE_DATABASE_ERROR', 'Local write failure')
    calls.writes++
    const result = { knowledgeBaseId: vectors.knowledgeBaseId, revision: `revision-${calls.writes}`, provider: vectors.provider, requestedModel: vectors.requestedModel, model: vectors.model, dimensions: vectors.dimensions, chunks: vectors.chunks.length, wikiNodes: vectors.wikiNodes.length }
    receipts.set(options.writeKey, result)
    return result
  })
  t.mock.method(PgVectorStore.prototype, 'close', async () => {})
  return { ...checkpoint, calls, failLlm: failure => llmFailure = failure, failEmbedding: failure => embeddingFailure = failure, failStorage: failure => storageFailure = failure }
}

test('retrying section 7 reuses six completed sections, persists input and replays successful tasks without model calls', async (t) => {
  const fixture = setup(t)
  const request = body()
  fixture.failLlm((_request, markdown) => markdown.includes('章节 7') ? new AppError('CONNECTION_ERROR', 'Local disconnect') : undefined)
  const first = await post(request)
  assert.equal(first.status, 502)
  assert.equal(fixture.calls.llm.length, 7)
  assert.equal([...fixture.values.get(request.ingestionId).keys()].filter(key => key.startsWith('section:')).length, 6)
  const task = await (await app.request(`/api/documents/ingestions/${request.ingestionId}`)).json()
  assert.equal(task.status, 'failed')
  assert.deepEqual(task.stages.find(stage => stage.id === 'enrichment').progress, { completed: 6, total: 7 })
  assert.equal(task.input, undefined)
  fixture.failLlm(undefined)
  const retry = await post({ ingestionId: request.ingestionId }, true)
  const events = (await retry.text()).trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).result.counts.sections, 7)
  assert.equal(events.at(-1).result.ingestionId, request.ingestionId)
  assert.equal(fixture.calls.llm.length, 8)
  assert.ok(fixture.calls.llm.at(-1).includes('章节 7'))
  assert.equal(fixture.calls.embedding.length, 1)
  assert.equal(fixture.calls.writes, 1)
  assert.ok(events.some(event => event.stage?.id === 'normalize' && event.stage.reused))
  const replay = await post({ ingestionId: request.ingestionId })
  assert.equal(replay.status, 200)
  assert.equal(fixture.calls.llm.length, 8)
  assert.equal(fixture.calls.embedding.length, 1)
  assert.equal(fixture.calls.attempts, 1)
  for (const change of [{ document: { ...request.document, content: '# 修改后\n\n新正文' } }, { llm: { provider: 'openai', model: 'changed' } }, { embedding: { provider: 'siliconflow', model: 'changed' } }]) {
    assert.equal((await post({ ...request, ...change })).status, 409)
    assert.equal(fixture.calls.llm.length, 8)
  }
  assert.equal((await post({ ingestionId: randomUUID() })).status, 404)
  assert.equal((await post({ ingestionId: 'invalid' })).status, 400)
})

test('retrying an embedding batch or database write never regenerates saved knowledge or completed vectors', async (t) => {
  const fixture = setup(t)
  const request = body(40)
  fixture.failEmbedding(input => input.input.length === 8)
  assert.equal((await post(request)).status, 502)
  assert.equal(fixture.calls.llm.length, 40)
  assert.deepEqual(fixture.calls.embedding.map(input => input.length), [32, 8])
  assert.equal(fixture.calls.writes, 0)
  fixture.failEmbedding(undefined)
  fixture.failStorage(true)
  assert.equal((await post({ ingestionId: request.ingestionId })).status, 502)
  assert.equal(fixture.calls.llm.length, 40)
  assert.deepEqual(fixture.calls.embedding.map(input => input.length), [32, 8, 8])
  fixture.failStorage(false)
  const retry = await post({ ingestionId: request.ingestionId })
  assert.equal(retry.status, 200)
  assert.equal(fixture.calls.llm.length, 40)
  assert.equal(fixture.calls.embedding.length, 3)
  assert.equal(fixture.calls.writes, 1)
})

test('interrupting a task stops the current model request and rejects concurrent retry, then resumes the next section', { timeout: 10000 }, async (t) => {
  const fixture = setup(t)
  const request = body(3)
  let notifyWaiting
  const waiting = new Promise((resolve) => {
    notifyWaiting = resolve
  })
  fixture.failLlm(async (input, markdown) => {
    if (!markdown.includes('章节 3'))
      return
    notifyWaiting()
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))
    return new AppError('ABORTED', 'Local cancellation')
  })
  const stream = await post(request, true)
  const completion = stream.text()
  await waiting
  assert.equal((await post({ ingestionId: request.ingestionId })).status, 409)
  assert.equal(fixture.calls.llm.length, 3)
  const active = await (await app.request(`/api/documents/ingestions/${request.ingestionId}`)).json()
  assert.equal(active.status, 'running')
  const interrupted = await app.request(`/api/documents/ingestions/${request.ingestionId}/interrupt`, { method: 'POST' })
  assert.equal(interrupted.status, 200)
  const events = (await completion).trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).type, 'error')
  assert.equal(fixture.calls.writes, 0)
  assert.equal(fixture.jobs.get(request.ingestionId).status, 'interrupted')
  fixture.failLlm(undefined)
  assert.equal((await post({ ingestionId: request.ingestionId })).status, 200)
  assert.equal(fixture.calls.llm.length, 4)
  assert.equal(fixture.calls.writes, 1)
})

test('a crash-like failure after vector commit recovers the receipt without extra token usage or duplicate writes', async (t) => {
  const fixture = setup(t)
  const request = body(1)
  const checkpoints = DocumentIngestionDao.prototype.checkpoints
  let failSave = true
  t.mock.method(DocumentIngestionDao.prototype, 'checkpoints', function (id) {
    const saved = checkpoints.call(this, id)
    return { ...saved, save: async (key, value) => {
      if (failSave && key === 'stage:storage')
        throw new AppError('INGESTION_CHECKPOINT_DATABASE_ERROR', 'Local crash after commit')
      await saved.save(key, value)
    } }
  })
  assert.equal((await post(request)).status, 502)
  assert.equal(fixture.calls.writes, 1)
  failSave = false
  // 模拟进程重启留下 running，锁已经释放；状态查询应显示中断并允许显式继续。
  fixture.jobs.get(request.ingestionId).status = 'running'
  const restored = await (await app.request(`/api/documents/ingestions/${request.ingestionId}`)).json()
  assert.equal(restored.status, 'interrupted')
  assert.equal((await post({ ingestionId: request.ingestionId })).status, 200)
  assert.equal(fixture.calls.llm.length, 1)
  assert.equal(fixture.calls.embedding.length, 1)
  assert.equal(fixture.calls.writes, 1)
  assert.equal(fixture.calls.attempts, 2)
})

test('vector cleanup failure preserves committed success and original model failure, and releases the task lock', async (t) => {
  const fixture = setup(t)
  t.mock.method(PgVectorStore.prototype, 'close', async () => {
    throw new Error('private cleanup failure')
  })
  const succeeded = body(1)
  const response = await post(succeeded)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).status, 'stored')
  assert.equal(fixture.jobs.get(succeeded.ingestionId).status, 'succeeded')
  assert.equal(fixture.locks.size, 0)
  fixture.failLlm(() => new AppError('CONNECTION_ERROR', 'Local original failure'))
  const failed = body(1)
  const failure = await post(failed)
  assert.equal(failure.status, 502)
  assert.equal((await failure.json()).error.code, 'CONNECTION_ERROR')
  assert.equal(fixture.jobs.get(failed.ingestionId).status, 'failed')
  assert.equal(fixture.locks.size, 0)
})
