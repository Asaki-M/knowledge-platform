import type { DualIndexEmbeddingResult } from '../indexing/types.js'
import type { SnapshotWriteOptions } from './types.js'
import { VECTOR_STORE_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { contentHash } from '../content-hash.js'
import { indexId, textRevision } from '../indexing/text.js'
import { validateDocuments } from '../indexing/validation.js'

export function assertVector(vector: readonly number[], dimensions: number): void {
  // pgvector 使用 float32；零向量无法计算余弦距离，不能作为有效搜索记录。
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > 16000
    || !Array.isArray(vector) || vector.length !== dimensions
    || !Array.from(vector).every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))
    || !vector.some(value => Math.fround(value) !== 0)) {
    throw new AppError(CODES.INVALID_INPUT, 'A non-zero finite vector with supported dimensions is required')
  }
}

/** 向量、文本指纹、身份和来源一起校验，不能让过期或错配向量进入数据库。 */
export function validateSnapshot(input: DualIndexEmbeddingResult, options: SnapshotWriteOptions): void {
  try {
    if (!input || input.schemaVersion !== 1 || !isNonEmptyString(input.knowledgeBaseId)
      || !isNonEmptyString(input.provider) || !isNonEmptyString(input.requestedModel)
      || !Array.isArray(input.chunks) || !Array.isArray(input.wikiNodes)
      || !options || (options.expectedRevision !== null && !isNonEmptyString(options.expectedRevision))) {
      throw new Error('Invalid snapshot')
    }
    const records = [...input.chunks, ...input.wikiNodes]
    if (records.length ? !isNonEmptyString(input.model) || input.dimensions === null : input.model !== null || input.dimensions !== null)
      throw new Error('Invalid vector space')
    validateDocuments({ schemaVersion: 1, templateVersion: 1, knowledgeBaseId: input.knowledgeBaseId, tokenizer: 'custom', maxTokens: Number.MAX_SAFE_INTEGER, chunks: input.chunks, wikiNodes: input.wikiNodes })
    for (const record of records) {
      assertVector(record.vector, input.dimensions!)
      if (record.id !== indexId(input.knowledgeBaseId, record.kind, record.sourceId)
        || record.textRevision !== textRevision(record.embeddingText)
        || record.embeddingRevision !== contentHash([record.textRevision, input.provider, input.requestedModel, input.model, input.dimensions])) {
        throw new Error('Invalid fingerprint')
      }
    }
  }
  catch {
    throw new AppError(CODES.INVALID_INPUT, 'A complete, valid dual-index snapshot and expected revision are required')
  }
}
