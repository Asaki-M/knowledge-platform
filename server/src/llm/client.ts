import type { LlmAdapter, LlmGenerateRequest, LlmResponse } from './types.js'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { LLM_ERROR_CODES } from '../error-codes.js'
import { AppError } from '../errors.js'
import { log } from '../telemetry/logger.js'
import { isNonEmptyString } from '../utils/type-guards.js'

const tracer = trace.getTracer('knowledge-server.llm')

/** 只校验通用输入约束；模型是否支持某个参数仍由具体适配器或上游判断。 */
function validateRequest(request: LlmGenerateRequest) {
  const invalid = (message: string) => new AppError(LLM_ERROR_CODES.INVALID_REQUEST, message, { provider: request.provider })
  if (!isNonEmptyString(request.model))
    throw invalid('A model is required')
  if (!Array.isArray(request.messages) || request.messages.length === 0)
    throw invalid('At least one message is required')
  for (const message of request.messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
      throw invalid('Messages must have a supported role and text content')
  }
  if (request.maxOutputTokens !== undefined && (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0))
    throw invalid('maxOutputTokens must be a positive integer')
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2))
    throw invalid('temperature must be between 0 and 2')
}

/** 业务层统一入口，负责适配器注册、请求分发、公共校验和调用追踪。 */
export class LlmClient {
  private readonly adapters = new Map<string, LlmAdapter>()

  /** 注册已有适配器实例，不在这里读取供应商配置或发起网络请求。 */
  constructor(adapters: readonly LlmAdapter[] = []) {
    for (const adapter of adapters)
      this.register(adapter)
  }

  /** 按供应商唯一标识注册；拒绝静默覆盖，避免已有调用被切换到另一实现。 */
  register(adapter: LlmAdapter): this {
    if (!adapter.provider.trim() || this.adapters.has(adapter.provider))
      throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, 'Adapter provider must be non-empty and unique', { provider: adapter.provider })
    this.adapters.set(adapter.provider, adapter)
    return this
  }

  /** 执行一次非流式生成；此层不额外重试，避免与 SDK 内置重试叠加。 */
  async generate(request: LlmGenerateRequest): Promise<LlmResponse> {
    validateRequest(request)
    // provider 只用于客户端路由，适配器收到的是与供应商无关的生成参数。
    const { provider, ...input } = request
    const adapter = this.adapters.get(provider)
    if (!adapter)
      throw new AppError(LLM_ERROR_CODES.PROVIDER_NOT_FOUND, 'No adapter is registered for this provider', { provider })
    // 请求已取消时直接失败，不再产生新的上游调用。
    if (input.signal?.aborted)
      throw new AppError(LLM_ERROR_CODES.ABORTED, 'LLM request was cancelled', { provider })

    // 沿用当前异步上下文；在 HTTP 请求内调用时，会成为请求 span 的子节点。
    return tracer.startActiveSpan('llm.generate', async (span) => {
      const startedAt = performance.now()
      span.setAttributes({ 'llm.provider': provider, 'llm.request.model': input.model })
      try {
        const response = await adapter.generate(input)
        // 仅记录调用元数据，不把输入消息、输出文本或凭据放进日志与 span。
        const attributes = {
          'llm.provider': provider,
          'llm.response.model': response.model,
          'llm.finish_reason': response.finishReason,
          'llm.request_id': response.requestId,
          'llm.input_tokens': response.usage?.inputTokens,
          'llm.output_tokens': response.usage?.outputTokens,
          'llm.duration_ms': performance.now() - startedAt,
        }
        span.setAttributes(attributes)
        log.info('llm.generate.completed', attributes)
        return response
      }
      catch (error) {
        // 保留适配器已归一化的错误；未知异常用通用错误兜底，避免泄露 SDK 原始内容。
        const normalized = error instanceof AppError
          ? error
          : new AppError(LLM_ERROR_CODES.PROVIDER_ERROR, 'LLM provider request failed', { provider })
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.code })
        span.setAttribute('llm.error.code', normalized.code)
        log.error('llm.generate.failed', {
          'llm.provider': provider,
          'llm.error.code': normalized.code,
          'llm.request_id': normalized.requestId,
          'llm.duration_ms': performance.now() - startedAt,
        })
        throw normalized
      }
      finally {
        // 成功、失败和取消都必须结束 span，避免产生未闭合的调用记录。
        span.end()
      }
    })
  }
}
