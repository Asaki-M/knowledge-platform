import type { PoolClient } from 'pg'
import process from 'node:process'
import { WORKSPACE_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { closePostgresResources, createPostgresPool, withPostgresTransaction } from '../../utils/postgres.js'

export interface KnowledgeBaseMetadata { id: string, description: string }

/** 名称沿用既有知识库 ID；描述独立保存，修改它不触发向量重建。 */
export class KnowledgeBasesDao {
  private async write<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = createPostgresPool({ connectionString: process.env.VECTOR_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'knowledge-bases' }, { configuration: new AppError(CODES.CONFIGURATION_ERROR, 'Knowledge bases require a database'), databaseCode: CODES.DATABASE_ERROR, event: 'knowledge-bases.connection.failed' })
    try {
      return await withPostgresTransaction(pool, async (client) => {
        // 首次写入才建表；事务锁避免多个实例同时初始化或创建同名库。
        await client.query('SELECT pg_advisory_xact_lock(731952686)')
        await client.query(`CREATE TABLE IF NOT EXISTS knowledge_bases (
          knowledge_base_id text PRIMARY KEY,
          description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`)
        return operation(client)
      }, new AppError(CODES.DATABASE_ERROR, 'Could not save knowledge base metadata'))
    }
    finally { await closePostgresResources([{ close: () => pool.end() }]) }
  }

  private async hasSnapshot(client: PoolClient, id: string): Promise<boolean> {
    const { rows } = await client.query<{ snapshots: string | null }>('SELECT to_regclass(\'rag_vector_snapshots\')::text AS snapshots')
    if (!rows[0]?.snapshots)
      return false
    return (await client.query('SELECT 1 FROM rag_vector_snapshots WHERE knowledge_base_id = $1', [id])).rows.length > 0
  }

  async create(metadata: KnowledgeBaseMetadata): Promise<KnowledgeBaseMetadata> {
    return this.write(async (client) => {
      if (await this.hasSnapshot(client, metadata.id))
        throw new AppError(CODES.CONFLICT, 'Knowledge base already exists')
      const { rows } = await client.query<KnowledgeBaseMetadata>(`INSERT INTO knowledge_bases (knowledge_base_id, description) VALUES ($1, $2)
        ON CONFLICT (knowledge_base_id) DO NOTHING RETURNING knowledge_base_id AS id, description`, [metadata.id, metadata.description])
      if (!rows[0])
        throw new AppError(CODES.CONFLICT, 'Knowledge base already exists')
      return rows[0]
    })
  }

  async updateDescription(metadata: KnowledgeBaseMetadata): Promise<KnowledgeBaseMetadata> {
    return this.write(async (client) => {
      const existing = await client.query('SELECT 1 FROM knowledge_bases WHERE knowledge_base_id = $1', [metadata.id])
      // 旧库只有向量快照，首次编辑时补充元数据；不存在的 ID 不能凭空创建。
      if (!existing.rows.length && !await this.hasSnapshot(client, metadata.id))
        throw new AppError(CODES.NOT_FOUND, 'Knowledge base does not exist')
      const { rows } = await client.query<KnowledgeBaseMetadata>(`INSERT INTO knowledge_bases (knowledge_base_id, description) VALUES ($1, $2)
        ON CONFLICT (knowledge_base_id) DO UPDATE SET description = EXCLUDED.description, updated_at = now()
        RETURNING knowledge_base_id AS id, description`, [metadata.id, metadata.description])
      return rows[0]!
    })
  }
}
