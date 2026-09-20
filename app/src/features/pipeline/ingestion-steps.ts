export const ingestionSteps = [
  {
    name: '文档标准化',
    code: 'NORMALIZE',
    description: '解析 Markdown / MDX，统一内容结构。',
  },
  {
    name: 'Wiki 化与节点构建',
    code: 'WIKI NODE',
    description: '提取主题与概念，建立节点及关联。',
  },
  {
    name: '内容切分',
    code: 'SPLIT',
    description: '将结构化内容拆分为可检索的片段。',
  },
  {
    name: '向量化',
    code: 'EMBEDDING',
    description: '为内容片段生成语义向量。',
  },
  {
    name: '向量存储',
    code: 'VECTOR STORE',
    description: '保存向量、文本及 Wiki 节点关联。',
  },
]
