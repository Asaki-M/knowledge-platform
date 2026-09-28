import type { EmbeddingAdapter, EmbeddingRequest, EmbeddingResponse } from '../../types.js'
import process from 'node:process'
import { GoogleGenAI } from '@google/genai'
import { EMBEDDING_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { isNonEmptyString } from '../../../../utils/type-guards.js'
import { toEmbeddingResponse } from './mapping.js'
import { normalizeError } from './normalize-error.js'

export interface GoogleEmbeddingAdapterOptions {
  /** 未指定时使用 GOOGLE_API_KEY。 */
  apiKey?: string
  /** 可选自定义服务根地址，不含 /v1beta；默认使用 Google 官方地址。 */
  baseURL?: string
  /** 默认 60000 毫秒；本适配器和 SDK 均不自动重试。 */
  timeoutMs?: number
}

export class GoogleEmbeddingAdapter implements EmbeddingAdapter {
  readonly provider = 'google'
  private readonly client: GoogleGenAI
  private readonly timeoutMs: number

  constructor(options: GoogleEmbeddingAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY
    const timeoutMs = options.timeoutMs ?? 60000
    if (!isNonEmptyString(apiKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Google API key and a positive timeout are required', { provider: this.provider })
    this.timeoutMs = timeoutMs
    this.client = new GoogleGenAI({
      apiKey,
      // 明确使用 Gemini Developer API，避免环境变量意外切换到 Vertex AI。
      vertexai: false,
      httpOptions: { baseUrl: options.baseURL, apiVersion: 'v1beta', retryOptions: { attempts: 1 } },
    })
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (request.input.length > 100)
      throw new AppError(CODES.INVALID_REQUEST, 'Google supports at most 100 texts per call', { provider: this.provider })
    // 分别保留超时与调用方取消的信号，防止 SDK 把两种情况都归为普通网络错误。
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
    try {
      const response = await this.client.models.embedContent({
        model: request.model,
        // Embedding 2 会合并裸字符串列表；独立 Content 确保每条文本返回一个向量。
        contents: request.input.map(text => ({ parts: [{ text }] })),
        config: { outputDimensionality: request.dimensions, abortSignal: signal },
      })
      if (signal.aborted)
        throw signal.reason
      return toEmbeddingResponse(response, request.model)
    }
    catch (error) {
      throw normalizeError(error, request.signal?.aborted ?? false, timeout.aborted)
    }
  }
}
