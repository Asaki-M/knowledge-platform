import type { IngestionResult, IngestionStage, IngestionStageId, IngestionTask } from './types'
import type { ApiError as ApiErrorType } from '@/utils/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, errorMessage, requestJson } from '@/utils/api'
import { readIngestionStream } from './ingestion-stream'

const sessionKey = 'knowledge-ingestion-task'

function remember(id: string) {
  // 浏览器仅保存不透明任务 ID，正文、问题和答案仍不存入浏览器存储。
  try {
    sessionStorage.setItem(sessionKey, id)
  }
  catch {}
}

function savedTask(): string | null {
  try {
    const id = sessionStorage.getItem(sessionKey)
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null
  }
  catch { return null }
}

export function useIngestion() {
  const [result, setResult] = useState<IngestionResult | null>(null)
  const [stages, setStages] = useState<Partial<Record<IngestionStageId, IngestionStage>>>({})
  const [error, setError] = useState<ApiErrorType | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [ingestionId, setIngestionId] = useState<string | null>(savedTask)
  const [pending, setPending] = useState(false)
  const [remoteRunning, setRemoteRunning] = useState(false)
  const [recovering, setRecovering] = useState(ingestionId !== null)
  const [interrupting, setInterrupting] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)
  const taskRef = useRef<string | null>(ingestionId)

  const inspect = useCallback(async (id: string) => {
    try {
      const { data } = await requestJson<IngestionTask>(`/api/documents/ingestions/${id}`)
      if (!mountedRef.current || taskRef.current !== id || controllerRef.current)
        return
      setStages(Object.fromEntries(data.stages.map(stage => [stage.id, stage])))
      setResult(data.result)
      setRequestId(data.requestId)
      setRemoteRunning(data.status === 'running')
      setError(data.error ? new ApiError(data.error.message, data.error.code, data.requestId ?? undefined) : null)
    }
    catch (failure) {
      if (!mountedRef.current || taskRef.current !== id)
        return
      setRemoteRunning(false)
      setError(errorMessage(failure))
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const saved = taskRef.current
    if (saved) {
      void inspect(saved).finally(() => {
        if (mountedRef.current)
          setRecovering(false)
      })
    }
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [inspect])

  useEffect(() => {
    if (!remoteRunning || !ingestionId)
      return
    // 仅在恢复/中断后尚无进度流的运行任务上查询状态，不轮询健康检查。
    const interval = setInterval(() => {
      void inspect(ingestionId)
    }, 2000)
    return () => clearInterval(interval)
  }, [remoteRunning, ingestionId, inspect])

  async function execute(id: string, body: unknown, fresh: boolean) {
    if (controllerRef.current || remoteRunning || recovering)
      return
    const current = new AbortController()
    controllerRef.current = current
    taskRef.current = id
    remember(id)
    setIngestionId(id)
    setPending(true)
    setRemoteRunning(false)
    setError(null)
    setResult(null)
    if (fresh)
      setStages({})
    setRequestId(null)
    try {
      const stored = await readIngestionStream(body, current.signal, stage => setStages(previous => ({ ...previous, [stage.id]: stage })), setRequestId)
      if (mountedRef.current) {
        setResult(stored)
        return stored
      }
    }
    catch (failure) {
      if (mountedRef.current)
        setError(current.signal.aborted ? new ApiError('入库已中断，已完成结果保留。可以继续重试。', 'INGESTION_ABORTED') : errorMessage(failure))
    }
    finally {
      controllerRef.current = null
      if (mountedRef.current) {
        setPending(false)
        // 断线/取消时先确认事务状态，可能已经提交成功；同一任务不会重复生成。
        if (current.signal.aborted)
          await inspect(id)
      }
    }
  }

  function run(body: Record<string, unknown>) {
    const id = crypto.randomUUID()
    return execute(id, { ...body, ingestionId: id }, true)
  }

  function retry() {
    if (ingestionId)
      return execute(ingestionId, { ingestionId }, false)
  }

  async function interrupt() {
    if (!ingestionId || interrupting)
      return
    setInterrupting(true)
    controllerRef.current?.abort()
    try {
      await requestJson(`/api/documents/ingestions/${ingestionId}/interrupt`, { method: 'POST' })
      await inspect(ingestionId)
    }
    catch (failure) {
      if (mountedRef.current)
        setError(errorMessage(failure))
    }
    finally {
      if (mountedRef.current)
        setInterrupting(false)
    }
  }

  return { result, stages, error, requestId, ingestionId, pending: pending || remoteRunning || recovering, recovering, interrupting, run, retry, interrupt }
}
