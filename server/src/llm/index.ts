/** LLM 模块公共出口：业务层统一从此导入，供应商 SDK 类型留在适配器内部。 */
export { LLM_ERROR_CODES } from '../error-codes.js'
export type { LlmErrorCode } from '../error-codes.js'
export { LlmClient } from './client.js'
export type { OpenAIAdapterOptions } from './providers/openai/index.js'
export { OpenAIAdapter } from './providers/openai/index.js'
export type { LlmAdapter, LlmFinishReason, LlmGenerateRequest, LlmMessage, LlmRequest, LlmResponse, LlmUsage } from './types.js'
