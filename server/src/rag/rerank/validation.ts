import type { RerankResponse } from './types.js'
import { RERANK_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'

export function validateRanking(results: RerankResponse['results'], count: number, topN: number): void {
  if (!Array.isArray(results) || results.length !== Math.min(count, topN)
    || results.some(item => !item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= count || !Number.isFinite(item.score))
    || new Set(results.map(item => item.index)).size !== results.length) {
    throw new AppError(CODES.INVALID_RESPONSE, 'Rerank must return unique, in-range indices with finite scores and the requested count')
  }
}
