import type { KnowledgeBaseMetadata } from './knowledge-bases.js'
import process from 'node:process'
import { WORKSPACE_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { closePostgresResources, createPostgresPool } from '../../utils/postgres.js'

export interface KnowledgeBaseOption {
  id: string
  description: string
  embedding: { provider: string, model: string, dimensions: number | null } | null
  documents: { id: string, label: string }[]
}
export interface LogScope { knowledgeBaseId: string, documentId: string | null }

/** 只读现有索引元数据；选项请求不建表、不取正文和向量。 */
export async function readWorkspaceCatalog(connectionString = process.env.VECTOR_DATABASE_URL, options: { includeLogScopes?: boolean } = {}) {
  // Neon 休眠后首次连接需要唤醒，目录读取与向量库使用相同的五秒连接预算。
  const pool = createPostgresPool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'knowledge-workspace' }, { configuration: new AppError(CODES.CONFIGURATION_ERROR, 'Workspace requires a PostgreSQL database URL'), databaseCode: CODES.DATABASE_ERROR, event: 'workspace.connection.failed' })
  try {
    const tables = (await pool.query<{ vectors: string | null, snapshots: string | null, logs: string | null, knowledgeBases: string | null }>(`SELECT to_regclass('rag_vectors')::text AS vectors, to_regclass('rag_vector_snapshots')::text AS snapshots, to_regclass('operation_logs')::text AS logs, to_regclass('knowledge_bases')::text AS "knowledgeBases"`)).rows[0]!
    // 首次尚未入库时允许没有表；连接失败与查询错误不能冒充空知识库。
    const knowledgeBases = tables.snapshots && tables.vectors
      ? (await pool.query<KnowledgeBaseOption>(`SELECT s.knowledge_base_id AS id, ''::text AS description,
          jsonb_build_object('provider', s.provider, 'model', s.requested_model, 'dimensions', s.dimensions) AS embedding,
          COALESCE((SELECT jsonb_agg(d ORDER BY d.label, d.id) FROM (
            SELECT source->>'documentId' AS id,
              COALESCE(min(NULLIF(source->>'sourcePath', '')), source->>'documentId') AS label
            FROM rag_vectors v CROSS JOIN LATERAL jsonb_array_elements(v.metadata->'sources') source
            WHERE v.knowledge_base_id = s.knowledge_base_id
            GROUP BY source->>'documentId'
          ) d), '[]'::jsonb) AS documents
        FROM rag_vector_snapshots s ORDER BY s.updated_at DESC, s.knowledge_base_id`)).rows
      : []
    if (tables.knowledgeBases) {
      const metadata = (await pool.query<KnowledgeBaseMetadata>('SELECT knowledge_base_id AS id, description FROM knowledge_bases ORDER BY knowledge_base_id')).rows
      const catalog = new Map(knowledgeBases.map(kb => [kb.id, kb]))
      for (const item of metadata) {
        const existing = catalog.get(item.id)
        if (existing)
          existing.description = item.description
        else
          knowledgeBases.push({ ...item, embedding: null, documents: [] })
      }
    }
    const logScopes = tables.logs && options.includeLogScopes !== false
      ? (await pool.query<LogScope>(`SELECT DISTINCT knowledge_base_id AS "knowledgeBaseId", document_id AS "documentId"
          FROM operation_logs WHERE knowledge_base_id IS NOT NULL ORDER BY knowledge_base_id, document_id`)).rows
      : []
    return { knowledgeBases, logScopes }
  }
  catch {
    throw new AppError(CODES.DATABASE_ERROR, 'Could not read workspace options')
  }
  finally {
    await closePostgresResources([{ close: () => pool.end() }])
  }
}
