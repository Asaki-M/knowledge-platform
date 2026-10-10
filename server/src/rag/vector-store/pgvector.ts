import type { Pool, PoolClient } from 'pg'
import type { DualIndexEmbeddingResult } from '../indexing/types.js'
import type { DualVectorSearchRequest, DualVectorSearchResult, SnapshotWriteOptions, VectorSearchHit, VectorSearchRequest, VectorSnapshotInfo, VectorSnapshotStore } from './types.js'
import process from 'node:process'
import { VECTOR_STORE_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'
import { createPostgresPool, withPostgresTransaction } from '../../utils/postgres.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { contentHash } from '../content-hash.js'
import { schemaSql } from './schema.js'
import { assertVector, validateSnapshot } from './validation.js'

export interface PgVectorStoreOptions {
  /** 显式配置优先，否则读取 VECTOR_DATABASE_URL；构造时不连接数据库。 */
  connectionString?: string
  /** 单条 SQL 的服务端超时，默认 30000 毫秒。 */
  statementTimeoutMs?: number
}

const snapshotSql = `SELECT knowledge_base_id AS "knowledgeBaseId", revision, provider,
  requested_model AS "requestedModel", model, dimensions, chunk_count AS chunks, wiki_count AS "wikiNodes"
  FROM rag_vector_snapshots WHERE knowledge_base_id = $1`

/** PostgreSQL / pgvector 持久化；每次写入原子替换一个知识库的两类索引。 */
export class PgVectorStore implements VectorSnapshotStore {
  private readonly pool: Pool

  constructor(options: PgVectorStoreOptions = {}) {
    const connectionString = options.connectionString ?? process.env.VECTOR_DATABASE_URL
    const timeout = options.statementTimeoutMs ?? 30000
    if (!isNonEmptyString(connectionString) || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647)
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Vector database URL and positive statement timeout are required')
    this.pool = createPostgresPool({ connectionString, max: 5, connectionTimeoutMillis: 5000, statement_timeout: timeout, application_name: 'knowledge-vector-store' }, { configuration: new AppError(CODES.CONFIGURATION_ERROR, 'A PostgreSQL database URL is required'), databaseCode: CODES.DATABASE_ERROR, event: 'vector-store.connection.failed' })
  }

  private transaction<T>(operation: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    return withPostgresTransaction(this.pool, operation, new AppError(CODES.DATABASE_ERROR, 'Vector database operation failed'), readOnly)
  }

  /** 显式、幂等的初始化；不放在模块导入或 HTTP 启动路径。 */
  async initialize(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(731952681)')
      await client.query(schemaSql)
    })
  }

  async getSnapshot(knowledgeBaseId: string): Promise<VectorSnapshotInfo | null> {
    if (!isNonEmptyString(knowledgeBaseId))
      throw new AppError(CODES.INVALID_INPUT, 'Knowledge base ID is required')
    return this.transaction(async client => (await client.query<VectorSnapshotInfo>(snapshotSql, [knowledgeBaseId])).rows[0] ?? null, true)
  }

  async replaceSnapshot(input: DualIndexEmbeddingResult, options: SnapshotWriteOptions): Promise<VectorSnapshotInfo> {
    return this.writeSnapshot(input, options)
  }

  /** 仅替换单篇文档的独立节点；跨文档共享节点必须走完整 Wiki 重建流程。 */
  async replaceDocument(input: DualIndexEmbeddingResult, documentId: string, options: SnapshotWriteOptions): Promise<VectorSnapshotInfo> {
    if (!isNonEmptyString(documentId))
      throw new AppError(CODES.INVALID_INPUT, 'Document ID is required')
    return this.writeSnapshot(input, options, documentId)
  }

  private async writeSnapshot(input: DualIndexEmbeddingResult, options: SnapshotWriteOptions, documentId?: string): Promise<VectorSnapshotInfo> {
    validateSnapshot(input, options)
    if (documentId !== undefined && (!input.chunks.length || [...input.chunks, ...input.wikiNodes].some(record => record.sources.some(source => source.documentId !== documentId))))
      throw new AppError(CODES.INVALID_INPUT, 'Document indexes must contain chunks and belong to exactly one document')
    const snapshot = structuredClone(input)
    const { expectedRevision, signal } = options
    const checkCancelled = () => {
      if (signal?.aborted)
        throw new AppError(CODES.ABORTED, 'Vector snapshot write was cancelled')
    }
    checkCancelled()
    const records = [...snapshot.chunks, ...snapshot.wikiNodes].sort((a, b) => a.id.localeCompare(b.id))
    // 用量与请求 ID 不参与内容版本；相同数据重写保持同一版本，不新增重复行。
    const info: VectorSnapshotInfo = {
      knowledgeBaseId: snapshot.knowledgeBaseId,
      revision: contentHash([snapshot.provider, snapshot.requestedModel, snapshot.model, snapshot.dimensions, records]),
      provider: snapshot.provider,
      requestedModel: snapshot.requestedModel,
      model: snapshot.model,
      dimensions: snapshot.dimensions,
      chunks: snapshot.chunks.length,
      wikiNodes: snapshot.wikiNodes.length,
    }
    const fingerprint = contentHash([documentId ?? null, snapshot])
    const result = await this.transaction(async (client) => {
      // 锁也覆盖尚不存在的知识库行，避免两个首次写入任务同时通过版本检查。
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [info.knowledgeBaseId])
      checkCancelled()
      if (options.writeKey !== undefined) {
        const receipt = (await client.query<{ fingerprint: string, result: VectorSnapshotInfo }>('SELECT fingerprint, result FROM rag_vector_write_receipts WHERE knowledge_base_id = $1 AND write_key = $2', [info.knowledgeBaseId, options.writeKey])).rows[0]
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw new AppError(CODES.CONFLICT, 'Write key belongs to a different vector snapshot')
          return receipt.result
        }
      }
      const current = (await client.query<VectorSnapshotInfo>(snapshotSql, [info.knowledgeBaseId])).rows[0]
      if ((current?.revision ?? null) !== expectedRevision)
        throw new AppError(CODES.CONFLICT, 'Vector snapshot changed after it was read')
      if (documentId !== undefined) {
        if (current && current.chunks + current.wikiNodes > 0 && (current.provider !== info.provider || current.requestedModel !== info.requestedModel || current.model !== info.model || current.dimensions !== info.dimensions))
          throw new AppError(CODES.INCONSISTENT_SPACE, 'Document embedding must match the knowledge base vector space')
        // 同时检查旧节点是否跨文档共享，以及新 ID 是否会覆盖别的文档。
        const incompatible = await client.query(`SELECT 1 FROM rag_vectors
          WHERE knowledge_base_id = $1
            AND (metadata->'sources' @> $2::jsonb OR id = ANY($3::text[]))
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'sources') source WHERE source->>'documentId' <> $4)
          LIMIT 1`, [info.knowledgeBaseId, JSON.stringify([{ documentId }]), records.map(record => record.id), documentId])
        if (incompatible.rowCount)
          throw new AppError(CODES.CONFLICT, 'Document has shared nodes; rebuild the complete knowledge base snapshot')
      }
      await client.query(`INSERT INTO rag_vector_snapshots
        (knowledge_base_id, revision, provider, requested_model, model, dimensions, chunk_count, wiki_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (knowledge_base_id) DO UPDATE SET revision = EXCLUDED.revision,
          provider = EXCLUDED.provider, requested_model = EXCLUDED.requested_model, model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions, chunk_count = EXCLUDED.chunk_count, wiki_count = EXCLUDED.wiki_count, updated_at = now()`, [info.knowledgeBaseId, info.revision, info.provider, info.requestedModel, info.model, info.dimensions, info.chunks, info.wikiNodes])
      for (let offset = 0; offset < records.length; offset += 128) {
        checkCancelled()
        const batch = records.slice(offset, offset + 128).map(({ vector, ...metadata }) => ({ id: metadata.id, kind: metadata.kind, metadata, embedding: JSON.stringify(vector) }))
        await client.query(`INSERT INTO rag_vectors (knowledge_base_id, id, kind, metadata, embedding)
          SELECT $1, item.id, item.kind, item.metadata, item.embedding::vector
          FROM jsonb_to_recordset($2::jsonb) AS item(id text, kind text, metadata jsonb, embedding text)
          ON CONFLICT (knowledge_base_id, id) DO UPDATE SET kind = EXCLUDED.kind, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding`, [info.knowledgeBaseId, JSON.stringify(batch)])
      }
      // 删除仅限当前知识库；空快照明确表示清空它的向量，其他知识库不受影响。
      if (documentId === undefined) {
        await client.query('DELETE FROM rag_vectors WHERE knowledge_base_id = $1 AND NOT (id = ANY($2::text[]))', [info.knowledgeBaseId, records.map(record => record.id)])
      }
      else {
        await client.query(`DELETE FROM rag_vectors WHERE knowledge_base_id = $1
          AND metadata->'sources' @> $3::jsonb AND NOT (id = ANY($2::text[]))`, [info.knowledgeBaseId, records.map(record => record.id), JSON.stringify([{ documentId }])])
        // 从数据库实际内容计算整个知识库版本与数量，保留其他文档并保证重复写入幂等。
        const all = (await client.query<{ kind: string, metadata: unknown, vector: string }>('SELECT kind, metadata, embedding::text AS vector FROM rag_vectors WHERE knowledge_base_id = $1 ORDER BY id', [info.knowledgeBaseId])).rows
        info.chunks = all.filter(record => record.kind === 'chunk').length
        info.wikiNodes = all.filter(record => record.kind === 'wiki').length
        info.revision = contentHash([info.provider, info.requestedModel, info.model, info.dimensions, all])
        await client.query('UPDATE rag_vector_snapshots SET revision = $2, chunk_count = $3, wiki_count = $4 WHERE knowledge_base_id = $1', [info.knowledgeBaseId, info.revision, info.chunks, info.wikiNodes])
      }
      checkCancelled()
      // 回执与向量在同一事务提交，覆盖提交后断线/崩溃的恢复窗口。
      if (options.writeKey !== undefined)
        await client.query('INSERT INTO rag_vector_write_receipts (knowledge_base_id, write_key, fingerprint, result) VALUES ($1, $2, $3, $4::jsonb)', [info.knowledgeBaseId, options.writeKey, fingerprint, JSON.stringify(info)])
      return info
    })
    log.info('vector-store.snapshot.written', { 'vector-store.chunks': info.chunks, 'vector-store.wiki_nodes': info.wikiNodes, 'vector-store.dimensions': info.dimensions ?? undefined })
    return result
  }

  /** 起步使用精确余弦检索；按知识库和索引类型过滤，不混用模型空间。 */
  async search(request: VectorSearchRequest): Promise<VectorSearchHit[]> {
    const limit = request.limit ?? 5
    if (![request.knowledgeBaseId, request.provider, request.model].every(isNonEmptyString)
      || !['chunk', 'wiki'].includes(request.kind) || !Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new AppError(CODES.INVALID_INPUT, 'Search scope, vector space and a limit from 1 to 100 are required')
    }
    assertVector(request.vector, request.vector?.length)
    const { knowledgeBaseId, provider, model, kind } = request
    const vector = [...request.vector]
    return this.transaction(async (client) => {
      const info = (await client.query<VectorSnapshotInfo>(snapshotSql, [knowledgeBaseId])).rows[0]
      if (!info || info.model === null)
        return []
      if (info.provider !== provider || info.model !== model || info.dimensions !== vector.length)
        throw new AppError(CODES.INCONSISTENT_SPACE, 'Query vector does not match the stored vector space')
      // 元数据检查与查询使用同一只读快照，避免并发模型切换造成检查后错配。
      return this.searchRecords(client, knowledgeBaseId, kind, JSON.stringify(vector), limit)
    }, true)
  }

  /** 同一个只读事务分别召回两路，单路不足 limit 时返回实际数量。 */
  async searchDual(request: DualVectorSearchRequest): Promise<DualVectorSearchResult> {
    const { knowledgeBaseId, provider, model, expectedRevision, signal, limit = 30 } = request
    if (![knowledgeBaseId, provider, model, expectedRevision].every(isNonEmptyString)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError(CODES.INVALID_INPUT, 'Dual search requires a scope, vector space, revision and valid limit')
    }
    assertVector(request.vector, request.vector?.length)
    const vector = JSON.stringify(request.vector)
    const dimensions = request.vector.length
    const checkCancelled = () => {
      if (signal?.aborted)
        throw new AppError(CODES.ABORTED, 'Dual search was cancelled')
    }
    checkCancelled()
    return this.transaction(async (client) => {
      const info = (await client.query<VectorSnapshotInfo>(snapshotSql, [knowledgeBaseId])).rows[0]
      if (!info || info.revision !== expectedRevision)
        throw new AppError(CODES.CONFLICT, 'Vector snapshot changed before dual search')
      if (info.provider !== provider || info.model !== model || info.dimensions !== dimensions)
        throw new AppError(CODES.INCONSISTENT_SPACE, 'Query vector does not match the stored vector space')
      const search = async (kind: 'chunk' | 'wiki') => {
        checkCancelled()
        return this.searchRecords(client, knowledgeBaseId, kind, vector, limit)
      }
      const chunks = await search('chunk')
      const wikiNodes = await search('wiki')
      checkCancelled()
      return { snapshotRevision: info.revision, chunks, wikiNodes }
    }, true)
  }

  /** 两路复用同一 SQL 与调用方连接，不能在这里另开事务。 */
  private async searchRecords(client: PoolClient, knowledgeBaseId: string, kind: 'chunk' | 'wiki', vector: string, limit: number): Promise<VectorSearchHit[]> {
    return (await client.query<VectorSearchHit>(`SELECT metadata AS document, 1 - (embedding <=> $3::vector) AS score
      FROM rag_vectors WHERE knowledge_base_id = $1 AND kind = $2
      ORDER BY embedding <=> $3::vector, id LIMIT $4`, [knowledgeBaseId, kind, vector, limit])).rows
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
