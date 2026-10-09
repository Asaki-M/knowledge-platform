import type { IngestionEvent, IngestionResult, IngestionStage } from './types'
import { ApiError } from '@/utils/api'

export async function readIngestionStream(body: unknown, signal: AbortSignal, onStage: (stage: IngestionStage) => void, onRequestId: (id: string) => void): Promise<IngestionResult> {
  const response = await fetch('/api/documents/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/x-ndjson' },
    body: JSON.stringify(body),
    signal,
  })
  const requestId = response.headers.get('X-Request-Id') ?? undefined
  if (requestId)
    onRequestId(requestId)
  if (!response.ok) {
    const failure = await response.json().catch(() => null)
    throw new ApiError(failure?.error?.message ?? '请求失败，请稍后重试。', failure?.error?.code ?? `HTTP_${response.status}`, failure?.requestId ?? requestId)
  }
  if (!response.body || !response.headers.get('Content-Type')?.includes('application/x-ndjson'))
    throw new ApiError('服务未返回阶段进度，请确认前后端已更新。', 'INVALID_STREAM', requestId)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: IngestionResult | undefined
  const consume = (line: string) => {
    if (!line.trim())
      return
    let event: IngestionEvent
    try {
      event = JSON.parse(line) as IngestionEvent
    }
    catch { throw new ApiError('阶段进度无法读取，请检查服务连接。', 'INVALID_STREAM', requestId) }
    if (event.type === 'start')
      onRequestId(event.requestId)
    else if (event.type === 'stage')
      onStage(event.stage)
    else if (event.type === 'result')
      result = event.result
    else if (event.type === 'error')
      throw new ApiError(event.error.message, event.error.code, event.requestId)
    else if (event.type !== 'ping')
      throw new ApiError('服务返回了未知的阶段事件。', 'INVALID_STREAM', requestId)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      // 网络分片可能截断 JSON 行或中文字符，必须先完整解码并组行。
      buffer += decoder.decode(value, { stream: !done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (done) {
        consume(buffer)
        break
      }
    }
    if (!result)
      throw new ApiError('进度连接已中断，入库状态尚未确认，请查看操作日志后再决定是否重试。', 'STREAM_INTERRUPTED', requestId)
    return result
  }
  catch (failure) {
    if (failure instanceof ApiError || signal.aborted)
      throw failure
    throw new ApiError('进度连接已中断，入库状态尚未确认，请查看操作日志后再决定是否重试。', 'STREAM_INTERRUPTED', requestId)
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
