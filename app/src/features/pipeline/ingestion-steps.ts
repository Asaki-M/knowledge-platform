export const ingestionSteps = [
  {
    name: '文档标准化',
    code: 'NORMALIZE',
    description: '解析 Markdown / MDX，统一内容结构。',
  },
  {
    name: '按标题分节',
    code: 'SECTION SPLIT',
    description: '按 H1–H3 分节，保留事实原文、来源和版本。',
  },
  {
    name: '知识提取',
    code: 'ENRICHMENT',
    description: '规则提取结构，模型补充带证据的实体、概念、关系与事实。',
  },
  {
    name: 'Wiki 化与节点构建',
    code: 'WIKI NODE',
    description: '语义分支：显式归并跨节实体与概念，逐条关联原文证据。',
  },
  {
    name: 'Chunk 构建',
    code: 'CHUNK BUILD',
    description: '检索分支：独立切分 Section，关联所属章节和前后片段。',
  },
  {
    name: '向量化',
    code: 'EMBEDDING',
    description: '组合 Chunk 原文与关联知识、Wiki 语义文本，生成同一向量空间的双索引。',
  },
  {
    name: '向量存储',
    code: 'VECTOR STORE',
    description: '以事务写入向量、文本与来源；替换当前文档旧索引，保留其他文档。',
  },
]
