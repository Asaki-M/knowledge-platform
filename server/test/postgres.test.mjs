import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:net'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 验证领域错误保留与数据库异常脱敏。
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- 仅用内存连接模拟提交、回滚及清理，不访问数据库。
import { closePostgresResources, createPostgresPool, queryRows, withPostgresTransaction } from '../dist/utils/postgres.js'

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

function pgMessage(type, body) {
  const header = Buffer.alloc(5)
  header.write(type)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

/** 只模拟本地 PostgreSQL 协议握手与查询响应，不使用真实数据库。 */
async function localPostgres(t, onQuery) {
  const sockets = new Set()
  const queries = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    let startup = true
    const ready = status => socket.write(pgMessage('Z', Buffer.from(status)))
    const complete = (command, status) => {
      socket.write(pgMessage('C', Buffer.from(`${command}\0`)))
      ready(status)
    }
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      if (startup) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0))
          return
        buffer = buffer.subarray(buffer.readInt32BE(0))
        startup = false
        socket.write(pgMessage('R', Buffer.alloc(4)))
        ready('I')
      }
      while (buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1) + 1) {
        const length = buffer.readInt32BE(1) + 1
        const type = String.fromCharCode(buffer[0])
        const body = buffer.subarray(5, length)
        buffer = buffer.subarray(length)
        if (type === 'Q') {
          const sql = body.toString().replace(/\0$/, '')
          queries.push(sql)
          onQuery(sql, complete)
        }
        else if (type === 'X') {
          socket.end()
        }
      }
    })
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    for (const socket of sockets)
      socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { sockets, queries, connectionString: `postgresql://local:local@127.0.0.1:${server.address().port}/local` }
}

function localPool(connectionString, options = {}) {
  return createPostgresPool({ connectionString, ssl: false, max: 1, ...options }, {
    configuration: databaseFailure(),
    databaseCode: 'VECTOR_STORE_DATABASE_ERROR',
    event: 'postgres.local-test.connection.failed',
  })
}

test('a borrowed connection can disconnect without an unhandled error terminating the server', { timeout: 3000 }, async (t) => {
  const fixture = await localPostgres(t, () => {})
  const pool = localPool(fixture.connectionString)
  const client = await pool.connect()
  try {
    // 不在测试中添加 error 监听，真实借出连接必须由公共连接层保护。
    const ended = new Promise(resolve => client.once('end', resolve))
    for (const socket of fixture.sockets)
      socket.destroy()
    await ended
  }
  finally {
    client.release(true)
    await pool.end()
  }
})

test('a stalled response times out, discards its transaction connection and never commits', { timeout: 3000 }, async (t) => {
  const fixture = await localPostgres(t, (sql, complete) => {
    if (sql === 'BEGIN')
      complete('BEGIN', 'T')
    // 模拟 SQL 或响应读取无进展，故意不返回 SELECT 的结果。
  })
  const pool = localPool(fixture.connectionString, { query_timeout: 50 })
  try {
    const failure = databaseFailure()
    await assert.rejects(withPostgresTransaction(pool, client => client.query('SELECT stalled'), failure), error => error === failure)
    assert.deepEqual(fixture.queries, ['BEGIN', 'SELECT stalled'])
    assert.equal(pool.totalCount, 0)
  }
  finally {
    await pool.end()
  }
})
