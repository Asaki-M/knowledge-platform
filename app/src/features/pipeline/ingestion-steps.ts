import type { IngestionStageId } from './types'

export const ingestionSteps: { id: IngestionStageId, name: string, code: string, description: string }[] = [
  { id: 'normalize', name: '文档标准化', code: 'NORMALIZE', description: '解析 Markdown / MDX，转换为标准 Markdown，保留警告。' },
  { id: 'sections', name: '按标题分节', code: 'SECTION SPLIT', description: '按 H1–H3 划分章节，保留标题层级和事实原文。' },
  { id: 'chunks', name: 'Chunk 构建', code: 'CHUNK BUILD', description: '按预算切分原文片段，保留代码、表格和章节关联。' },
  { id: 'enrichment', name: '知识提取', code: 'ENRICHMENT', description: '逐节生成摘要、实体、概念、事实与关系，保留原文证据。' },
  { id: 'wiki', name: 'Wiki 节点构建', code: 'WIKI NODE', description: '将实体与概念组织为知识节点，关联事实和语义关系。' },
  { id: 'indexing', name: '双索引文本', code: 'INDEX TEXT', description: '构造原文与 Wiki 的检索文本，检查完整文本预算。' },
  { id: 'embedding', name: '向量化', code: 'EMBEDDING', description: '生成同一向量空间的双索引，确认模型、维度与批次。' },
  { id: 'storage', name: '事务入库', code: 'VECTOR STORE', description: '原子替换当前文档的旧索引，保留知识库内其他文档。' },
]
