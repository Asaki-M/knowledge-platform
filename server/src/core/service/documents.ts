import type { IngestionObserver } from '../../rag/ingestion/index.js'
import type { IngestionJobInput } from '../dao/document-ingestions.js'
import type { OperationTracker } from './operation-logs.js'
import { randomUUID } from 'node:crypto'
import { HTTP_ERROR_CODES, INGESTION_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { contentHash } from '../../rag/content-hash.js'
import { ingestDocument } from '../../rag/ingestion/index.js'
import { PgVectorStore } from '../../rag/vector-store/index.js'
import { closePostgresResources } from '../../utils/postgres.js'
import { isNonEmptyString, isRecord } from '../../utils/type-guards.js'
import { DocumentIngestionDao } from '../dao/document-ingestions.js'
import { errorResponse } from '../error-response.js'
import { createEmbeddingClient, createLlmClient, ingestionEmbeddingOptions, ingestionLlmOptions } from './model-options.js'
import { summarizeIngestion } from './operation-logs.js'

function input(body: unknown): IngestionJobInput {
  if (!isRecord(body) || !isNonEmptyString(body.knowledgeBaseId) || !isRecord(body.document)
    || !isNonEmptyString(body.document.id) || !isNonEmptyString(body.document.content)
    || body.knowledgeBaseId.length > 256 || body.document.id.length > 256 || body.document.content.length > 200000
    || (body.document.sourcePath !== undefined && (!isNonEmptyString(body.document.sourcePath) || body.document.sourcePath.length > 2048))
    || (body.document.format !== undefined && body.document.format !== 'nextra-mdx')) {
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '需要 knowledgeBaseId 和 document（id、content）；支持 nextra-mdx，正文最多 200000 字符。')
  }
  const request = { knowledgeBaseId: body.knowledgeBaseId.trim(), documentId: body.document.id.trim(), content: body.document.content, ...(body.document.sourcePath === undefined ? {} : { sourcePath: body.document.sourcePath as string }) }
  const options = { llm: ingestionLlmOptions(body.llm), embedding: ingestionEmbeddingOptions(body.embedding) }
  return { request, options }
}

const checkpointVersion = 1

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '入库任务标识必须是 UUID。')
  return value.toLowerCase()
}

/** 调用方可先生成任务 ID，网络在 start 事件之前中断也能按同一 ID 恢复。 */
export function withIngestionId(body: unknown): unknown {
  return isRecord(body) && body.document !== undefined ? { ...body, ingestionId: body.ingestionId ?? randomUUID() } : body
}

export async function ingest(body: unknown, signal?: AbortSignal, operation?: OperationTracker, onStage?: IngestionObserver, requestId: string | null = null) {
  await operation?.setScope(body)
  if (!isRecord(body))
    input(body)
  const envelope = body as Record<string, unknown>
  const id = taskId(envelope.ingestionId ?? randomUUID())
  const resumeOnly = envelope.document === undefined && envelope.ingestionId !== undefined
  if (resumeOnly && Object.keys(envelope).some(key => key !== 'ingestionId'))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '继续任务只需 ingestionId；修改正文或模型请新建任务。')
  // 原始请求先校验再访问数据库；重试使用已保存的输入和配置快照。
  const incoming = resumeOnly ? undefined : input(envelope)
  const dao = new DocumentIngestionDao()
  let store: PgVectorStore | undefined
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let polling: Promise<void> | undefined
  let checkpointFailure: unknown
  let started = false
  try {
    await dao.initialize()
    await dao.acquire(id)
    let job = await dao.get(id)
    if (!job) {
      if (!incoming)
        throw new AppError(INGESTION_ERROR_CODES.TASK_NOT_FOUND, '没有找到这个入库任务，请重新提交文档。')
      await dao.create({ id, version: checkpointVersion, fingerprint: contentHash([checkpointVersion, incoming]), input: incoming })
      job = (await dao.get(id))!
    }
    if (job.version !== checkpointVersion || (incoming && job.fingerprint !== contentHash([checkpointVersion, incoming])))
      throw new AppError(INGESTION_ERROR_CODES.TASK_CONFLICT, '任务正文、配置或检查点版本已变化，请新建任务。')
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
    operation?.setSummary({ models: { llm: [{ provider: options.llm.provider, model: options.llm.model }], embedding: options.embedding } })
    // 中断接口对跨页面/进程请求同样有效；查询失败即停止，避免断点不可用时继续花费额度。
    heartbeat = setInterval(() => {
      if (polling)
        return
      polling = dao.cancellationRequested(id).then((cancelled) => {
        if (cancelled)
          controller.abort()
      }).catch((error: unknown) => {
        checkpointFailure = error
        controller.abort()
      }).finally(() => { polling = undefined })
    }, 1000)
    store = new PgVectorStore()
    await store.initialize()
    const result = await ingestDocument({ ...request, signal: combined }, { store, llm: createLlmClient('enrichment'), embedding: createEmbeddingClient() }, {
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
    const error = checkpointFailure ?? (combined.aborted && started ? new AppError(INGESTION_ERROR_CODES.ABORTED, 'Document ingestion was interrupted') : caught)
    if (started) {
      const failure = errorResponse(error, requestId ?? '')
      await dao.finish(id, combined.aborted && !checkpointFailure ? 'interrupted' : 'failed', failure.body.error).catch(() => {})
    }
    throw error
  }
  finally {
    if (heartbeat)
      clearInterval(heartbeat)
    await polling
    await closePostgresResources([store, dao])
  }
}

export async function ingestionTask(id: string) {
  const dao = new DocumentIngestionDao()
  try {
    id = taskId(id)
    await dao.initialize()
    const job = await dao.get(id)
    if (!job)
      throw new AppError(INGESTION_ERROR_CODES.TASK_NOT_FOUND, '没有找到这个入库任务。')
    const active = job.status === 'running' && await dao.isActive(id)
    return { ingestionId: id, status: job.status === 'running' && !active ? 'interrupted' : job.status, requestId: job.requestId, error: job.error, result: job.result, stages: await dao.stages(id), knowledgeBaseId: job.input.request.knowledgeBaseId, documentId: job.input.request.documentId }
  }
  finally { await closePostgresResources([dao]) }
}

export async function interruptIngestion(id: string) {
  const dao = new DocumentIngestionDao()
  try {
    id = taskId(id)
    await dao.initialize()
    if (!await dao.get(id))
      throw new AppError(INGESTION_ERROR_CODES.TASK_NOT_FOUND, '没有找到这个入库任务。')
    await dao.cancel(id)
    return { ingestionId: id, status: 'interrupt-requested' }
  }
  finally { await closePostgresResources([dao]) }
}
