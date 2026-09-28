import type { EmbeddingAdapter, EmbeddingRequest, EmbeddingResponse } from '../../types.js'
import process from 'node:process'
import OpenAI from 'openai'
import { EMBEDDING_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { isNonEmptyString } from '../../../../utils/type-guards.js'
import { toEmbeddingResponse } from './mapping.js'
import { normalizeError } from './normalize-error.js'

export interface SiliconFlowEmbeddingAdapterOptions {
  /** 未指定时使用现有 EMBEDDING_API_KEY 配置。 */
  apiKey?: string
  /** 未指定时读取 EMBEDDING_BASE_URL，默认 https://api.siliconflow.cn/v1。 */
  baseURL?: string
  /** 默认 60000 毫秒；本适配器和 SDK 均不自动重试。 */
  timeoutMs?: number
}

/** SiliconFlow 的 OpenAI 兼容 Embeddings 接口，不依赖 llm 的文本生成适配器。 */
export class SiliconFlowEmbeddingAdapter implements EmbeddingAdapter {
  readonly provider = 'siliconflow'
  private readonly client: OpenAI

  constructor(options: SiliconFlowEmbeddingAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY
    const timeoutMs = options.timeoutMs ?? 60000
    if (!isNonEmptyString(apiKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Embedding API key and a positive timeout are required', { provider: this.provider })
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL ?? process.env.EMBEDDING_BASE_URL ?? 'https://api.siliconflow.cn/v1',
      timeout: timeoutMs,
      maxRetries: 0,
    })
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    // 使用保守的同步批量上限；不隐式分批，避免部分成功后返回不完整结果。
    if (request.input.length > 32)
      throw new AppError(CODES.INVALID_REQUEST, 'SiliconFlow supports at most 32 texts per call', { provider: this.provider })
    if (request.dimensions !== undefined && !request.model.startsWith('Qwen/Qwen3-'))
      throw new AppError(CODES.INVALID_REQUEST, 'This SiliconFlow model does not support custom dimensions', { provider: this.provider })
    try {
      const { data, response } = await this.client.embeddings.create({
        model: request.model,
        input: [...request.input],
        // 显式请求数值数组，避免 SDK 默认使用 base64 编码返回值。
        encoding_format: 'float',
        ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
      }, { signal: request.signal }).withResponse()
      const requestId = response.headers.get('x-siliconcloud-trace-id') ?? response.headers.get('x-request-id') ?? undefined
      return toEmbeddingResponse(data, request.input.length, requestId)
    }
    catch (error) {
      throw normalizeError(error)
    }
  }
}
