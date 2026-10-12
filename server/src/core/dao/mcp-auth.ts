import process from 'node:process'
import { MCP_AUTH_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { closePostgresResources, createPostgresPool, withPostgresTransaction } from '../../utils/postgres.js'

export interface OAuthGrantStore {
  save: (digest: string, expiresAt: number) => Promise<void>
  consume: (digest: string, next?: { digest: string, expiresAt: number }) => Promise<boolean>
}

/** 只保存令牌摘要与过期时间；跨 Vercel 实例原子消费，不能用进程内状态防重放。 */
export class McpAuthDao implements OAuthGrantStore {
  private async transaction<T>(operation: Parameters<typeof withPostgresTransaction<T>>[1]): Promise<T> {
    const pool = createPostgresPool({ connectionString: process.env.VECTOR_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'knowledge-mcp-auth' }, { configuration: new AppError(CODES.CONFIGURATION_ERROR, 'MCP OAuth requires a database'), databaseCode: CODES.DATABASE_ERROR, event: 'mcp-auth.connection.failed' })
    try {
      return await withPostgresTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(731952685)')
        await client.query('CREATE TABLE IF NOT EXISTS mcp_oauth_grants (digest text PRIMARY KEY, expires_at timestamptz NOT NULL)')
        await client.query('DELETE FROM mcp_oauth_grants WHERE expires_at <= now()')
        return operation(client)
      }, new AppError(CODES.DATABASE_ERROR, 'MCP authorization database operation failed'))
    }
    finally {
      await closePostgresResources([{ close: () => pool.end() }])
    }
  }

  async save(digest: string, expiresAt: number): Promise<void> {
    await this.transaction(client => client.query('INSERT INTO mcp_oauth_grants (digest, expires_at) VALUES ($1, to_timestamp($2))', [digest, expiresAt]))
  }

  async consume(digest: string, next?: { digest: string, expiresAt: number }): Promise<boolean> {
    return this.transaction(async (client) => {
      const consumed = await client.query('DELETE FROM mcp_oauth_grants WHERE digest = $1 AND expires_at > now() RETURNING digest', [digest])
      if (consumed.rowCount !== 1)
        return false
      // 消费旧令牌与保存新刷新令牌共用事务，保存失败不会丢失旧授权。
      if (next)
        await client.query('INSERT INTO mcp_oauth_grants (digest, expires_at) VALUES ($1, to_timestamp($2))', [next.digest, next.expiresAt])
      return true
    })
  }
}
