import type { PhrasingContent, Table, TableCell, TableRow } from 'mdast'
import type { MetadataValue } from '../../types.js'
import { isRecord } from '../../../../utils/type-guards.js'
import { markdownParser } from './parser.js'
import { asInline } from './tree.js'

const defaultColumns = [
  { key: 'name', label: '名称' },
  { key: 'type', label: '类型' },
  { key: 'required', label: '是否必须' },
  { key: 'defaultValue', label: '默认值' },
  { key: 'description', label: '备注' },
  { key: 'extra', label: '其他信息' },
]

/** 展开所有嵌套字段，name 使用完整路径，避免丢失父子关系或被 UI 折叠状态过滤。 */
export function expandableTable(rows: MetadataValue | undefined, columns: MetadataValue | undefined): Table {
  const selected = columns ?? defaultColumns
  if (!Array.isArray(rows) || !Array.isArray(selected) || !selected.length)
    throw new Error('Static rows and columns are required')
  const schema = selected.map((column) => {
    if (!isRecord(column) || typeof column.key !== 'string' || typeof column.label !== 'string')
      throw new Error('Invalid table columns')
    return { key: column.key, label: column.label }
  })
  const cell = (children: PhrasingContent[]): TableCell => ({ type: 'tableCell', children })
  const output: TableRow[] = [{ type: 'tableRow', children: schema.map(column => cell([{ type: 'text', value: column.label }])) }]
  const visit = (items: MetadataValue[], parent: string) => {
    for (const row of items) {
      if (!isRecord(row))
        throw new Error('Invalid table row')
      const name = typeof row.name === 'string' ? row.name : ''
      const path = [parent, name].filter(Boolean).join('.')
      output.push({
        type: 'tableRow',
        children: schema.map(({ key }) => {
          if (key === 'name')
            return cell([{ type: 'inlineCode', value: path }])
          const value = row[key]
          const content = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
          // 组件本身使用 ReactMarkdown 渲染字符串，沿用其语义保留链接和行内代码。
          return cell(asInline(markdownParser.parse(content).children))
        }),
      })
      if (row.children !== undefined) {
        if (!Array.isArray(row.children))
          throw new Error('Invalid nested rows')
        visit(row.children, path)
      }
    }
  }
  visit(rows, '')
  return { type: 'table', children: output }
}
