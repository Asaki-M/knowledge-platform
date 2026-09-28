import type { Root, RootContent, TableRow } from 'mdast'
import type { MetadataValue, NormalizationWarning } from '../../types.js'
import { parseDocument } from 'yaml'
import { NORMALIZATION_ERROR_CODES } from '../../../../error-codes.js'
import { AppError } from '../../../../errors.js'
import { isRecord } from '../../../../utils/type-guards.js'
import { readExpression } from './static-value.js'
import { expandableTable } from './table.js'
import { asBlocks, asInline } from './tree.js'

type Jsx = Extract<RootContent, { type: 'mdxJsxFlowElement' | 'mdxJsxTextElement' }>

/** 每次调用独立维护元数据与提示；不修改原始 AST，方便对照原文定位。 */
export function normalizeTree(tree: Root) {
  const warnings: NormalizationWarning[] = []
  let metadata: Record<string, MetadataValue> = {}
  const warn = (node: RootContent, message: string) => warnings.push({ message, position: node.position })

  function attribute(node: Jsx, name: string): MetadataValue | undefined {
    const attr = node.attributes.find(item => item.type === 'mdxJsxAttribute' && item.name === name)
    if (!attr || attr.type !== 'mdxJsxAttribute')
      return undefined
    if (attr.value === null)
      return true
    if (typeof attr.value === 'string')
      return attr.value
    try {
      return readExpression(attr.value?.data?.estree)
    }
    catch {
      warn(node, `无法静态读取组件属性 ${name}，未执行表达式。`)
      return undefined
    }
  }

  function jsx(node: Jsx): RootContent[] {
    const name = node.name
    if (name === 'script' || name === 'style') {
      warn(node, '已移除脚本或样式节点。')
      return []
    }
    if (name === 'ExpandableTable') {
      try {
        const table = expandableTable(attribute(node, 'rows'), attribute(node, 'columns'))
        return normalize({ ...table, position: node.position })
      }
      catch {
        warn(node, 'ExpandableTable 数据不是支持的静态表格结构，未提取表格。')
        return []
      }
    }
    if (name === 'table') {
      // HTML 表格保留行列边界；thead/tbody 只是布局容器。
      const rows: TableRow[] = []
      const collect = (nodes: RootContent[]) => {
        for (const child of nodes) {
          if ((child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') && child.name === 'tr') {
            rows.push({
              type: 'tableRow',
              children: child.children.filter((cell): cell is Jsx => (cell.type === 'mdxJsxFlowElement' || cell.type === 'mdxJsxTextElement') && (cell.name === 'td' || cell.name === 'th')).map(cell => ({
                type: 'tableCell',
                children: asInline(cell.children.flatMap(normalize)),
                position: cell.position,
              })),
              position: child.position,
            })
          }
          else if ('children' in child) {
            collect(child.children)
          }
        }
      }
      collect(node.children)
      return rows.length ? [{ type: 'table', children: rows, position: node.position }] : []
    }
    if (name === 'ZoomImage' || name === 'img') {
      const src = attribute(node, 'src')
      const alt = attribute(node, 'alt')
      if (typeof src !== 'string') {
        warn(node, '图片缺少静态 src，未提取图片。')
        return []
      }
      const image: RootContent = { type: 'image', url: src, alt: typeof alt === 'string' ? alt : '', position: node.position }
      return node.type === 'mdxJsxFlowElement' ? asBlocks([image]) : [image]
    }
    if (name === 'br')
      return [{ type: 'break', position: node.position }]
    const children = node.children.flatMap(normalize)
    if (name === 'Download' || name === 'a') {
      const href = attribute(node, 'href')
      if (typeof href !== 'string') {
        warn(node, '链接缺少静态 href，仅保留可见文字。')
        return children
      }
      const link: RootContent = { type: 'link', url: href, children: asInline(children), position: node.position }
      return node.type === 'mdxJsxFlowElement' ? asBlocks([link]) : [link]
    }
    if (name === 'Callout') {
      const title = attribute(node, 'title')
      return [{
        type: 'blockquote',
        children: asBlocks([
          ...(typeof title === 'string' ? [{ type: 'paragraph' as const, children: [{ type: 'strong' as const, children: [{ type: 'text' as const, value: title }] }] }] : []),
          ...children,
        ]) as Extract<RootContent, { type: 'blockquote' }>['children'],
        position: node.position,
      }]
    }
    if (name && /^h[1-6]$/.test(name))
      return [{ type: 'heading', depth: Number(name[1]) as 1 | 2 | 3 | 4 | 5 | 6, children: asInline(children), position: node.position }]
    if (name === 'p' || name === 'summary')
      return [{ type: 'paragraph', children: asInline(children), position: node.position }]
    if (name === 'strong' || name === 'b')
      return [{ type: 'strong', children: asInline(children), position: node.position }]
    if (name === 'em' || name === 'i')
      return [{ type: 'emphasis', children: asInline(children), position: node.position }]
    if (name && !['div', 'span', 'details'].includes(name))
      warn(node, `未配置组件 ${name} 的专用规则，仅保留子内容。`)
    return node.type === 'mdxJsxFlowElement' ? asBlocks(children) : asInline(children)
  }

  function normalize(node: RootContent): RootContent[] {
    switch (node.type) {
      case 'yaml': {
        try {
          const document = parseDocument(node.value, { schema: 'core' })
          if (document.errors.length)
            throw new Error('Invalid YAML')
          const value: unknown = document.toJS({ maxAliasCount: 100 })
          if (value !== null && !isRecord(value))
            throw new Error('Frontmatter must be an object')
          metadata = JSON.parse(JSON.stringify(value ?? {}, (_key, item) => {
            if (typeof item === 'number' && !Number.isFinite(item))
              throw new Error('Non-finite metadata')
            return item
          })) as Record<string, MetadataValue>
        }
        catch {
          throw new AppError(NORMALIZATION_ERROR_CODES.PARSE_ERROR, 'Invalid YAML frontmatter', { location: node.position?.start })
        }
        return []
      }
      case 'mdxjsEsm':
        return [] // import/export 属于页面程序，不作为知识正文，也不解析其依赖。
      case 'mdxFlowExpression':
      case 'mdxTextExpression': {
        try {
          const value = readExpression(node.data?.estree)
          if (value === undefined || value === null || typeof value === 'boolean')
            return []
          if (typeof value !== 'string' && typeof value !== 'number')
            throw new Error('Non-text expression')
          const text: RootContent = { type: 'text', value: String(value), position: node.position }
          return node.type === 'mdxFlowExpression' ? asBlocks([text]) : [text]
        }
        catch {
          warn(node, '无法静态提取表达式的可见文字，未执行表达式。')
          return []
        }
      }
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement':
        return jsx(node)
      case 'paragraph':
        // 单行 HTML 标题/表格可能被 MDX 解析为段落内 JSX；转换后提升为块节点。
        return asBlocks(node.children.flatMap(normalize)).map(child => ({ ...child, position: child.position ?? node.position }))
      case 'html':
        if (/^<br\s*(?:\/\s*)?>$/i.test(node.value))
          return [{ type: 'break', position: node.position }]
        warn(node, '已移除无法映射的原始 HTML 标签。')
        return []
      default:
        if ('children' in node)
          return [{ ...node, children: node.children.flatMap(normalize) } as RootContent]
        return [{ ...node }]
    }
  }

  const ast: Root = { type: 'root', children: asBlocks(tree.children.flatMap(normalize)), position: tree.position }
  return { ast, metadata, warnings }
}
