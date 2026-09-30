export interface LogModel {
  provider: string
  model?: string | null
  dimensions?: number | null
  usage?: Record<string, number> | null
}

export interface OperationLog {
  id: string
  type: 'ingestion' | 'query'
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  knowledgeBaseId: string | null
  documentId: string | null
  requestId: string | null
  traceId: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  httpStatus: number | null
  summary: {
    resultStatus?: string
    counts?: Record<string, number>
    snapshotRevision?: string | null
    normalization?: { characters: number, warningCount: number }
    models?: { llm?: LogModel[], embedding?: LogModel | null, rerank?: LogModel | null }
  }
  error: { code: string, message: string, retryable: boolean } | null
}

export interface LogPage { items: OperationLog[], nextCursor: string | null }
