import type { LlmAdapter, LlmGenerateRequest, LlmResponse } from './types.js'
import { LLM_ERROR_CODES } from '../error-codes.js'
import { AppError } from '../errors.js'
import { traceOperation } from '../telemetry/operation.js'
import { isNonEmptyString, isRecord } from '../utils/type-guards.js'

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
  if (request.structuredOutput !== undefined) {
    const output = request.structuredOutput
    if (!isRecord(output) || typeof output.name !== 'string' || !/^[\w-]{1,64}$/.test(output.name)
      || !isRecord(output.schema) || output.schema.type !== 'object') {
      throw invalid('structuredOutput requires a name and an object JSON Schema')
    }
    // 拒绝循环、非有限数字及无法通过 JSON 保留的值，避免 SDK 静默改变契约。
    try {
      JSON.stringify(output.schema, (_key, value: unknown) => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean'
          || (typeof value === 'number' && Number.isFinite(value)) || Array.isArray(value) || isRecord(value)) {
          return value
        }
        throw new Error('Non-JSON schema value')
      })
    }
    catch {
      throw invalid('structuredOutput schema must contain serializable JSON values')
    }
  }
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

    return traceOperation({
      namespace: 'llm',
      name: 'llm.generate',
      event: 'llm.generate',
      attributes: { 'llm.provider': provider, 'llm.request.model': input.model },
      normalizeError: error => error instanceof AppError ? error : new AppError(LLM_ERROR_CODES.PROVIDER_ERROR, 'LLM provider request failed', { provider }),
      successAttributes: response => ({
        'llm.provider': provider,
        'llm.response.model': response.model,
        'llm.finish_reason': response.finishReason,
        'llm.request_id': response.requestId,
        'llm.input_tokens': response.usage?.inputTokens,
        'llm.output_tokens': response.usage?.outputTokens,
      }),
      failureAttributes: error => ({ 'llm.provider': provider, 'llm.request_id': error.requestId }),
    }, () => adapter.generate(input))
  }
}
