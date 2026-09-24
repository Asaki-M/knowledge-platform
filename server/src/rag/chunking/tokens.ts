import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'

let tokenizer: Tiktoken | undefined

/** 默认采用明确的编码基线；延迟初始化，不在 HTTP 启动时构建词表。 */
export function countChunkTokens(text: string): number {
  tokenizer ??= new Tiktoken(cl100kBase)
  // 文档中的特殊 Token 标记也是普通文本，不能触发编码器的特殊指令语义。
  return tokenizer.encode(text, [], []).length
}
