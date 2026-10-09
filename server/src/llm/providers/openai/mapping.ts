import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import type { LlmRequest } from '../../types.js'

/** 保持消息顺序和显式参数，不补默认采样值；每次提交所需历史并关闭响应存储。 */
export function toOpenAIRequest(request: LlmRequest): ResponseCreateParamsNonStreaming {
  return {
    model: request.model,
    input: request.messages.map(message => ({ role: message.role, content: message.content })),
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    text: request.structuredOutput
      ? { format: { type: 'json_schema', name: request.structuredOutput.name, schema: request.structuredOutput.schema, strict: true } }
      : undefined,
    store: false,
    stream: false,
  }
}
