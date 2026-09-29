import process from 'node:process'
import { QUERY_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { DeepSeekAdapter, LlmClient } from '../../llm/index.js'
import { EmbeddingClient, GoogleEmbeddingAdapter, SiliconFlowEmbeddingAdapter } from '../../rag/embedding/index.js'
import { searchAndAnswer, validateQueryRequest } from '../../rag/query/index.js'
import { SiliconFlowReranker } from '../../rag/rerank/index.js'
import { PgVectorStore } from '../../rag/vector-store/index.js'
import { isRecord } from '../../utils/type-guards.js'

export async function search(body: unknown, signal?: AbortSignal) {
  if (!isRecord(body) || typeof body.knowledgeBaseId !== 'string' || typeof body.question !== 'string')
    throw new AppError(QUERY_ERROR_CODES.INVALID_INPUT, 'knowledgeBaseId and question are required')
  const request = { knowledgeBaseId: body.knowledgeBaseId.trim(), question: body.question.trim(), signal }
  validateQueryRequest(request)
  // 按请求惰性初始化，缺少模型凭据不影响 HTTP 启动及健康检查。
  const store = new PgVectorStore()
  try {
    const embedding = new EmbeddingClient()
    if (process.env.EMBEDDING_API_KEY)
      embedding.register(new SiliconFlowEmbeddingAdapter())
    if (process.env.GOOGLE_API_KEY)
      embedding.register(new GoogleEmbeddingAdapter())
    return await searchAndAnswer(request, {
      store,
      embedding,
      reranker: { rerank: input => new SiliconFlowReranker().rerank(input) },
      llm: new LlmClient([{ provider: 'deepseek', generate: input => new DeepSeekAdapter().generate(input) }]),
    }, {
      rerankModel: process.env.RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3',
      generation: { provider: 'deepseek', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash' },
    })
  }
  finally {
    await store.close()
  }
}
