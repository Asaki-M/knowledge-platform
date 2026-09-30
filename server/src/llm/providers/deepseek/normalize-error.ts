import { normalizeOpenAISdkError } from '../openai-sdk.js'

/** 复用 SDK 分类规则，同时保留本厂商身份。 */
export function normalizeError(error: unknown) {
  return normalizeOpenAISdkError(error, 'deepseek')
}
