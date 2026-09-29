import process from 'node:process'
import { QUERY_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { searchAndAnswer, validateQueryRequest } from '../../rag/query/index.js'
import { SiliconFlowReranker } from '../../rag/rerank/index.js'
import { PgVectorStore } from '../../rag/vector-store/index.js'
import { isRecord } from '../../utils/type-guards.js'
import { createEmbeddingClient, createLlmClient, embeddingSelection, llmOptions } from './model-options.js'

export async function search(body: unknown, signal?: AbortSignal) {
  if (!isRecord(body) || typeof body.knowledgeBaseId !== 'string' || typeof body.question !== 'string')
    throw new AppError(QUERY_ERROR_CODES.INVALID_INPUT, 'knowledgeBaseId and question are required')
  const request = { knowledgeBaseId: body.knowledgeBaseId.trim(), question: body.question.trim(), signal }
  validateQueryRequest(request)
  const generation = llmOptions(body.llm)
  const selectedEmbedding = embeddingSelection(body.embedding)
  // 按请求惰性初始化，缺少模型凭据不影响 HTTP 启动及健康检查。
  const store = new PgVectorStore()
  try {
    return await searchAndAnswer(request, {
      store,
      embedding: createEmbeddingClient(),
      reranker: { rerank: input => new SiliconFlowReranker().rerank(input) },
      llm: createLlmClient(),
    }, {
      rerankModel: process.env.RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3',
      generation,
      embedding: selectedEmbedding,
    })
  }
  finally {
    await store.close()
  }
}
