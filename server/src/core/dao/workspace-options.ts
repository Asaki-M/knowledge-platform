import process from 'node:process'
import { Pool } from 'pg'
import { WORKSPACE_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'

export interface KnowledgeBaseOption {
  id: string
  embedding: { provider: string, model: string, dimensions: number | null }
  documents: { id: string, label: string }[]
}
export interface LogScope { knowledgeBaseId: string, documentId: string | null }

/** 只读现有索引元数据；选项请求不建表、不取正文和向量。 */
export async function readWorkspaceCatalog(connectionString = process.env.VECTOR_DATABASE_URL) {
  try {
    if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
      throw new Error('Invalid URL')
  }
  catch {
    throw new AppError(CODES.CONFIGURATION_ERROR, 'Workspace requires a PostgreSQL database URL')
  }
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1000, statement_timeout: 5000, application_name: 'knowledge-workspace' })
  pool.on('error', () => log.error('workspace.connection.failed', { 'error.code': CODES.DATABASE_ERROR }))
  try {
    const tables = (await pool.query<{ vectors: string | null, snapshots: string | null, logs: string | null }>(`SELECT to_regclass('rag_vectors')::text AS vectors, to_regclass('rag_vector_snapshots')::text AS snapshots, to_regclass('operation_logs')::text AS logs`)).rows[0]!
    // 首次尚未入库时允许没有表；连接失败与查询错误不能冒充空知识库。
    const knowledgeBases = tables.snapshots && tables.vectors
      ? (await pool.query<KnowledgeBaseOption>(`SELECT s.knowledge_base_id AS id,
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
    const logScopes = tables.logs
      ? (await pool.query<LogScope>(`SELECT DISTINCT knowledge_base_id AS "knowledgeBaseId", document_id AS "documentId"
          FROM operation_logs WHERE knowledge_base_id IS NOT NULL ORDER BY knowledge_base_id, document_id`)).rows
      : []
    return { knowledgeBases, logScopes }
  }
  catch {
    throw new AppError(CODES.DATABASE_ERROR, 'Could not read workspace options')
  }
  finally {
    await pool.end()
  }
}
