import type { IngestionObserver } from '../../rag/ingestion/index.js'
import type { IngestionJob, IngestionJobInput } from '../dao/document-ingestions.js'
import type { OperationTracker } from './operation-logs.js'
import { randomUUID } from 'node:crypto'
import { HTTP_ERROR_CODES, INGESTION_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { contentHash } from '../../rag/content-hash.js'
import { parseProvidedEnrichment } from '../../rag/enrichment/index.js'
import { ingestDocument, ingestionLimits } from '../../rag/ingestion/index.js'
import { PgVectorStore } from '../../rag/vector-store/index.js'
import { closePostgresResources } from '../../utils/postgres.js'
import { isNonEmptyString, isRecord } from '../../utils/type-guards.js'
import { DocumentIngestionDao } from '../dao/document-ingestions.js'
import { errorResponse } from '../error-response.js'
import { createEmbeddingClient, createLlmClient, ingestionEmbeddingOptions, ingestionLlmOptions } from './model-options.js'
import { summarizeIngestion } from './operation-logs.js'

function parseIngestionInput(body: unknown): IngestionJobInput {
  if (!isRecord(body) || !isNonEmptyString(body.knowledgeBaseId) || !isRecord(body.document)
    || !isNonEmptyString(body.document.id) || !isNonEmptyString(body.document.content)
    || body.knowledgeBaseId.length > ingestionLimits.identifierCharacters
    || body.document.id.length > ingestionLimits.identifierCharacters
    || body.document.content.length > ingestionLimits.contentCharacters
    || (body.document.sourcePath !== undefined && (!isNonEmptyString(body.document.sourcePath) || body.document.sourcePath.length > ingestionLimits.sourcePathCharacters))
    || (body.document.format !== undefined && body.document.format !== 'nextra-mdx')) {
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '需要 knowledgeBaseId 和 document（id、content）；支持 nextra-mdx，正文最多 200000 字符。')
  }
  const sourcePath = body.document.sourcePath
  const request = {
    knowledgeBaseId: body.knowledgeBaseId.trim(),
    documentId: body.document.id.trim(),
    content: body.document.content,
    ...(typeof sourcePath === 'string' ? { sourcePath } : {}),
  }
  const enrichment = body.enrichment === undefined ? undefined : parseProvidedEnrichment(body.enrichment)
  if (enrichment && body.llm !== undefined)
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '外部提取结果与 llm 不能同时指定；修改提取来源请新建任务。')
  const options = {
    llm: enrichment ? enrichment.source : ingestionLlmOptions(body.llm),
    embedding: ingestionEmbeddingOptions(body.embedding),
    ...(enrichment ? { enrichment } : {}),
  }
  return { request, options }
}

const checkpointVersion = 1

function parseIngestionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '入库任务标识必须是 UUID。')
  return value.toLowerCase()
}

/** 调用方可先生成任务 ID，网络在 start 事件之前中断也能按同一 ID 恢复。 */
export function withIngestionId(body: unknown): unknown {
  return isRecord(body) && body.document !== undefined ? { ...body, ingestionId: body.ingestionId ?? randomUUID() } : body
}

export interface IngestionContext {
  signal?: AbortSignal
  operation?: OperationTracker
  onStage?: IngestionObserver
  requestId?: string | null
}

function parseIngestionEnvelope(body: unknown) {
  if (!isRecord(body))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '需要 knowledgeBaseId 和 document（id、content）；支持 nextra-mdx，正文最多 200000 字符。')
  const id = parseIngestionId(body.ingestionId ?? randomUUID())
  const resumeOnly = body.document === undefined && body.ingestionId !== undefined
  if (resumeOnly && Object.keys(body).some(key => key !== 'ingestionId'))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '继续任务只需 ingestionId；修改正文或模型请新建任务。')
  // 原始请求先校验再访问数据库；重试使用已保存的输入和配置快照。
  return { id, incoming: resumeOnly ? undefined : parseIngestionInput(body) }
}

/** 调用方先持有任务会话锁，再读取或创建不可变的任务快照。 */
async function loadOrCreateJob(dao: DocumentIngestionDao, id: string, incoming?: IngestionJobInput): Promise<IngestionJob> {
  let job = await dao.get(id)
  if (!job) {
    if (!incoming)
      throw new AppError(INGESTION_ERROR_CODES.TASK_NOT_FOUND, '没有找到这个入库任务，请重新提交文档。')
    await dao.create({
      id,
      version: checkpointVersion,
      fingerprint: contentHash([checkpointVersion, incoming]),
      input: incoming,
    })
    job = await dao.get(id)
    if (!job)
      throw new AppError(INGESTION_ERROR_CODES.CHECKPOINT_DATABASE_ERROR, 'Could not read the created ingestion task')
  }
  return job
}

