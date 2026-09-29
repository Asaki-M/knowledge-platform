import type { EmbeddingClient } from '../embedding/client.js'
import type { DualIndexEmbeddingOptions, DualIndexEmbeddingResult, EmbeddedIndexDocument, IndexBuildResult } from './types.js'
import { INDEXING_ERROR_CODES as CODES, EMBEDDING_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { contentHash } from '../content-hash.js'
import { validateDocuments } from './validation.js'

/** 两类索引共用一个向量空间；分批失败时整次抛错，不返回半套索引。 */
export async function embedDualIndex(input: IndexBuildResult, client: EmbeddingClient, options: DualIndexEmbeddingOptions): Promise<DualIndexEmbeddingResult> {
  const { provider, model, dimensions, signal, batchSize = 32 } = options
  if (!isNonEmptyString(provider) || !isNonEmptyString(model) || !Number.isSafeInteger(batchSize) || batchSize <= 0
    || (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions <= 0))) {
    throw new AppError(CODES.INVALID_OPTIONS, 'Embedding provider, model, batch size and dimensions must be valid')
  }
  validateDocuments(input)
  // 在首次 await 前保存全部文本和来源；调用方修改输入不能错配后续批次。
  const snapshot = structuredClone(input)
  const documents = [...snapshot.chunks, ...snapshot.wikiNodes]
  const records: EmbeddedIndexDocument[] = []
  const result: DualIndexEmbeddingResult = {
    schemaVersion: 1,
    knowledgeBaseId: snapshot.knowledgeBaseId,
    provider,
    requestedModel: model,
    model: null,
    dimensions: null,
    chunks: [],
    wikiNodes: [],
    usage: null,
    batches: [],
  }
  const checkCancelled = () => {
    if (signal?.aborted)
      throw new AppError(EMBEDDING_ERROR_CODES.ABORTED, 'Dual index embedding was cancelled', { provider })
  }
  checkCancelled()
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    checkCancelled()
    const batch = documents.slice(offset, offset + batchSize)
    const response = await client.embed({ provider, model, dimensions, signal, input: batch.map(item => item.embeddingText) })
    checkCancelled()
    if (result.model !== null && (response.model !== result.model || response.dimensions !== result.dimensions))
      throw new AppError(CODES.INCONSISTENT_SPACE, 'Embedding batches must use the same actual model and dimensions', { provider })
    result.model = response.model
    result.dimensions = response.dimensions
    result.batches.push({ documentIds: batch.map(item => item.id), requestId: response.requestId, usage: response.usage && { ...response.usage } })
    records.push(...batch.map((document, index) => ({
      ...document,
      vector: [...response.embeddings[index]!],
      embeddingRevision: contentHash([document.textRevision, provider, model, response.model, response.dimensions]),
    })))
  }
  result.chunks = records.filter(item => item.kind === 'chunk')
  result.wikiNodes = records.filter(item => item.kind === 'wiki')
  if (result.batches.length && result.batches.every(batch => batch.usage !== null)) {
    result.usage = result.batches.reduce((sum, batch) => ({ inputTokens: sum.inputTokens + batch.usage!.inputTokens, totalTokens: sum.totalTokens + batch.usage!.totalTokens }), { inputTokens: 0, totalTokens: 0 })
  }
  return result
}
