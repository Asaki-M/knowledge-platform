import type { NormalizationAdapter, NormalizedDocument, NormalizeRequest } from './types.js'
import { NORMALIZATION_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { traceOperation } from '../../telemetry/operation.js'
import { isNonEmptyString } from '../../utils/type-guards.js'

/** 与 LlmClient 一样负责注册、分发和追踪，不包含特定文档格式的规则。 */
export class NormalizationClient {
  private readonly adapters = new Map<string, NormalizationAdapter>()

  constructor(adapters: readonly NormalizationAdapter[] = []) {
    for (const adapter of adapters)
      this.register(adapter)
  }

  register(adapter: NormalizationAdapter): this {
    if (!adapter || !isNonEmptyString(adapter.name) || typeof adapter.normalize !== 'function' || this.adapters.has(adapter.name))
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Adapter name must be non-empty and unique, with a normalize method')
    this.adapters.set(adapter.name, adapter)
    return this
  }

  async normalize(request: NormalizeRequest): Promise<NormalizedDocument> {
    if (!request || !isNonEmptyString(request.adapter) || !isNonEmptyString(request.source?.id) || typeof request.content !== 'string')
      throw new AppError(CODES.INVALID_INPUT, 'Adapter, source ID and string content are required')
    const { adapter: name, ...input } = request
    const adapter = this.adapters.get(name)
    if (!adapter)
      throw new AppError(CODES.ADAPTER_NOT_FOUND, 'No adapter is registered for this document type')
    if (input.signal?.aborted)
      throw new AppError(CODES.ABORTED, 'Normalization was cancelled')

    return traceOperation({
      namespace: 'normalization',
      name: 'normalization.normalize',
      event: 'normalization',
      attributes: { 'normalization.adapter': name },
      normalizeError: error => error instanceof AppError ? error : new AppError(CODES.TRANSFORM_ERROR, 'Document normalization failed'),
      successAttributes: result => ({ 'normalization.adapter': name, 'normalization.warnings': result.warnings.length }),
      failureAttributes: () => ({ 'normalization.adapter': name }),
    }, async () => {
      const result = await adapter.normalize(input)
      if (input.signal?.aborted)
        throw new AppError(CODES.ABORTED, 'Normalization was cancelled')
      return result
    })
  }
}