function validateJobSnapshot(job: IngestionJob, incoming?: IngestionJobInput): void {
  if (job.version !== checkpointVersion || (incoming && job.fingerprint !== contentHash([checkpointVersion, incoming])))
    throw new AppError(INGESTION_ERROR_CODES.TASK_CONFLICT, '任务正文、配置或检查点版本已变化，请新建任务。')
}

/** 查询不重叠；检查点故障优先于取消错误，清理时等待在途查询结束。 */
function watchIngestionCancellation(dao: DocumentIngestionDao, id: string, controller: AbortController) {
  let polling: Promise<void> | undefined
  let failure: unknown
  const interval = setInterval(() => {
    if (polling)
      return
    polling = dao.cancellationRequested(id).then((cancelled) => {
      if (cancelled)
        controller.abort()
    }).catch((error: unknown) => {
      failure = error
      controller.abort()
    }).finally(() => { polling = undefined })
  }, 1000)
  return {
    get failure() { return failure },
    async stop() {
      clearInterval(interval)
      await polling
    },
  }
}

export async function ingest(body: unknown, context: IngestionContext = {}) {
  const { signal, operation, onStage, requestId = null } = context
  await operation?.setScope(body)
  const { id, incoming } = parseIngestionEnvelope(body)
  const dao = new DocumentIngestionDao()
  let store: PgVectorStore | undefined
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let cancellation: ReturnType<typeof watchIngestionCancellation> | undefined
  let started = false
  try {
    await dao.initialize()
    await dao.acquire(id)
    const job = await loadOrCreateJob(dao, id, incoming)
    validateJobSnapshot(job, incoming)
    const { request, options } = job.input
    await operation?.setScope({ knowledgeBaseId: request.knowledgeBaseId, document: { id: request.documentId } })
    const checkpoint = dao.checkpoints(id)
    if (job.status === 'succeeded' && job.result) {
      for (const stage of await dao.stages(id))
        await onStage?.({ ...stage, reused: stage.status === 'completed' })
      operation?.setSummary(summarizeIngestion(job.result))
      return { ...job.result, ingestionId: id }
    }
    await dao.start(id, requestId)
    started = true
    operation?.setSummary({
      models: {
        llm: [{ provider: options.llm.provider, model: options.llm.model }],
        embedding: options.embedding,
      },
    })
    // 中断接口对跨页面/进程请求同样有效；查询失败即停止后续模型调用。
    cancellation = watchIngestionCancellation(dao, id, controller)
    store = new PgVectorStore()
    await store.initialize()
    const result = await ingestDocument({ ...request, signal: combined }, {
      store,
      llm: createLlmClient('enrichment'),
      embedding: createEmbeddingClient(),
    }, {
      ...options,
      checkpoint,
      writeKey: id,
      onStage: async (stage) => {
        await checkpoint.save(`progress:${stage.id}`, stage)
        await onStage?.(stage)
      },
    })
    await dao.finish(id, 'succeeded', null, result)
    operation?.setSummary(summarizeIngestion(result))
    return { ...result, ingestionId: id }
  }
  catch (caught) {
    const checkpointFailure = cancellation?.failure
    const error = checkpointFailure ?? (combined.aborted && started ? new AppError(INGESTION_ERROR_CODES.ABORTED, 'Document ingestion was interrupted') : caught)
    if (started) {
      const failure = errorResponse(error, requestId ?? '')
      await dao.finish(id, combined.aborted && !checkpointFailure ? 'interrupted' : 'failed', failure.body.error).catch(() => {})
    }
    throw error
  }
  finally {
    await cancellation?.stop()
    await closePostgresResources([store, dao])
  }
}

export async function ingestionTask(id: string) {
  const dao = new DocumentIngestionDao()
  try {
    id = parseIngestionId(id)
    await dao.initialize()
    const job = await dao.get(id)
    if (!job)
      throw new AppError(INGESTION_ERROR_CODES.TASK_NOT_FOUND, '没有找到这个入库任务。')
    const active = job.status === 'running' && await dao.isActive(id)
    return {
      ingestionId: id,
      status: job.status === 'running' && !active ? 'interrupted' : job.status,
      requestId: job.requestId,
      error: job.error,
      result: job.result,
      stages: await dao.stages(id),
      knowledgeBaseId: job.input.request.knowledgeBaseId,
      documentId: job.input.request.documentId,
    }
  }
  finally { await closePostgresResources([dao]) }
}

export async function interruptIngestion(id: string) {
  const dao = new DocumentIngestionDao()
  try {
    id = parseIngestionId(id)
    await dao.initialize()
    if (!await dao.get(id))
      throw new AppError(INGESTION_ERROR_CODES.TASK_NOT_FOUND, '没有找到这个入库任务。')
    await dao.cancel(id)
    return { ingestionId: id, status: 'interrupt-requested' }
  }
  finally { await closePostgresResources([dao]) }
}
