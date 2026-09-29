export interface RerankRequest {
  model: string
  query: string
  documents: readonly string[]
  topN: number
  signal?: AbortSignal
}

export interface RerankResponse {
  provider: string
  model: string
  results: { index: number, score: number }[]
  usage: { inputTokens: number, outputTokens: number } | null
  requestId?: string
}

export interface Reranker {
  rerank: (request: RerankRequest) => Promise<RerankResponse>
}
