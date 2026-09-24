import type { NormalizationAdapter, NormalizedDocument, NormalizeRequest } from './types.js'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { NORMALIZATION_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { log } from '../../telemetry/logger.js'

const tracer = trace.getTracer('knowledge-server.normalization')

/** 与 LlmClient 一样负责注册、分发和追踪，不包含特定文档格式的规则。 */
export class NormalizationClient {
  private readonly adapters = new Map<string, NormalizationAdapter>()

  constructor(adapters: readonly NormalizationAdapter[] = []) {
    for (const adapter of adapters)
      this.register(adapter)
  }

  register(adapter: NormalizationAdapter): this {
    if (!adapter || typeof adapter.name !== 'string' || !adapter.name.trim() || typeof adapter.normalize !== 'function' || this.adapters.has(adapter.name))
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Adapter name must be non-empty and unique, with a normalize method')
    this.adapters.set(adapter.name, adapter)
    return this
  }

  async normalize(request: NormalizeRequest): Promise<NormalizedDocument> {
    if (!request || typeof request.adapter !== 'string' || !request.adapter.trim() || typeof request.source?.id !== 'string' || !request.source.id.trim() || typeof request.content !== 'string')
      throw new AppError(CODES.INVALID_INPUT, 'Adapter, source ID and string content are required')
    const { adapter: name, ...input } = request
    const adapter = this.adapters.get(name)
    if (!adapter)
      throw new AppError(CODES.ADAPTER_NOT_FOUND, 'No adapter is registered for this document type')
    if (input.signal?.aborted)
      throw new AppError(CODES.ABORTED, 'Normalization was cancelled')

    return tracer.startActiveSpan('normalization.normalize', async (span) => {
      const start = performance.now()
      span.setAttribute('normalization.adapter', name)
      try {
        const result = await adapter.normalize(input)
        if (input.signal?.aborted)
          throw new AppError(CODES.ABORTED, 'Normalization was cancelled')
        const attributes = {
          'normalization.adapter': name,
          'normalization.warnings': result.warnings.length,
          'normalization.duration_ms': performance.now() - start,
        }
        span.setAttributes(attributes)
        log.info('normalization.completed', attributes)
        return result
      }
      catch (error) {
        const normalized = error instanceof AppError
          ? error
          : new AppError(CODES.TRANSFORM_ERROR, 'Document normalization failed')
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.code })
        log.error('normalization.failed', { 'normalization.adapter': name, 'normalization.error.code': normalized.code })
        throw normalized
      }
      finally {
        span.end()
      }
    })
  }
}
