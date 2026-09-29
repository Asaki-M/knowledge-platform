/** 显式初始化时执行；所有对象使用固定名称，不拼接外部标识符。 */
export const schemaSql = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS rag_vector_snapshots (
  knowledge_base_id text PRIMARY KEY,
  revision text NOT NULL,
  provider text NOT NULL,
  requested_model text NOT NULL,
  model text,
  dimensions integer CHECK (dimensions > 0 AND dimensions <= 16000),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  wiki_count integer NOT NULL CHECK (wiki_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((model IS NULL) = (dimensions IS NULL)),
  CHECK (model IS NOT NULL OR chunk_count + wiki_count = 0)
);
CREATE TABLE IF NOT EXISTS rag_vectors (
  knowledge_base_id text NOT NULL REFERENCES rag_vector_snapshots(knowledge_base_id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('chunk', 'wiki')),
  metadata jsonb NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (knowledge_base_id, id),
  CHECK (metadata->>'id' = id AND metadata->>'kind' = kind AND metadata->>'knowledgeBaseId' = knowledge_base_id)
);
CREATE INDEX IF NOT EXISTS rag_vectors_scope_idx ON rag_vectors (knowledge_base_id, kind);
`
