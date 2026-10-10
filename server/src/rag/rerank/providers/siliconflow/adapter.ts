import type { Reranker, RerankRequest, RerankResponse } from '../../types.js'
import process from 'node:process'
import OpenAI from 'openai'
import { RERANK_ERROR_CODES as CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { traceOperation } from '../../../../telemetry/operation.js'
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
    const cancelled = () => new AppError(CODES.ABORTED, 'Rerank request was cancelled')
    return traceOperation({
      namespace: 'rerank',
      name: 'rerank.rerank',
      event: 'rerank',
      attributes: { 'rerank.provider': 'siliconflow', 'rerank.model': input.model, 'rerank.input_count': input.documents.length },
      normalizeError: error => input.signal?.aborted ? cancelled() : normalizeError(error),
      successAttributes: result => ({
        'rerank.model': input.model,
        'rerank.input_count': input.documents.length,
        'rerank.output_count': result.results.length,
        'rerank.request_id': result.requestId,
        ...(result.usage ? { 'rerank.input_tokens': result.usage.inputTokens, 'rerank.output_tokens': result.usage.outputTokens } : {}),
      }),
    }, async () => {
      if (input.signal?.aborted)
        throw cancelled()
      // 复用 SDK 的鉴权、超时和取消能力；硅基流动重排走独立 /rerank 协议。
      const { data, response } = await this.client.post<unknown>('/rerank', {
        body: { model: input.model, query: input.query, documents: input.documents, top_n: input.topN, return_documents: false },
        signal: input.signal,
      }).withResponse()
      if (input.signal?.aborted)
        throw cancelled()
      return toRerankResponse(data, input, response.headers.get('x-siliconcloud-trace-id') ?? undefined)
    })
  }
}
