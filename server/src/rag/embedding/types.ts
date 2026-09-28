/** 仅接收已准备好的文本，不在此阶段拼接 chunk、标题或检索指令。 */
export interface EmbeddingRequest {
  /** 显式传入模型 ID；环境变量由调用方读取，不隐式切换模型。 */
  model: string
  /** 单条文本也使用数组；每条输入对应一个输出向量。 */
  input: readonly string[]
  /** 省略时使用模型默认维度；不支持降维的模型会明确失败。 */
  dimensions?: number
  signal?: AbortSignal
}

export interface EmbeddingUsage {
  inputTokens: number
  totalTokens: number
}

export interface EmbeddingResponse {
  provider: string
  /** 优先使用上游返回值；Google 不返回模型名时保留请求模型。 */
  model: string
  /** 顺序与 input 一致，所有向量维度相同，元素均为有限数。 */
  embeddings: number[][]
  dimensions: number
  /** 未报告用量时为 null，不估算或伪造为零。 */
  usage: EmbeddingUsage | null
  requestId?: string
}

/** 各供应商负责 SDK 请求、输出映射和错误转换；公共校验与追踪留在客户端。 */
export interface EmbeddingAdapter {
  readonly provider: string
  embed: (request: EmbeddingRequest) => Promise<EmbeddingResponse>
}

export interface EmbedRequest extends EmbeddingRequest {
  provider: string
}
