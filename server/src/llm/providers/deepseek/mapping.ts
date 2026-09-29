import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'
import type { LlmFinishReason, LlmRequest, LlmResponse } from '../../types.js'
import { LLM_ERROR_CODES } from '../../../error-codes.js'
import { AppError } from '../../../errors.js'

/** 保持消息顺序与显式参数；使用 Chat Completions 的 max_tokens 字段。 */
export function toDeepSeekRequest(request: LlmRequest): ChatCompletionCreateParamsNonStreaming {
  return {
    model: request.model,
    messages: request.messages.map(message => ({ role: message.role, content: message.content })),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    stream: false,
  }
}

/** 只提取最终回答，不把 reasoning_content 等供应商字段混入公共文本。 */
export function toLlmResponse(response: ChatCompletion & { _request_id?: string | null }): LlmResponse {
  const errorOptions = { provider: 'deepseek', requestId: response._request_id ?? undefined }
  const invalid = () => new AppError(LLM_ERROR_CODES.INVALID_RESPONSE, 'Invalid DeepSeek text response', errorOptions)
  // 当前契约每次只有一个回答，缺失或多余的 choice 不能静默接受。
  if (!Array.isArray(response.choices) || response.choices.length !== 1
    || typeof response.id !== 'string' || !response.id
    || typeof response.model !== 'string' || !response.model) {
    throw invalid()
  }
  const choice = response.choices[0]!
  const message = choice?.message
  if (!message || message.role !== 'assistant'
    || (message.content != null && typeof message.content !== 'string')
    || (message.refusal != null && typeof message.refusal !== 'string')) {
    throw invalid()
  }

  const refusal = message.refusal || undefined
  let finishReason: LlmFinishReason = 'unknown'
  if (refusal)
    finishReason = 'refusal'
  else if (choice.finish_reason === 'stop' || choice.finish_reason === 'length' || choice.finish_reason === 'content_filter')
    finishReason = choice.finish_reason

  // 截断、过滤与拒答允许空文本；正常完成却没有回答时明确失败。
  const text = message.content ?? ''
  if (finishReason === 'stop' && !text)
    throw invalid()
  const usage = response.usage
  if (usage && ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(value => Number.isInteger(value) && value >= 0))
    throw invalid()

  return {
    id: response.id,
    provider: 'deepseek',
    model: response.model,
    text,
    finishReason,
    refusal,
    requestId: response._request_id ?? undefined,
    usage: usage
      ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
      : null,
  }
}
