// eslint-disable-next-line antfu/no-import-dist -- 模拟应用断点持久化边界，不访问真实数据库。
import { DocumentIngestionDao } from '../dist/core/dao/document-ingestions.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证统一异常分类。
import { AppError } from '../dist/errors.js'

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

export function stubIngestionCheckpoints(t) {
  const jobs = new Map()
  const values = new Map()
  const locks = new Map()
  t.mock.method(DocumentIngestionDao.prototype, 'initialize', async () => {})
  t.mock.method(DocumentIngestionDao.prototype, 'acquire', async function (id) {
    if (locks.has(id))
      throw new AppError('INGESTION_TASK_CONFLICT', 'Task is already running')
    locks.set(id, this)
  })
  t.mock.method(DocumentIngestionDao.prototype, 'get', async id => copy(jobs.get(id) ?? null))
  t.mock.method(DocumentIngestionDao.prototype, 'create', async (job) => {
    jobs.set(job.id, { ...copy(job), status: 'running', error: null, result: null, requestId: null, cancelRequested: false })
    values.set(job.id, new Map())
  })
  t.mock.method(DocumentIngestionDao.prototype, 'start', async (id, requestId) => {
    Object.assign(jobs.get(id), { status: 'running', error: null, requestId, cancelRequested: false })
  })
  t.mock.method(DocumentIngestionDao.prototype, 'finish', async (id, status, error, result = null) => {
    Object.assign(jobs.get(id), { status, error: copy(error), result: copy(result) })
  })
  t.mock.method(DocumentIngestionDao.prototype, 'checkpoints', id => ({
    load: async key => copy(values.get(id)?.get(key)),
    save: async (key, value) => { values.get(id).set(key, copy(value)) },
  }))
  t.mock.method(DocumentIngestionDao.prototype, 'stages', async id => [...(values.get(id)?.entries() ?? [])].filter(([key]) => key.startsWith('progress:')).map(([, value]) => copy(value)))
  t.mock.method(DocumentIngestionDao.prototype, 'isActive', async id => locks.has(id))
  t.mock.method(DocumentIngestionDao.prototype, 'cancel', async (id) => {
    jobs.get(id).cancelRequested = true
  })
  t.mock.method(DocumentIngestionDao.prototype, 'cancellationRequested', async id => jobs.get(id).cancelRequested)
  t.mock.method(DocumentIngestionDao.prototype, 'close', async function () {
    for (const [id, owner] of locks) {
      if (owner === this)
        locks.delete(id)
    }
  })
  return { jobs, values, locks }
}
