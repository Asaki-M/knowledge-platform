export interface IngestionResult {
  status: 'stored'
  knowledgeBaseId: string
  documentId: string
  normalization: { title: string | null, characters: number, warnings: { message: string }[] }
  counts: { sections: number, chunks: number, wikiNodes: number, wikiEdges: number, vectors: number }
  embedding: { provider: string, model: string | null, dimensions: number | null }
  stored: { revision: string, chunks: number, wikiNodes: number }
}
