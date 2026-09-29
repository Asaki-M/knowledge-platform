/** 通用文本消息；调用方负责按对话顺序传入完整历史，不携带 SDK 专属字段。 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 与供应商无关的非流式生成输入，适配器不在请求之间维护会话状态。 */
export interface LlmRequest {
  /** 显式指定模型 ID；客户端不会自动读取供应商的模型环境变量作为默认值。 */
  model: string
  messages: readonly LlmMessage[]
  /** 输出 Token 上限；具体计费及是否包含推理 Token 由目标模型决定。 */
  maxOutputTokens?: number
  /** 可选采样温度；未传时使用供应商默认行为，是否支持由目标模型决定。 */
  temperature?: number
  /** 将调用方的取消意图传递到 SDK，避免请求取消后继续等待上游结果。 */
  signal?: AbortSignal
}

/** 供应商实际报告的 Token 用量，不在本地估算或补齐。 */
export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** 正常结束、达到长度上限、内容过滤、拒答，或无法映射的结束原因。 */
export type LlmFinishReason = 'stop' | 'length' | 'content_filter' | 'refusal' | 'unknown'

/** 所有适配器返回同一结构，业务层不需要解析各家 SDK 的原始响应。 */
export interface LlmResponse {
  /** 模型响应 ID，与定位网络请求的 requestId 区分。 */
  id: string
  provider: string
  /** 上游实际返回的模型标识，可能与请求中的模型别名不同。 */
  model: string
  /** 可能是部分文本或空字符串，使用前应结合 finishReason 判断。 */
  text: string
  finishReason: LlmFinishReason
  /** null 表示上游未报告用量，不代表消耗为零。 */
  usage: LlmUsage | null
  /** 供应商请求 ID，用于日志关联和问题排查；部分供应商可能不提供。 */
  requestId?: string
  /** 拒答信息单独保留，不混入正常生成文本。 */
  refusal?: string
}

/**
 * 新 SDK 的接入契约：完成输入映射、输出归一化，并将失败转换为 AppError。
 * 通用参数校验和追踪由 LlmClient 承担，业务层应通过客户端发起调用。
 */
export interface LlmAdapter {
  /** 注册与路由使用的唯一标识，同一客户端内不能重复。 */
  readonly provider: string
  generate: (request: LlmRequest) => Promise<LlmResponse>
}

/** 业务层调用输入；provider 用于选择适配器，其余字段传入对应适配器。 */
export interface LlmGenerateRequest extends LlmRequest {
  provider: string
}
