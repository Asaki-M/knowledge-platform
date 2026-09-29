import type { LlmClient, LlmResponse } from '../../llm/index.js'
import type { EmbeddingClient, EmbeddingResponse } from '../embedding/index.js'
import type { AnswerGenerationOptions, AnswerSource } from '../generation/index.js'
import type { Reranker, RerankResponse } from '../rerank/index.js'
import type { VectorQueryStore } from '../vector-store/index.js'
import { QUERY_ERROR_CODES as CODES, VECTOR_STORE_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { generateAnswer } from '../generation/index.js'
import { validateRanking } from '../rerank/index.js'
import { mergeSearchResults } from '../retrieval/index.js'

export interface QueryRequest {
  knowledgeBaseId: string
  question: string
  signal?: AbortSignal
}

export interface QueryResult {
  status: 'answered' | 'no_results'
  answer: string
  sources: AnswerSource[]
  snapshotRevision: string | null
  counts: { chunks: number, wikiNodes: number, merged: number, duplicates: number, selected: number }
  embedding: Omit<EmbeddingResponse, 'embeddings'> | null
  rerank: RerankResponse | null
  generation: Omit<LlmResponse, 'text'> | null
}

export function validateQueryRequest(request: QueryRequest): void {
  if (!isNonEmptyString(request.knowledgeBaseId) || request.knowledgeBaseId.length > 256 || !isNonEmptyString(request.question) || request.question.length > 4000)
    throw new AppError(CODES.INVALID_INPUT, 'knowledgeBaseId and a question of at most 4000 characters are required')
}

/** 双路各取 30，合并后由独立重排模型选 5 条，再交给 LLM；失败不降级成伪答案。 */
export async function searchAndAnswer(request: QueryRequest, dependencies: { store: VectorQueryStore, embedding: EmbeddingClient, reranker: Reranker, llm: LlmClient }, options: { rerankModel: string, generation: AnswerGenerationOptions, embeddingDimensions?: number, embedding?: { provider: string, model?: string, dimensions?: number } }): Promise<QueryResult> {
  validateQueryRequest(request)
  const { knowledgeBaseId, question, signal } = request
  const { store, embedding, reranker, llm } = dependencies
  const checkCancelled = () => {
    if (signal?.aborted)
      throw new AppError(CODES.ABORTED, 'Query was cancelled')
  }
  checkCancelled()
  const snapshot = await store.getSnapshot(knowledgeBaseId)
  checkCancelled()
  const result: QueryResult = { status: 'no_results', answer: '当前知识库没有可检索的资料。', sources: [], snapshotRevision: snapshot?.revision ?? null, counts: { chunks: 0, wikiNodes: 0, merged: 0, duplicates: 0, selected: 0 }, embedding: null, rerank: null, generation: null }
  if (!snapshot || snapshot.chunks + snapshot.wikiNodes === 0)
    return result
  const choice = options.embedding
  if (choice && (choice.provider !== snapshot.provider || (choice.model !== undefined && choice.model !== snapshot.requestedModel) || (choice.dimensions !== undefined && choice.dimensions !== snapshot.dimensions)))
    throw new AppError(VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE, 'Embedding 选择必须与知识库入库时的供应商、模型和维度一致。')
  // 支持自定义维度的供应商沿用库内维度，避免 Google 默认维度与已写入向量不同。
  const dimensions = snapshot.provider === 'google' || snapshot.requestedModel.startsWith('Qwen/Qwen3-')
    ? choice?.dimensions ?? options.embeddingDimensions ?? snapshot.dimensions ?? undefined
    : undefined
  const encoded = await embedding.embed({ provider: snapshot.provider, model: snapshot.requestedModel, input: [question], ...(dimensions === undefined ? {} : { dimensions }), signal })
  checkCancelled()
  if (encoded.model !== snapshot.model || encoded.dimensions !== snapshot.dimensions)
    throw new AppError(VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE, 'Query embedding does not match the stored vector space')
  const { embeddings, ...embeddingInfo } = encoded
  result.embedding = embeddingInfo
  const hits = await store.searchDual({ knowledgeBaseId, provider: encoded.provider, model: encoded.model, vector: embeddings[0]!, expectedRevision: snapshot.revision, limit: 30, signal })
  checkCancelled()
  if (hits.snapshotRevision !== snapshot.revision)
    throw new AppError(VECTOR_STORE_ERROR_CODES.CONFLICT, 'Search snapshot changed')
  const candidates = mergeSearchResults(hits, knowledgeBaseId)
  result.counts = { chunks: hits.chunks.length, wikiNodes: hits.wikiNodes.length, merged: candidates.length, duplicates: hits.chunks.length + hits.wikiNodes.length - candidates.length, selected: 0 }
  if (!candidates.length)
    return result
  const ranking = await reranker.rerank({ model: options.rerankModel, query: question, documents: candidates.map(candidate => candidate.text), topN: Math.min(5, candidates.length), signal })
  checkCancelled()
  validateRanking(ranking.results, candidates.length, 5)
  const selected = [...ranking.results].sort((a, b) => b.score - a.score || a.index - b.index)
  result.rerank = { ...ranking, results: selected }
  result.sources = selected.map((item, index) => ({ ...candidates[item.index]!, label: `S${index + 1}`, rerankScore: item.score }))
  result.counts.selected = result.sources.length
  const { text, ...generationInfo } = await generateAnswer(question, result.sources, llm, options.generation, signal)
  checkCancelled()
  return { ...result, status: 'answered', answer: text, generation: generationInfo }
}
