import type { JSXSpreadChild, Node, Program } from 'estree-jsx'
import type { MetadataValue } from '../../types.js'

/** 读取 ESTree 字面量，不使用 eval；变量、函数、属性访问、展开和计算属性一律不求值。 */
export function readStatic(node: Node | JSXSpreadChild): MetadataValue {
  switch (node.type) {
    case 'Literal':
      if (node.value === null || typeof node.value === 'string' || typeof node.value === 'boolean' || (typeof node.value === 'number' && Number.isFinite(node.value)))
        return node.value
      break
    case 'ArrayExpression':
      return node.elements.map((item) => {
        if (!item)
          throw new Error('Sparse arrays are unsupported')
        return readStatic(item)
      })
    case 'ObjectExpression': {
      const result: Record<string, MetadataValue> = Object.create(null)
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed || property.method || property.shorthand || property.kind !== 'init')
          throw new Error('Only static object properties are supported')
        const key = property.key.type === 'Identifier' ? property.key.name : readStatic(property.key)
        if (typeof key !== 'string' && typeof key !== 'number')
          throw new Error('Invalid object key')
        result[String(key)] = readStatic(property.value)
      }
      return result
    }
    case 'UnaryExpression':
      if (node.operator === '-' || node.operator === '+') {
        const value = readStatic(node.argument)
        if (typeof value === 'number')
          return node.operator === '-' ? -value : value
      }
      break
    case 'TemplateLiteral':
      if (node.expressions.length === 0)
        return node.quasis.map(item => item.value.cooked ?? item.value.raw).join('')
      break
    case 'JSXElement': {
      // 表格说明中允许纯排版标签；未知组件、脚本或动态渲染不能伪装成静态内容。
      const name = node.openingElement.name
      if (name.type !== 'JSXIdentifier' || !['span', 'br', 'strong', 'b', 'em', 'i', 'code'].includes(name.name))
        break
      if (name.name === 'br')
        return '\n'
      return node.children.map(readJsxText).join('')
    }
    case 'JSXFragment':
      return node.children.map(readJsxText).join('')
    case 'JSXText':
      return node.value
    case 'JSXExpressionContainer':
      return readStatic(node.expression)
    case 'JSXEmptyExpression':
      return ''
  }
  throw new Error('Dynamic expression is unsupported')
}

function readJsxText(node: Node | JSXSpreadChild): string {
  const value = readStatic(node)
  if (value === null || typeof value === 'boolean')
    return ''
  if (typeof value === 'string' || typeof value === 'number')
    return String(value)
  throw new Error('Only static JSX text is supported')
}

export function readExpression(program: Program | null | undefined): MetadataValue | undefined {
  if (!program || program.body.length === 0)
    return undefined // MDX 注释也是空程序，不输出正文。
  if (program.body.length !== 1 || program.body[0].type !== 'ExpressionStatement')
    throw new Error('Expected a single static expression')
  return readStatic(program.body[0].expression)
}
