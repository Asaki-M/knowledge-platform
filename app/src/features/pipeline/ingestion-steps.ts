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
    description: '为内容片段生成语义向量。',
  },
  {
    name: '向量存储',
    code: 'VECTOR STORE',
    description: '计划保存向量、文本及所属 Section，尚未接入存储。',
  },
]
