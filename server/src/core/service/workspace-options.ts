import process from 'node:process'
import { readWorkspaceCatalog } from '../dao/workspace-options.js'

/** 仅返回已配置的模型名称；凭据和服务地址永远留在服务端。 */
export function configuredModels() {
  const entries = [
    { kind: 'llm', provider: 'deepseek', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', key: process.env.DEEPSEEK_API_KEY },
    { kind: 'llm', provider: 'openai', model: process.env.OPENAI_MODEL, key: process.env.OPENAI_API_KEY },
    { kind: 'embedding', provider: 'siliconflow', model: process.env.EMBEDDING_MODEL, key: process.env.EMBEDDING_API_KEY },
    { kind: 'embedding', provider: 'google', model: process.env.GOOGLE_EMBEDDING_MODEL, key: process.env.GOOGLE_API_KEY },
  ]
  const options = (kind: string) => entries.filter(item => item.kind === kind && item.key?.trim() && item.model?.trim()).map(item => ({ provider: item.provider, model: item.model!.trim() }))
  return { llm: options('llm'), embedding: options('embedding') }
}

export async function workspaceOptions() {
  return { ...await readWorkspaceCatalog(), models: configuredModels() }
}
