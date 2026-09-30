import type OpenAI from 'openai'
import type { LlmAdapter, LlmRequest, LlmResponse } from '../../types.js'
import type { OpenAISdkOptions } from '../openai-sdk.js'
import process from 'node:process'
import { createOpenAISdk } from '../openai-sdk.js'
import { toLlmResponse, toOpenAIRequest } from './mapping.js'
import { normalizeError } from './normalize-error.js'

/** 显式连接参数优先，未传时使用 OPENAI_API_KEY / OPENAI_BASE_URL。 */
export type OpenAIAdapterOptions = OpenAISdkOptions

/** 使用官方 SDK 的 Responses API 实现统一文本生成，不依赖 HTTP 路由或 RAG。 */
export class OpenAIAdapter implements LlmAdapter {
  readonly provider = 'openai'
  private readonly client: OpenAI

  /** 构造时读取并校验配置；仅创建 SDK 客户端，不发起模型请求。 */
  constructor(options: OpenAIAdapterOptions = {}) {
    this.client = createOpenAISdk(options, {
      provider: this.provider,
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      apiKeyName: 'OPENAI_API_KEY',
    })
  }

  /** 适配器只编排 SDK 调用；字段映射与供应商异常转换留在各自文件中。 */
  async generate(request: LlmRequest): Promise<LlmResponse> {
    try {
      const response = await this.client.responses.create(
        toOpenAIRequest(request),
        { signal: request.signal },
      )
      return toLlmResponse(response)
    }
    catch (error) {
      throw normalizeError(error)
    }
  }
}
