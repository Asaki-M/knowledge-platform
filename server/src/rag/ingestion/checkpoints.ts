/** 断点由调用方持久化，独立 RAG 能力不依赖 HTTP 或具体数据库。 */
export interface IngestionCheckpointStore {
  load: <T>(key: string) => Promise<T | undefined>
  save: (key: string, value: unknown) => Promise<void>
}
