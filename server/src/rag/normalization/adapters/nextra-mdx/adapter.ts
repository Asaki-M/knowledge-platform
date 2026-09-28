import type { NormalizationAdapter, NormalizationInput, NormalizedDocument } from '../../types.js'
import { NORMALIZATION_ERROR_CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { plainText, renderMarkdown } from '../../../markdown.js'
import { sourceFragment } from '../../source.js'
import { parseMdx } from './parser.js'
import { normalizeTree } from './transform.js'

/** nextra-docs 的 MDX 接入：解析原始 AST → 去除页面语法 → 标准 mdast。 */
export class NextraMdxAdapter implements NormalizationAdapter {
  readonly name = 'nextra-mdx'

  async normalize(input: NormalizationInput): Promise<NormalizedDocument> {
    if (input.signal?.aborted)
      throw new AppError(NORMALIZATION_ERROR_CODES.ABORTED, 'Normalization was cancelled')
    const original = parseMdx(input.content)
    try {
      const { ast, metadata, warnings } = normalizeTree(original)
      const heading = ast.children.find(node => node.type === 'heading' && node.depth === 1)
      const title = typeof metadata.title === 'string' ? metadata.title : heading ? plainText(heading) : null
      return {
        schemaVersion: 2,
        originalContent: input.content,
        blockSources: ast.children.map(node => sourceFragment(node, input.content)),
        source: { ...input.source },
        adapter: this.name,
        title,
        metadata,
        ast,
        markdown: renderMarkdown(ast),
        text: plainText(ast).trim(),
        warnings,
      }
    }
    catch (error) {
      if (error instanceof AppError)
        throw error
      throw new AppError(NORMALIZATION_ERROR_CODES.TRANSFORM_ERROR, 'Could not normalize MDX AST')
    }
  }
}
