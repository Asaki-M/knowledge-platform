/** 当前已接入的可配置维度模型；未知供应商沿用自身默认值。 */
export function supportsEmbeddingDimensions(provider: string, model: string): boolean {
  return provider === 'google' || (provider === 'siliconflow' && model.startsWith('Qwen/Qwen3-'))
}

/** 显式维度优先，支持的模型更新/查询时继承知识库维度；不改变模型空间校验。 */
export function resolveEmbeddingDimensions(selection: { provider: string, model: string, dimensions?: number }, storedDimensions?: number | null): number | undefined {
  return selection.dimensions ?? (supportsEmbeddingDimensions(selection.provider, selection.model) ? storedDimensions ?? undefined : undefined)
}
