import type { Root } from 'mdast'
import type { Position } from 'unist'

/** 仅接受可序列化的元数据，不把解析器对象或可执行值带到后续阶段。 */
export type MetadataValue = string | number | boolean | null | MetadataValue[] | { [key: string]: MetadataValue }

export interface DocumentSource {
  /** 调用方分配的稳定文档标识，例如知识库 ID 与文档路径的组合。 */
  id: string
  path?: string
}

/** 内容加载由调用方负责；适配器不绑定本地目录、HTTP 或数据库。 */
export interface NormalizationInput {
  source: DocumentSource
  content: string
  signal?: AbortSignal
}

/** 未完整提取的内容必须留下提示；position 指向原始文档，不是输出 Markdown。 */
export interface NormalizationWarning {
  message: string
  position?: Position
}

export interface NormalizedDocument {
  schemaVersion: 2
  originalContent: string
  /** 与 ast.children 一一对应；exact=false 表示只能定位到来源包围范围。 */
  blockSources: SourceFragment[]
  source: DocumentSource
  adapter: string
  title: string | null
  metadata: { [key: string]: MetadataValue }
  /** 标准 Markdown / GFM mdast；不包含 MDX JSX、ESM 或 JavaScript 表达式节点。 */
  ast: Root
  /** 从归一化 AST 派生，后续 Wiki、切分可选用 AST 或 Markdown。 */
  markdown: string
  /** 面向检索的纯文本，保留代码内容、图片替代文字和表格行列边界。 */
  text: string
  warnings: NormalizationWarning[]
}

/** 新格式只需实现此接口并注册；各格式的原始 AST 保留在自己的适配器内部。 */
export interface NormalizationAdapter {
  readonly name: string
  normalize: (input: NormalizationInput) => Promise<NormalizedDocument>
}

export interface NormalizeRequest extends NormalizationInput {
  adapter: string
}

/** 原始输入中的片段；缺少来源位置时明确为空，不反向生成原文。 */
export interface SourceFragment {
  text: string | null
  position?: Position
  exact: boolean
}
