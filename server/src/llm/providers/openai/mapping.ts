import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import type { LlmFinishReason, LlmRequest, LlmResponse } from '../../types.js'
import { LLM_ERROR_CODES } from '../../../error-codes.js'
import { AppError } from '../../../errors.js'

/** 保持消息顺序和显式参数，不补默认采样值；每次提交所需历史并关闭响应存储。 */
export function toOpenAIRequest(request: LlmRequest): ResponseCreateParamsNonStreaming {
  return {
    model: request.model,
    input: request.messages.map(message => ({ role: message.role, content: message.content })),
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    store: false,
    stream: false,
  }
}

/**
 * 将 Responses 的任务状态、消息内容和用量归一化为公共响应。
 * _request_id 是 SDK 从响应头附加的元数据，不属于 Responses 原始响应体。
 */
export function toLlmResponse(response: Response & { _request_id?: string | null }): LlmResponse {
  // HTTP 成功不一定代表生成成功，还需要检查响应体中的任务状态。
  const errorOptions = { provider: 'openai', requestId: response._request_id ?? undefined }
  if (response.status === 'cancelled')
    throw new AppError(LLM_ERROR_CODES.ABORTED, 'LLM response was cancelled', errorOptions)
  if (response.error || response.status === 'failed')
    throw new AppError(LLM_ERROR_CODES.PROVIDER_ERROR, 'LLM provider could not generate a response', errorOptions)
  if (response.status !== 'completed' && response.status !== 'incomplete')
    throw new AppError(LLM_ERROR_CODES.INVALID_RESPONSE, 'Expected a completed or incomplete LLM response', errorOptions)

  // output 可能包含推理等其他条目，只从消息内容中提取拒答信息并单独返回。
  const refusal = response.output
    .filter(item => item.type === 'message')
    .flatMap(item => item.content)
    .filter(item => item.type === 'refusal')
    .map(item => item.refusal)
    .join('\n') || undefined
  // 截断和过滤仍可携带部分文本，不能把这些结果一律当作正常结束。
  let finishReason: LlmFinishReason = 'unknown'
  if (refusal)
    finishReason = 'refusal'
  else if (response.incomplete_details?.reason === 'max_output_tokens')
    finishReason = 'length'
  else if (response.incomplete_details?.reason === 'content_filter')
    finishReason = 'content_filter'
  else if (response.status === 'completed')
    finishReason = 'stop'

  // 拒答或未完成结果允许没有文本；声称正常完成却没有文本时视为无效响应。
  if (typeof response.output_text !== 'string' || (finishReason === 'stop' && !response.output_text))
    throw new AppError(LLM_ERROR_CODES.INVALID_RESPONSE, 'LLM response contains no text', errorOptions)

  // output_text 由 SDK 汇总；用量缺失时保留 null，避免业务层误认为没有消耗。
  return {
    id: response.id,
    provider: 'openai',
    model: response.model,
    text: response.output_text,
    finishReason,
    refusal,
    requestId: response._request_id ?? undefined,
    usage: response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens }
      : null,
  }
}
