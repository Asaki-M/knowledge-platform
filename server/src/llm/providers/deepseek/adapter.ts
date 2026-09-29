import type { LlmAdapter, LlmRequest, LlmResponse } from '../../types.js'
import process from 'node:process'
import OpenAI from 'openai'
import { LLM_ERROR_CODES } from '../../../error-codes.js'
import { AppError } from '../../../errors.js'
import { toDeepSeekRequest, toLlmResponse } from './mapping.js'
import { normalizeError } from './normalize-error.js'

/** DeepSeek 的连接配置；不混入通用生成输入，避免业务参数绑定具体供应商。 */
export interface DeepSeekAdapterOptions {
  /** 显式值优先，未传时读取 DEEPSEEK_API_KEY。 */
  apiKey?: string
  /** 显式值优先，其次读取 DEEPSEEK_BASE_URL；自定义地址需支持 Chat Completions API。 */
  baseURL?: string
  /** SDK 单次请求尝试的超时毫秒数，默认 60000；重试会增加总等待时间。 */
  timeoutMs?: number
  /** SDK 内置最大重试次数，默认 2，设为 0 可关闭自动重试。 */
  maxRetries?: number
}

/** 使用 OpenAI SDK 的 Chat Completions API 实现统一文本生成，不依赖 HTTP 路由或 RAG。 */
export class DeepSeekAdapter implements LlmAdapter {
  readonly provider = 'deepseek'
  private readonly client: OpenAI

  /** 构造时读取并校验配置；仅创建 SDK 客户端，不发起模型请求。 */
  constructor(options: DeepSeekAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY
    if (!apiKey?.trim())
      throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, 'DEEPSEEK_API_KEY is required', { provider: this.provider })
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
      throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, 'timeoutMs must be positive', { provider: this.provider })
    if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0))
      throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, 'maxRetries must be a non-negative integer', { provider: this.provider })
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      timeout: options.timeoutMs ?? 60000,
      maxRetries: options.maxRetries ?? 2,
    })
  }

  /** 适配器只编排 SDK 调用；字段映射与供应商异常转换留在各自文件中。 */
  async generate(request: LlmRequest): Promise<LlmResponse> {
    try {
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
