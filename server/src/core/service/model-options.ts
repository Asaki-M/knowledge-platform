import process from 'node:process'
import { EMBEDDING_ERROR_CODES, HTTP_ERROR_CODES, LLM_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { DeepSeekAdapter, LlmClient, OpenAIAdapter } from '../../llm/index.js'
import { EmbeddingClient, GoogleEmbeddingAdapter, SiliconFlowEmbeddingAdapter } from '../../rag/embedding/index.js'
import { isNonEmptyString, isRecord } from '../../utils/type-guards.js'

export interface EmbeddingSelection {
  provider: 'google' | 'siliconflow'
  model?: string
  dimensions?: number
}

function selection(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isNonEmptyString(value.provider) || Object.keys(value).some(key => !['provider', 'model', 'dimensions'].includes(key))
    || (value.model !== undefined && (!isNonEmptyString(value.model) || value.model.length > 256))) {
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '模型配置需要 provider 和可选的 model，不能传入凭据或服务地址。')
  }
  return value
}

export function llmOptions(value: unknown) {
  const input = value === undefined ? { provider: 'deepseek' } : selection(value)
  const provider = input.provider === 'ds' ? 'deepseek' : input.provider
  if (!['deepseek', 'openai'].includes(String(provider)) || input.dimensions !== undefined)
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, 'llm.provider 支持 deepseek（或 ds）和 openai。')
  const model = input.model ?? (provider === 'deepseek' ? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash' : process.env.OPENAI_MODEL)
  if (!isNonEmptyString(model))
    throw new AppError(LLM_ERROR_CODES.CONFIGURATION_ERROR, '请提供 LLM model 或配置对应模型环境变量。')
  return { provider: provider as 'deepseek' | 'openai', model: model.trim() }
}

export function embeddingSelection(value: unknown): EmbeddingSelection | undefined {
  if (value === undefined)
    return undefined
  const input = selection(value)
  const provider = input.provider === 'gemini' ? 'google' : input.provider
  if (provider !== 'google' && provider !== 'siliconflow')
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, 'embedding.provider 支持 gemini（或 google）和 siliconflow。')
  if (input.dimensions !== undefined && (typeof input.dimensions !== 'number' || !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 16000))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, 'embedding.dimensions 必须为 1–16000 的整数。')
  return { provider, ...(input.model === undefined ? {} : { model: (input.model as string).trim() }), ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions as number }) }
}

export function ingestionEmbeddingOptions(value: unknown) {
  const input = embeddingSelection(value) ?? { provider: 'siliconflow' as const }
  const model = input.model ?? (input.provider === 'google' ? process.env.GOOGLE_EMBEDDING_MODEL : process.env.EMBEDDING_MODEL)
  if (!isNonEmptyString(model))
    throw new AppError(EMBEDDING_ERROR_CODES.CONFIGURATION_ERROR, '请提供 Embedding model 或配置对应模型环境变量。')
  if (input.dimensions !== undefined && input.provider === 'siliconflow' && !model.startsWith('Qwen/Qwen3-'))
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '当前 SiliconFlow 模型不支持自定义维度。')
  return { ...input, model: model.trim() }
}

/** 只在实际调用时实例化所选 SDK，未选供应商缺少 Key 不阻断其他模型。 */
export function createLlmClient() {
  return new LlmClient([
    { provider: 'deepseek', generate: input => new DeepSeekAdapter().generate(input) },
    { provider: 'openai', generate: input => new OpenAIAdapter({ maxRetries: 0 }).generate(input) },
  ])
}

export function createEmbeddingClient() {
  return new EmbeddingClient([
    { provider: 'siliconflow', embed: input => new SiliconFlowEmbeddingAdapter().embed(input) },
    { provider: 'google', embed: input => new GoogleEmbeddingAdapter().embed(input) },
  ])
}
