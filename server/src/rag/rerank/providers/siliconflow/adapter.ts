import type { Reranker, RerankRequest, RerankResponse } from '../../types.js'
import process from 'node:process'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import OpenAI from 'openai'
import { RERANK_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { log } from '../../../../telemetry/logger.js'
import { isNonEmptyString } from '../../../../utils/type-guards.js'
import { toRerankResponse } from './mapping.js'
import { normalizeError } from './normalize-error.js'

export class SiliconFlowReranker implements Reranker {
  private readonly client: OpenAI

  constructor(options: { apiKey?: string, baseURL?: string, timeoutMs?: number } = {}) {
    const apiKey = options.apiKey ?? process.env.RERANK_API_KEY ?? process.env.EMBEDDING_API_KEY
    const timeout = options.timeoutMs ?? 60000
    if (!isNonEmptyString(apiKey) || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647)
      throw new AppError(CODES.CONFIGURATION_ERROR, 'Rerank API key and a positive timeout are required')
    this.client = new OpenAI({ apiKey, baseURL: options.baseURL ?? process.env.RERANK_BASE_URL ?? process.env.EMBEDDING_BASE_URL ?? 'https://api.siliconflow.cn/v1', timeout, maxRetries: 0 })
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    if (!isNonEmptyString(request.model) || !isNonEmptyString(request.query) || !Array.isArray(request.documents) || !request.documents.length || request.documents.length > 60
      || request.documents.some(text => !isNonEmptyString(text)) || !Number.isSafeInteger(request.topN) || request.topN < 1 || request.topN > request.documents.length) {
      throw new AppError(CODES.INVALID_REQUEST, 'Invalid rerank request')
    }
    const input = { ...request, documents: [...request.documents] }
    return trace.getTracer('knowledge-server.rerank').startActiveSpan('rerank.rerank', async (span) => {
      const started = performance.now()
      span.setAttributes({ 'rerank.provider': 'siliconflow', 'rerank.model': input.model, 'rerank.input_count': input.documents.length })
      try {
        if (input.signal?.aborted)
          throw new AppError(CODES.ABORTED, 'Rerank request was cancelled')
        // 复用 SDK 的鉴权、超时和取消能力；硅基流动重排走独立 /rerank 协议。
        const { data, response } = await this.client.post<unknown>('/rerank', {
          body: { model: input.model, query: input.query, documents: input.documents, top_n: input.topN, return_documents: false },
          signal: input.signal,
        }).withResponse()
        if (input.signal?.aborted)
          throw new AppError(CODES.ABORTED, 'Rerank request was cancelled')
        const result = toRerankResponse(data, input, response.headers.get('x-siliconcloud-trace-id') ?? undefined)
        log.info('rerank.completed', { 'rerank.model': input.model, 'rerank.input_count': input.documents.length, 'rerank.output_count': result.results.length, 'rerank.request_id': result.requestId, 'rerank.duration_ms': performance.now() - started, ...(result.usage ? { 'rerank.input_tokens': result.usage.inputTokens, 'rerank.output_tokens': result.usage.outputTokens } : {}) })
        return result
      }
      catch (error) {
        const normalized = input.signal?.aborted ? new AppError(CODES.ABORTED, 'Rerank request was cancelled') : normalizeError(error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.code })
        log.error('rerank.failed', { 'rerank.error.code': normalized.code, 'rerank.duration_ms': performance.now() - started })
        throw normalized
      }
      finally {
        span.end()
      }
    })
  }
}
