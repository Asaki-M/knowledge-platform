import process from 'node:process'
import { Pool } from 'pg'
import { OPERATION_LOG_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'

export type OperationType = 'ingestion' | 'query'
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 仅保存调用摘要，禁止把请求正文、答案、向量或原始异常放入 summary。 */
export interface OperationSummary {
  resultStatus?: string
  counts?: Record<string, number>
  snapshotRevision?: string | null
  normalization?: { characters: number, warningCount: number }
  models?: {
    llm?: { provider: string, model: string, usage?: { inputTokens: number, outputTokens: number, totalTokens: number } | null }[]
    embedding?: { provider: string, model?: string | null, dimensions?: number | null, usage?: { inputTokens: number, totalTokens: number } | null } | null
    rerank?: { provider: string, model: string, usage: { inputTokens: number, outputTokens: number } | null } | null
  }
}

export interface OperationLog {
  id: string
  type: OperationType
  status: OperationStatus
  requestId: string | null
  traceId: string | null
  knowledgeBaseId: string | null
  documentId: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  httpStatus: number | null
  summary: OperationSummary
  error: { code: string, message: string, retryable: boolean } | null
}

export interface OperationLogFilters {
  type?: OperationType
  status?: OperationStatus
  knowledgeBaseId?: string
  documentId?: string
  requestId?: string
  from?: string
  to?: string
  cursor?: string
  limit: number
}

const columns = `id::text, type, status, request_id AS "requestId", trace_id AS "traceId",
  knowledge_base_id AS "knowledgeBaseId", document_id AS "documentId",
  to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
  to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "finishedAt",
  duration_ms AS "durationMs", http_status AS "httpStatus", summary, error`

/** API 操作记录与 RAG 向量表独立；复用本地 PostgreSQL 配置，不依赖 pgvector 扩展。 */
export class OperationLogDao {
  private readonly pool: Pool

  constructor(connectionString = process.env.VECTOR_DATABASE_URL) {
    try {
      if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
        throw new Error('Invalid URL')
    }
    catch {
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Operation logs require a PostgreSQL database URL')
    }
    this.pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1000, statement_timeout: 2000, application_name: 'knowledge-operation-logs' })
    this.pool.on('error', () => log.error('operation-log.connection.failed', { 'error.code': CODES.DATABASE_ERROR }))
  }

  private async query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    try {
      return (await this.pool.query(sql, values)).rows as T[]
    }
    catch {
      throw new AppError(CODES.DATABASE_ERROR, 'Operation log database operation failed')
    }
  }

  /** 首次实际操作或查询时建表；事务锁避免并发首次请求的 DDL 竞态。 */
  async initialize(): Promise<void> {
    let client
    try {
      client = await this.pool.connect()
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(731952682)')
      await client.query(`CREATE TABLE IF NOT EXISTS operation_logs (
        id bigserial PRIMARY KEY,
        type text NOT NULL CHECK (type IN ('ingestion', 'query')),
        status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
        request_id text, trace_id text, knowledge_base_id text, document_id text,
        started_at timestamptz NOT NULL, finished_at timestamptz,
        duration_ms integer CHECK (duration_ms >= 0), http_status integer,
        summary jsonb NOT NULL DEFAULT '{}', error jsonb
      );
      CREATE INDEX IF NOT EXISTS operation_logs_type_id_idx ON operation_logs (type, id DESC);
      CREATE INDEX IF NOT EXISTS operation_logs_scope_id_idx ON operation_logs (knowledge_base_id, id DESC);
      CREATE INDEX IF NOT EXISTS operation_logs_request_idx ON operation_logs (request_id);
      CREATE INDEX IF NOT EXISTS operation_logs_started_idx ON operation_logs (started_at);`)
      await client.query('COMMIT')
    }
    catch {
      if (client)
        await client.query('ROLLBACK').catch(() => {})
      throw new AppError(CODES.DATABASE_ERROR, 'Could not initialize operation logs')
    }
    finally {
      client?.release()
    }
  }

  async start(input: Pick<OperationLog, 'type' | 'requestId' | 'traceId' | 'startedAt'>): Promise<string> {
    const rows = await this.query<{ id: string }>(`INSERT INTO operation_logs (type, status, request_id, trace_id, started_at)
      VALUES ($1, 'running', $2, $3, $4) RETURNING id::text`, [input.type, input.requestId, input.traceId, input.startedAt])
    return rows[0]!.id
  }

  async setScope(id: string, knowledgeBaseId: string | null, documentId: string | null): Promise<void> {
    await this.query('UPDATE operation_logs SET knowledge_base_id = $2, document_id = $3 WHERE id = $1 AND status = \'running\'', [id, knowledgeBaseId, documentId])
  }

  async finish(id: string, input: Pick<OperationLog, 'status' | 'finishedAt' | 'durationMs' | 'httpStatus' | 'summary' | 'error'>): Promise<void> {
    await this.query(`UPDATE operation_logs SET status = $2, finished_at = $3, duration_ms = $4, http_status = $5, summary = $6::jsonb, error = $7::jsonb
      WHERE id = $1 AND status = 'running'`, [id, input.status, input.finishedAt, input.durationMs, input.httpStatus, JSON.stringify(input.summary), input.error === null ? null : JSON.stringify(input.error)])
  }

  async list(filters: OperationLogFilters): Promise<{ items: OperationLog[], nextCursor: string | null }> {
    const values: unknown[] = []
    const conditions: string[] = []
    const add = (column: string, operator: string, value: unknown) => {
      if (value !== undefined) {
        values.push(value)
        conditions.push(`${column} ${operator} $${values.length}`)
      }
    }
    // 列名和运算符全部由代码固定，外部筛选值仅通过绑定参数传入。
    add('type', '=', filters.type)
    add('status', '=', filters.status)
    add('knowledge_base_id', '=', filters.knowledgeBaseId)
    add('document_id', '=', filters.documentId)
    add('request_id', '=', filters.requestId)
    add('started_at', '>=', filters.from)
    add('started_at', '<', filters.to)
    add('id', '<', filters.cursor)
    values.push(filters.limit + 1)
    const rows = await this.query<OperationLog>(`SELECT ${columns} FROM operation_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY operation_logs.id DESC LIMIT $${values.length}`, values)
    const items = rows.slice(0, filters.limit)
    return { items, nextCursor: rows.length > filters.limit ? items.at(-1)!.id : null }
  }

  async get(id: string): Promise<OperationLog | null> {
    return (await this.query<OperationLog>(`SELECT ${columns} FROM operation_logs WHERE id = $1`, [id]))[0] ?? null
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
