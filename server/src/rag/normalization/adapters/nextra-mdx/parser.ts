import type { Root } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { NORMALIZATION_ERROR_CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'

// 只解析语法树，不编译、加载 import 或渲染 React 组件。
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).use(remarkMdx)
export const markdownParser = unified().use(remarkParse).use(remarkGfm)

export function parseMdx(content: string): Root {
  try {
    return parser.parse(content)
  }
  catch (error) {
    const point = error && typeof error === 'object' && 'line' in error && 'column' in error
      && typeof error.line === 'number' && typeof error.column === 'number'
      ? { line: error.line, column: error.column }
      : undefined
    throw new AppError(NORMALIZATION_ERROR_CODES.PARSE_ERROR, 'Invalid MDX syntax', { location: point })
  }
}
