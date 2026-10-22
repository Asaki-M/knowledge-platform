import type { PoolClient, PoolConfig, QueryResultRow } from 'pg'
import type { AppErrorCode } from '../error-codes.js'
import { Pool } from 'pg'
import { AppError } from '../errors.js'
import { log } from '../telemetry/logger.js'

/** 只复用 PostgreSQL 连接机制；凭据来源、超时与领域错误仍由调用方决定。 */
export function createPostgresPool(config: PoolConfig, errors: { configuration: AppError, databaseCode: AppErrorCode, event: string }): Pool {
  try {
    if (!config.connectionString?.trim() || !['postgres:', 'postgresql:'].includes(new URL(config.connectionString).protocol))
      throw errors.configuration
  }
  catch { throw errors.configuration }
  // statement_timeout 只限制数据库执行；客户端还需覆盖结果读取和网络停滞。
  const readTimeout = config.query_timeout ?? Math.min(Math.max(60000, (config.statement_timeout || 30000) + 5000), 2147483647)
  const pool = new Pool({
    ...config,
    query_timeout: readTimeout,
    keepAlive: config.keepAlive ?? true,
    keepAliveInitialDelayMillis: config.keepAliveInitialDelayMillis ?? 10000,
  })
  const connectionFailed = () => log.error(errors.event, { 'error.code': errors.databaseCode })
  // Pool 只监听空闲连接；事务或会话锁借出的连接断开时也必须接住 error 事件。
  pool.on('connect', client => client.on('error', connectionFailed))
  pool.on('error', connectionFailed)
  return pool
}

/** SQL 参数始终由调用方绑定；数据库原始异常不进入日志或对外响应。 */
export async function queryRows<T extends QueryResultRow>(executor: Pool | PoolClient, sql: string, values: unknown[], failure: AppError): Promise<T[]> {
  try {
    return (await executor.query<T>(sql, values)).rows
  }
  catch { throw failure }
}

/** 同一连接完成事务；回滚失败的连接必须丢弃，不能再次进入连接池。 */
export async function withPostgresTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>, failure: AppError, readOnly = false): Promise<T> {
  let client: PoolClient | undefined
  let discard = false
  try {
    client = await pool.connect()
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const result = await action(client)
    await client.query('COMMIT')
    return result
  }
  catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK')
      }
      catch { discard = true }
    }
    throw error instanceof AppError ? error : failure
  }
  finally { client?.release(discard) }
}

/** 每个资源都尝试关闭；清理失败仅记脱敏事件，不改写已提交结果或原始业务错误。 */
export async function closePostgresResources(resources: readonly ({ close: () => Promise<void> } | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(resources.map(async resource => resource?.close()))
  if (results.some(result => result.status === 'rejected'))
    log.error('postgres.cleanup.failed')
}
