export interface IngestionResult {
  ingestionId?: string
  status: 'stored'
  knowledgeBaseId: string
  documentId: string
  normalization: { title: string | null, characters: number, warnings: { message: string }[] }
  counts: { sections: number, chunks: number, wikiNodes: number, wikiEdges: number, vectors: number }
  embedding: { provider: string, model: string | null, dimensions: number | null }
  stored: { revision: string, chunks: number, wikiNodes: number }
}

export type IngestionStageId = 'normalize' | 'sections' | 'chunks' | 'enrichment' | 'wiki' | 'indexing' | 'embedding' | 'storage'

export interface IngestionStage {
  id: IngestionStageId
  status: 'running' | 'completed' | 'failed'
  durationMs: number
  reused?: boolean
  progress?: { completed: number, total: number }
  preview?: {
    metrics: { label: string, value: string | number }[]
    items: { id: string, title: string, text: string, truncated: boolean }[]
    totalItems: number
  }
}

export type IngestionEvent
  = | { type: 'start', requestId: string, ingestionId?: string }
    | { type: 'stage', stage: IngestionStage }
    | { type: 'result', result: IngestionResult }
    | { type: 'error', error: { code: string, message: string }, requestId: string }
    | { type: 'ping' }

export interface IngestionTask {
  ingestionId: string
  status: 'running' | 'interrupted' | 'failed' | 'succeeded'
  requestId: string | null
  stages: IngestionStage[]
  result: IngestionResult | null
  error: { code: string, message: string } | null
  knowledgeBaseId: string
  documentId: string
}
