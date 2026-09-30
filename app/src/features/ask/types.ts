export interface AnswerSource {
  id: string
  title: string
  text: string
  label: string
  rerankScore: number
  matches: {
    indexId: string
    kind: 'chunk' | 'wiki'
    vectorScore: number
    sources: { documentId: string, sectionId: string, sourcePath: string | null }[]
  }[]
}

export interface QueryResult {
  status: 'answered' | 'no_results'
  answer: string
  sources: AnswerSource[]
  snapshotRevision: string | null
  counts: { chunks: number, wikiNodes: number, merged: number, duplicates: number, selected: number }
  generation: { provider: string, model: string } | null
}
