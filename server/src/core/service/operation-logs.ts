import type { ingestDocument } from '../../rag/ingestion/index.js'
import type { QueryResult } from '../../rag/query/index.js'
import type { OperationLog, OperationLogFilters, OperationStatus, OperationSummary, OperationType } from '../dao/operation-logs.js'
import { isSpanContextValid, trace } from '@opentelemetry/api'
import { HTTPException } from 'hono/http-exception'
import { ENRICHMENT_ERROR_CODES, HTTP_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'
import { isRecord } from '../../utils/type-guards.js'
import { OperationLogDao } from '../dao/operation-logs.js'

function safeIdentifier(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null
}

/** 不持久化异常 message / stack，避免供应商或解析器错误带入正文与凭据。 */
function failureSummary(error: unknown, httpStatus: number): NonNullable<OperationLog['error']> {
  const code = error instanceof AppError ? error.code : error instanceof HTTPException ? HTTP_ERROR_CODES.HTTP_ERROR : HTTP_ERROR_CODES.INTERNAL_SERVER_ERROR
  const reasons: [boolean, string][] = [
    [code === ENRICHMENT_ERROR_CODES.OUTPUT_TRUNCATED, '知识提取达到生成长度限制，结果不完整，本次文档未写入。'],
    [code === ENRICHMENT_ERROR_CODES.CONTENT_FILTERED, '知识提取被模型服务的内容过滤中止，本次文档未写入。'],
    [code === ENRICHMENT_ERROR_CODES.INCOMPLETE_RESPONSE, '知识提取未正常结束，需查看模型结束原因；历史记录可能包含截断或过滤。'],
    [code === ENRICHMENT_ERROR_CODES.REFUSED, '模型拒绝了本次知识提取，本次文档未写入。'],
    [code.includes('ABORTED'), '操作已取消。'],
    [code.includes('CONFIGURATION'), '服务配置缺失或无效。'],
    [code.includes('AUTHENTICATION'), '模型服务鉴权失败。'],
    [code.includes('RATE_LIMIT'), '模型服务限流或配额不足。'],
    [code.includes('TIMEOUT'), '模型调用超时。'],
    [code.includes('INCONSISTENT_SPACE'), 'Embedding 与知识库向量空间不一致。'],
    [code.includes('CONFLICT'), '知识库版本或文档共享节点发生冲突。'],
    [code.includes('DATABASE'), '数据库操作失败。'],
    [code.includes('PARSE'), '文档语法无法解析。'],
    [httpStatus === 413, '请求体超过大小限制。'],
    [httpStatus === 400, '请求参数或内容无效。'],
  ]
  const message = reasons.find(([matches]) => matches)?.[1] ?? '操作未完成，请根据错误码和请求 ID 排查。'
  return { code, message, retryable: error instanceof AppError && error.retryable }
}

export class OperationTracker {
  private dao?: OperationLogDao
  private id?: string
  private summary: OperationSummary = {}
  private readonly started = performance.now()
  private readonly startedAt = new Date().toISOString()

  constructor(private readonly type: OperationType, private readonly requestId: string | null) {}

  private async persist(action: () => Promise<void>) {
    try {
      await action()
    }
    catch {
      // 日志失败不能把已经提交的入库变成失败响应，也不能掩盖原来的模型错误。
      log.error('operation-log.persistence.failed', { 'operation.type': this.type, 'request.id': this.requestId ?? undefined })
    }
  }

  async start(): Promise<void> {
    const span = trace.getActiveSpan()?.spanContext()
    await this.persist(async () => {
      this.dao = new OperationLogDao()
      await this.dao.initialize()
      this.id = await this.dao.start({ type: this.type, requestId: this.requestId, traceId: span && isSpanContextValid(span) ? span.traceId : null, startedAt: this.startedAt })
    })
  }

  async setScope(body: unknown): Promise<void> {
    if (!this.dao || !this.id || !isRecord(body))
      return
    const knowledgeBaseId = safeIdentifier(body.knowledgeBaseId)
    const documentId = this.type === 'ingestion' && isRecord(body.document) ? safeIdentifier(body.document.id) : null
    await this.persist(() => this.dao!.setScope(this.id!, knowledgeBaseId, documentId))
  }

  setSummary(summary: OperationSummary): void {
    this.summary = summary
  }

  async finish(httpStatus: number, error?: unknown): Promise<void> {
    const failure = httpStatus >= 400 || error !== undefined
    const cancelled = error instanceof AppError && error.code.includes('ABORTED')
    const status = failure ? cancelled ? 'cancelled' : 'failed' : 'succeeded'
    const input = { status: status as OperationStatus, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - this.started), httpStatus, summary: this.summary, error: failure ? failureSummary(error, httpStatus) : null }
    if (this.dao && this.id)
      await this.persist(() => this.dao!.finish(this.id!, input))
    const write = failure ? log.warn : log.info
    write('operation.completed', { 'operation.type': this.type, 'operation.status': status, 'operation.duration_ms': input.durationMs, 'request.id': this.requestId ?? undefined, 'operation.log_id': this.id, 'error.code': input.error?.code })
    if (this.dao)
      await this.persist(() => this.dao!.close())
  }
}

