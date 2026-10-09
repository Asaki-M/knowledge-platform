import type { PoolClient } from 'pg'
import type { EnrichmentOptions } from '../../rag/enrichment/index.js'
import type { DualIndexEmbeddingOptions } from '../../rag/indexing/index.js'
import type { IngestDocumentRequest, IngestDocumentResult, IngestionCheckpointStore, IngestionStageEvent } from '../../rag/ingestion/index.js'
import process from 'node:process'
import { Pool } from 'pg'
import { INGESTION_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'

export interface IngestionJobInput {
  request: Omit<IngestDocumentRequest, 'signal'>
  options: { llm: EnrichmentOptions, embedding: Omit<DualIndexEmbeddingOptions, 'signal' | 'checkpoint'> }
}

export interface IngestionJob {
  id: string
  fingerprint: string
  version: number
  input: IngestionJobInput
  status: 'running' | 'interrupted' | 'failed' | 'succeeded'
  requestId: string | null
  error: { code: string, message: string } | null
  result: IngestDocumentResult | null
}

const columns = 'id::text, fingerprint, version, input, status, request_id AS "requestId", error, result'
const lockSeed = 731952683

/** 与操作日志分表：这里保存可恢复的正文和产物，日志仍只保存白名单摘要。 */
export class DocumentIngestionDao {
  private readonly pool: Pool
  private client?: PoolClient

  constructor(connectionString = process.env.VECTOR_DATABASE_URL) {
    try {
      if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
        throw new Error('Invalid database URL')
    }
    catch { throw new AppError(CODES.CHECKPOINT_CONFIGURATION_ERROR, 'Ingestion checkpoints require PostgreSQL') }
    this.pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 10000, application_name: 'knowledge-ingestion-checkpoints' })
    this.pool.on('error', () => log.error('ingestion-checkpoint.connection.failed', { 'error.code': CODES.CHECKPOINT_DATABASE_ERROR }))
  }

  private async query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    try {
      return (await (this.client ?? this.pool).query(sql, values)).rows as T[]
    }
    catch { throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Ingestion checkpoint database operation failed') }
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect().catch(() => {
      throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Could not connect to ingestion checkpoints')
    })
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(731952684)')
      await client.query(`CREATE TABLE IF NOT EXISTS document_ingestions (
        id uuid PRIMARY KEY, fingerprint text NOT NULL, version integer NOT NULL, input jsonb NOT NULL,
        status text NOT NULL CHECK (status IN ('running', 'interrupted', 'failed', 'succeeded')),
        request_id text, error jsonb, result jsonb, cancel_requested boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS document_ingestion_checkpoints (
        ingestion_id uuid NOT NULL REFERENCES document_ingestions(id) ON DELETE CASCADE,
        key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (ingestion_id, key)
      );`)
      await client.query('COMMIT')
    }
    catch {
      await client.query('ROLLBACK').catch(() => {})
      throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Could not initialize ingestion checkpoints')
    }
    finally { client.release() }
  }

  /** 持有会话锁直到本次执行结束；进程退出自动释放，避免租约到期导致重复模型调用。 */
  async acquire(id: string): Promise<void> {
    const client = await this.pool.connect().catch(() => {
      throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Could not lock ingestion task')
    })
    try {
      const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired', [id, lockSeed])
      if (!result.rows[0]!.acquired)
        throw new AppError(CODES.TASK_CONFLICT, '这个入库任务仍在执行或保存检查点，请稍后继续。')
      this.client = client
    }
    catch (error) {
      client.release(true)
      if (error instanceof AppError)
        throw error
      throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Could not lock ingestion task')
    }
  }

  async get(id: string): Promise<IngestionJob | null> {
    return (await this.query<IngestionJob>(`SELECT ${columns} FROM document_ingestions WHERE id = $1`, [id]))[0] ?? null
  }

  async create(job: Pick<IngestionJob, 'id' | 'fingerprint' | 'version' | 'input'>): Promise<void> {
    await this.query('INSERT INTO document_ingestions (id, fingerprint, version, input, status) VALUES ($1, $2, $3, $4::jsonb, \'running\')', [job.id, job.fingerprint, job.version, JSON.stringify(job.input)])
  }

  async start(id: string, requestId: string | null): Promise<void> {
    await this.query('UPDATE document_ingestions SET status = \'running\', request_id = $2, error = NULL, cancel_requested = false, updated_at = now() WHERE id = $1', [id, requestId])
  }

  async finish(id: string, status: IngestionJob['status'], error: IngestionJob['error'], result: IngestDocumentResult | null = null): Promise<void> {
    await this.query('UPDATE document_ingestions SET status = $2, error = $3::jsonb, result = $4::jsonb, updated_at = now() WHERE id = $1', [id, status, error === null ? null : JSON.stringify(error), result === null ? null : JSON.stringify(result)])
  }

  checkpoints(id: string): IngestionCheckpointStore {
    return {
      load: async <T>(key: string) => (await this.query<{ value: T }>('SELECT value FROM document_ingestion_checkpoints WHERE ingestion_id = $1 AND key = $2', [id, key]))[0]?.value,
      save: async (key, value) => {
        await this.query('INSERT INTO document_ingestion_checkpoints (ingestion_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (ingestion_id, key) DO UPDATE SET value = EXCLUDED.value', [id, key, JSON.stringify(value)])
      },
    }
  }

  async stages(id: string): Promise<IngestionStageEvent[]> {
    return (await this.query<{ value: IngestionStageEvent }>('SELECT value FROM document_ingestion_checkpoints WHERE ingestion_id = $1 AND key LIKE \'progress:%\'', [id])).map(row => row.value)
  }

  async cancel(id: string): Promise<void> {
    await this.query('UPDATE document_ingestions SET cancel_requested = true WHERE id = $1 AND status = \'running\'', [id])
  }

  async cancellationRequested(id: string): Promise<boolean> {
    return (await this.query<{ cancelled: boolean }>('SELECT cancel_requested AS cancelled FROM document_ingestions WHERE id = $1', [id]))[0]?.cancelled ?? false
  }

  /** 查询时探测会话锁；崩溃遗留 running 展示为中断，不伪造已完成或自动恢复。 */
  async isActive(id: string): Promise<boolean> {
    const client = await this.pool.connect().catch(() => {
      throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Could not inspect ingestion task')
    })
    try {
      await client.query('BEGIN')
      const result = await client.query<{ available: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS available', [id, lockSeed])
      await client.query('COMMIT')
      return !result.rows[0]!.available
    }
    catch {
      await client.query('ROLLBACK').catch(() => {})
      throw new AppError(CODES.CHECKPOINT_DATABASE_ERROR, 'Could not inspect ingestion task')
    }
    finally { client.release() }
  }

  async close(): Promise<void> {
    if (this.client) {
      // 丢弃持锁连接，由数据库释放会话锁，连接故障也不会把原始 SQL 异常透出。
      this.client.release(true)
      this.client = undefined
    }
    await this.pool.end()
  }
}
