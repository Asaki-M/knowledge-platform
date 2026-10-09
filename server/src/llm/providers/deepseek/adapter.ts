import type OpenAI from 'openai'
import type { LlmAdapter, LlmRequest, LlmResponse } from '../../types.js'
import type { OpenAISdkOptions } from '../openai-sdk.js'
import process from 'node:process'
import { normalizeResponsesOutput } from '../openai-sdk-response.js'
import { createOpenAISdk } from '../openai-sdk.js'
import { toDeepSeekRequest, toDeepSeekStructuredRequest, toLlmResponse } from './mapping.js'
import { normalizeError } from './normalize-error.js'

/** 显式连接参数优先，未传时使用 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL。 */
export type DeepSeekAdapterOptions = OpenAISdkOptions

/** 使用 OpenAI SDK；普通文本走 Chat Completions，Schema 约束走 Responses，不依赖 HTTP 路由或 RAG。 */
export class DeepSeekAdapter implements LlmAdapter {
  readonly provider = 'deepseek'
  private readonly client: OpenAI

  /** 构造时读取并校验配置；仅创建 SDK 客户端，不发起模型请求。 */
  constructor(options: DeepSeekAdapterOptions = {}) {
    this.client = createOpenAISdk(options, {
      provider: this.provider,
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKeyName: 'DEEPSEEK_API_KEY',
    })
  }

  /** 适配器只编排 SDK 调用；字段映射与供应商异常转换留在各自文件中。 */
  async generate(request: LlmRequest): Promise<LlmResponse> {
    try {
      if (request.structuredOutput) {
        const response = await this.client.responses.create(toDeepSeekStructuredRequest(request), { signal: request.signal })
        return normalizeResponsesOutput(response, this.provider)
      }
      const response = await this.client.chat.completions.create(
        toDeepSeekRequest(request),
        { signal: request.signal },
      )
      return toLlmResponse(response)
    }
    catch (error) {
      throw normalizeError(error)
    }
  }
}
