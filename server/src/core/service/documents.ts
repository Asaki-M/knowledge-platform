import type { OperationTracker } from './operation-logs.js'
import { HTTP_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { ingestDocument } from '../../rag/ingestion/index.js'
import { PgVectorStore } from '../../rag/vector-store/index.js'
import { isNonEmptyString, isRecord } from '../../utils/type-guards.js'
import { createEmbeddingClient, createLlmClient, ingestionEmbeddingOptions, ingestionLlmOptions } from './model-options.js'
import { summarizeIngestion } from './operation-logs.js'

export async function ingest(body: unknown, signal?: AbortSignal, operation?: OperationTracker) {
  await operation?.setScope(body)
  if (!isRecord(body) || !isNonEmptyString(body.knowledgeBaseId) || !isRecord(body.document)
    || !isNonEmptyString(body.document.id) || !isNonEmptyString(body.document.content)
    || body.knowledgeBaseId.length > 256 || body.document.id.length > 256 || body.document.content.length > 200000
    || (body.document.sourcePath !== undefined && (!isNonEmptyString(body.document.sourcePath) || body.document.sourcePath.length > 2048))
    || (body.document.format !== undefined && body.document.format !== 'nextra-mdx')) {
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '需要 knowledgeBaseId 和 document（id、content）；支持 nextra-mdx，正文最多 200000 字符。')
  }
  const request = { knowledgeBaseId: body.knowledgeBaseId.trim(), documentId: body.document.id.trim(), content: body.document.content, ...(body.document.sourcePath === undefined ? {} : { sourcePath: body.document.sourcePath as string }), signal }
  const options = { llm: ingestionLlmOptions(body.llm), embedding: ingestionEmbeddingOptions(body.embedding) }
  operation?.setSummary({ models: { llm: [{ provider: options.llm.provider, model: options.llm.model }], embedding: options.embedding } })
  const store = new PgVectorStore()
  try {
    // 首次实际入库时幂等建表；健康检查、导入模块和启动服务不访问数据库。
    await store.initialize()
    const result = await ingestDocument(request, { store, llm: createLlmClient('enrichment'), embedding: createEmbeddingClient() }, options)
    operation?.setSummary(summarizeIngestion(result))
    return result
  }
  finally {
    await store.close()
  }
}
