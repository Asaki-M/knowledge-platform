import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 验证领域错误保留与数据库异常脱敏。
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- 仅用内存连接模拟提交、回滚及清理，不访问数据库。
import { closePostgresResources, queryRows, withPostgresTransaction } from '../dist/utils/postgres.js'

const databaseFailure = () => new AppError('VECTOR_STORE_DATABASE_ERROR', 'Safe database failure')
function fixture(failedSql) {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      if (failedSql?.includes(sql))
        throw new Error('private database credentials and SQL')
      return { rows: [{ value: 1 }] }
    },
    release(discard) { calls.push(['release', discard]) },
  }
  const pool = { async connect() {
    calls.push('connect')
    return client
  } }
  return { calls, client, pool }
}

test('transactions keep one connection and release only after commit, including repeatable read searches', async () => {
  for (const readOnly of [false, true]) {
    const { calls, pool, client } = fixture()
    const result = await withPostgresTransaction(pool, async (connection) => {
      assert.equal(connection, client)
      await connection.query('chunk search')
      await connection.query('wiki search')
      return 'result'
    }, databaseFailure(), readOnly)
    assert.equal(result, 'result')
    assert.deepEqual(calls, ['connect', readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN', 'chunk search', 'wiki search', 'COMMIT', ['release', false]])
  }
})

test('rollback failures discard connections while keeping the original domain error', async () => {
  for (const rollbackFails of [false, true]) {
    const { calls, pool } = fixture(rollbackFails ? ['ROLLBACK'] : [])
    const original = new AppError('VECTOR_STORE_CONFLICT', 'Snapshot changed')
    await assert.rejects(withPostgresTransaction(pool, async () => {
      throw original
    }, databaseFailure()), error => error === original)
    assert.deepEqual(calls, ['connect', 'BEGIN', 'ROLLBACK', ['release', rollbackFails]])
  }
})

test('connection, begin, query and commit failures are sanitized and never return a partial result', async () => {
  for (const sql of ['BEGIN', 'write', 'COMMIT']) {
    const { calls, pool } = fixture([sql])
    const failure = databaseFailure()
    await assert.rejects(withPostgresTransaction(pool, async client => client.query('write'), failure), error => error === failure)
    assert.deepEqual(calls.at(-1), ['release', false])
    assert.equal(calls.at(-2), 'ROLLBACK')
  }
  const failure = databaseFailure()
  await assert.rejects(withPostgresTransaction({ async connect() {
    throw new Error('private connection string')
  } }, async () => 'unreachable', failure), error => error === failure)
  await assert.rejects(queryRows({ async query() {
    throw new Error('private SQL parameters')
  } }, 'query', [], failure), error => error === failure)
})

test('cleanup attempts every resource even when close throws synchronously or rejects', async () => {
  const closed = []
  await closePostgresResources([
    { close() {
      closed.push('vector')
      throw new Error('private close failure')
    } },
    { async close() {
      closed.push('checkpoint')
      throw new Error('private checkpoint failure')
    } },
    undefined,
    { async close() { closed.push('log') } },
  ])
  assert.deepEqual(closed, ['vector', 'checkpoint', 'log'])
})
