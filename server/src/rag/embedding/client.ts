import type { EmbeddingAdapter, EmbeddingResponse, EmbedRequest } from './types.js'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { EMBEDDING_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { validateRequest, validateResponse } from './validation.js'

const tracer = trace.getTracer('knowledge-server.embedding')

/** 独立文本向量化入口；注册不触发网络请求，不自动重试或切换供应商。 */
export class EmbeddingClient {
  private readonly adapters = new Map<string, EmbeddingAdapter>()

  constructor(adapters: readonly EmbeddingAdapter[] = []) {
    for (const adapter of adapters)
      this.register(adapter)
  }

  register(adapter: EmbeddingAdapter): this {
    if (!adapter || !isNonEmptyString(adapter.provider) || typeof adapter.embed !== 'function' || this.adapters.has(adapter.provider))
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Embedding adapter provider must be non-empty and unique, with an embed method')
    this.adapters.set(adapter.provider, adapter)
    return this
  }

  async embed(request: EmbedRequest): Promise<EmbeddingResponse> {
    validateRequest(request)
    // 快照隔离调用方后续对输入数组的修改，确保响应数量始终对应该次请求。
    const snapshot = { ...request, input: [...request.input] }
    const { provider, ...input } = snapshot
    const adapter = this.adapters.get(provider)
    if (!adapter)
      throw new AppError(CODES.PROVIDER_NOT_FOUND, 'No embedding adapter is registered for this provider', { provider })
    const cancelled = () => new AppError(CODES.ABORTED, 'Embedding request was cancelled', { provider })
    if (input.signal?.aborted)
      throw cancelled()

    return tracer.startActiveSpan('embedding.embed', async (span) => {
      const startedAt = performance.now()
      span.setAttributes({ 'embedding.provider': provider, 'embedding.request.model': input.model, 'embedding.input_count': input.input.length })
      try {
        const response = await adapter.embed(input)
        if (input.signal?.aborted)
          throw cancelled()
        validateResponse(response, snapshot)
        // 不记录输入文本、向量、服务地址或鉴权信息。
        const attributes = {
          'embedding.provider': provider,
          'embedding.response.model': response.model,
          'embedding.dimensions': response.dimensions,
          'embedding.input_count': response.embeddings.length,
          ...(response.usage === null
            ? {}
            : {
                'embedding.input_tokens': response.usage.inputTokens,
                'embedding.total_tokens': response.usage.totalTokens,
              }),
          ...(response.requestId === undefined ? {} : { 'embedding.request_id': response.requestId }),
          'embedding.duration_ms': performance.now() - startedAt,
        }
        span.setAttributes(attributes)
        log.info('embedding.completed', attributes)
        return response
      }
      catch (error) {
        const normalized = input.signal?.aborted
          ? cancelled()
          : error instanceof AppError ? error : new AppError(CODES.PROVIDER_ERROR, 'Embedding provider request failed', { provider })
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.code })
        span.setAttribute('embedding.error.code', normalized.code)
        log.error('embedding.failed', {
          'embedding.provider': provider,
          'embedding.error.code': normalized.code,
          'embedding.request_id': normalized.requestId,
          'embedding.duration_ms': performance.now() - startedAt,
        })
        throw normalized
      }
      finally {
        span.end()
      }
    })
  }
}