export function summarizeIngestion(result: Awaited<ReturnType<typeof ingestDocument>>): OperationSummary {
  return {
    resultStatus: result.status,
    counts: result.counts,
    snapshotRevision: result.stored.revision,
    normalization: { characters: result.normalization.characters, warningCount: result.normalization.warnings.length },
    models: {
      llm: result.enrichment.map(item => ({ provider: item.provider, model: item.model, usage: item.usage })),
      embedding: { provider: result.embedding.provider, model: result.embedding.model, dimensions: result.embedding.dimensions, usage: result.embedding.usage },
    },
  }
}

export function summarizeQuery(result: QueryResult): OperationSummary {
  return {
    resultStatus: result.status,
    counts: result.counts,
    snapshotRevision: result.snapshotRevision,
    models: {
      llm: result.generation ? [{ provider: result.generation.provider, model: result.generation.model, usage: result.generation.usage }] : [],
      embedding: result.embedding ? { provider: result.embedding.provider, model: result.embedding.model, dimensions: result.embedding.dimensions, usage: result.embedding.usage } : null,
      rerank: result.rerank ? { provider: result.rerank.provider, model: result.rerank.model, usage: result.rerank.usage } : null,
    },
  }
}

export function validateLogId(id: string): string {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '日志 ID / cursor 必须为有效的正整数字符串。')
  return id
}

export function parseLogFilters(query: Record<string, string>): OperationLogFilters {
  query = { ...query }
  const invalid = () => new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '日志筛选参数无效；type 为 ingestion/query，status 为 running/succeeded/failed/cancelled，limit 为 1–100，时间需使用带时区的 ISO 格式。')
  if (Object.keys(query).some(key => !['type', 'status', 'knowledgeBaseId', 'documentId', 'requestId', 'from', 'to', 'cursor', 'limit'].includes(key)))
    throw invalid()
  if (query.type !== undefined && !['ingestion', 'query'].includes(query.type))
    throw invalid()
  if (query.status !== undefined && !['running', 'succeeded', 'failed', 'cancelled'].includes(query.status))
    throw invalid()
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  if (query.limit !== undefined && (!/^\d+$/.test(query.limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100))
    throw invalid()
  for (const key of ['knowledgeBaseId', 'documentId', 'requestId'] as const) {
    if (query[key] !== undefined) {
      const value = safeIdentifier(query[key])
      if (!value)
        throw invalid()
      query[key] = value
    }
  }
  for (const key of ['from', 'to'] as const) {
    if (query[key] !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(query[key]) || !Number.isFinite(Date.parse(query[key]))))
      throw invalid()
  }
  for (const value of [query.from, query.to]) {
    if (value) {
      const [year, month, day] = value.slice(0, 10).split('-').map(Number)
      if (day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23)
        throw invalid()
    }
  }
  if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    throw invalid()
  return { ...query, type: query.type as OperationType | undefined, status: query.status as OperationStatus | undefined, limit, ...(query.cursor === undefined ? {} : { cursor: validateLogId(query.cursor) }) }
}

export async function listOperationLogs(query: Record<string, string>) {
  const filters = parseLogFilters(query)
  const dao = new OperationLogDao()
  try {
    await dao.initialize()
    return await dao.list(filters)
  }
  finally {
    await dao.close()
  }
}

export async function getOperationLog(id: string) {
  validateLogId(id)
  const dao = new OperationLogDao()
  try {
    await dao.initialize()
    const item = await dao.get(id)
    if (!item)
      throw new HTTPException(404, { message: 'Operation log not found' })
    return item
  }
  finally {
    await dao.close()
  }
}
