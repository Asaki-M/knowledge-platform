import type { IndexSource } from '../indexing/types.js'
import type { DualVectorSearchResult } from '../vector-store/index.js'
import { QUERY_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'

export interface SearchCandidate {
  id: string
  title: string
  text: string
  matches: { indexId: string, kind: 'chunk' | 'wiki', sourceId: string, vectorScore: number, sources: IndexSource[] }[]
}

/** 仅合并同 ID 或逐字相同的文本；同节的不同 Chunk 和 Wiki 知识仍独立参与重排。 */
export function mergeSearchResults(result: DualVectorSearchResult, knowledgeBaseId: string): SearchCandidate[] {
  const byId = new Map<string, SearchCandidate>()
  const byText = new Map<string, SearchCandidate>()
  for (const [kind, hits] of [['chunk', result.chunks], ['wiki', result.wikiNodes]] as const) {
    if (hits.length > 30)
      throw new AppError(CODES.INVALID_RESULTS, 'Search route returned more than 30 candidates')
    for (const { document, score } of hits) {
      if (document.knowledgeBaseId !== knowledgeBaseId || document.kind !== kind || !isNonEmptyString(document.id) || !isNonEmptyString(document.embeddingText) || !Number.isFinite(score))
        throw new AppError(CODES.INVALID_RESULTS, 'Invalid search candidate')
      const previous = byId.get(document.id)
      if (previous && previous.text !== document.embeddingText)
        throw new AppError(CODES.INVALID_RESULTS, 'Conflicting content for the same index record')
      const candidate = previous ?? byText.get(document.embeddingText) ?? { id: document.id, title: document.title, text: document.embeddingText, matches: [] }
      if (!candidate.matches.some(match => match.indexId === document.id))
        candidate.matches.push({ indexId: document.id, kind, sourceId: document.sourceId, vectorScore: score, sources: document.sources })
      byId.set(document.id, candidate)
      byText.set(document.embeddingText, candidate)
    }
  }
  return [...byText.values()]
}
