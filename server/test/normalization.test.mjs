import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the shared error identity across compiled modules.
import { AppError } from '../dist/errors.js'

// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled public module in integration tests.
import { NextraMdxAdapter, NormalizationClient } from '../dist/rag/normalization/index.js'

const client = new NormalizationClient([new NextraMdxAdapter()])
const normalize = content => client.normalize({ adapter: 'nextra-mdx', source: { id: 'guide.mdx', path: 'guide.mdx' }, content })

function nodes(tree) {
  return [tree, ...(tree.children ?? []).flatMap(nodes)]
}

test('MDX becomes standard AST with metadata, source locations and rich document content', async () => {
  const source = [
    '---',
    'title: 接入指南',
    'tags: [SDK, API]',
    '---',
    '',
    'import Missing from \'./does-not-exist.js\'',
    '',
    '# 页面标题',
    '',
    '正文 **强调** 和 [参考][ref]。',
    '',
    '[ref]: /reference',
    '',
    '<Callout title="注意">',
    '',
    '保留提示内容。',
    '',
    '</Callout>',
    '',
    '<ZoomImage src="/image.png" alt="架构图" />',
    '',
    '<Download href="/sdk.zip">下载 SDK</Download>',
    '',
    '```ts title="example"',
    'const x = { text: "<Component />" }',
    '```',
    '',
    '| 字段 | 说明 |',
    '| --- | --- |',
    '| id | 换行<br/>继续 |',
    '',
    '- [x] 完成',
    '',
    '<span>{"静态文字"}</span>',
    '',
    '{/* 注释 */}',
  ].join('\n')
  const document = await normalize(source)
  assert.equal(document.title, '接入指南')
  assert.deepEqual(document.metadata.tags, ['SDK', 'API'])
  assert.equal(document.source.id, 'guide.mdx')
  assert.equal(document.ast.children[0].position.start.line, 8)
  const flat = nodes(document.ast)
  assert.equal(flat.some(node => node.type.startsWith('mdx') || node.type === 'yaml' || node.type === 'html'), false)
  assert.equal(flat.find(node => node.type === 'image').url, '/image.png')
  assert.equal(flat.find(node => node.type === 'code').value, 'const x = { text: "<Component />" }')
  assert.ok(flat.some(node => node.type === 'link' && node.url === '/sdk.zip'))
  assert.match(document.text, /注意/)
  assert.match(document.text, /架构图/)
  assert.match(document.text, /静态文字/)
  assert.doesNotMatch(document.text, /import Missing|注释/)
  assert.match(document.markdown, /\[参考\]\[ref\]/)
  assert.equal(document.warnings.length, 0)
  assert.deepEqual(await normalize(source), document)
  assert.doesNotThrow(() => JSON.stringify(document))
})

test('ExpandableTable keeps nested fields, custom columns and static JSX descriptions', async () => {
  const document = await normalize([
    '<ExpandableTable',
    ' columns={[{key: "name", label: "字段"}, {key: "description", label: "说明"}]}',
    ' rows={[{name: "data", children: [{name: "id", description: <>用户<span style={{color: "red"}}>标识</span></>}, {name: "url", description: "[参考](/help)"}]}]}',
    '/>',
  ].join('\n'))
  const table = document.ast.children[0]
  assert.equal(table.type, 'table')
  assert.equal(table.children.length, 4)
  assert.equal(table.children[2].children[0].children[0].value, 'data.id')
  assert.match(document.text, /用户标识/)
  assert.ok(nodes(table).some(node => node.type === 'link' && node.url === '/help'))
  assert.equal(document.warnings.length, 0)
})

test('HTML tables preserve cells and headings, unknown components preserve body with warnings', async () => {
  const document = await normalize('<h1>标题</h1>\n\n<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>\n\n<Widget>有价值的文字</Widget>')
  assert.equal(document.title, '标题')
  assert.equal(nodes(document.ast).filter(node => node.type === 'tableCell').length, 4)
  assert.match(document.text, /1\t2/)
  assert.match(document.text, /有价值的文字/)
  assert.equal(document.warnings.length, 1)
  assert.equal(document.warnings[0].position.start.line, 5)
})

test('expressions never execute and unsupported content is reported', async () => {
  const document = await normalize([
    'export const x = (() => { throw new Error("must not run") })()',
    '',
    '{(() => { throw new Error("must not run") })()}',
    '',
    '<ExpandableTable rows={getRows()} />',
    '',
    '<script>throw new Error("must not run")</script>',
    '',
    '正常正文',
  ].join('\n'))
  assert.match(document.text, /正常正文/)
  assert.doesNotMatch(document.text, /must not run|getRows/)
  assert.ok(document.warnings.length >= 3)
  assert.ok(document.warnings.every(item => item.position))
})

test('syntax and frontmatter errors are classified without leaking document text', async () => {
  for (const content of ['<Unclosed>', '---\ntitle: [\n---', '---\n- item\n---']) {
    await assert.rejects(normalize(content), error => error instanceof AppError && error.code === 'NORMALIZATION_PARSE_ERROR' && !error.message.includes(content))
  }
  const empty = await normalize('')
  assert.equal(empty.title, null)
  assert.equal(empty.text, '')
  assert.deepEqual(empty.ast.children, [])
})

test('new document adapters register without MDX dependencies; invalid input and cancellation fail early', async () => {
  let called = 0
  const expected = await normalize('# adapter output')
  const custom = {
    name: 'custom',
    async normalize(input) {
      called++
      return { ...expected, adapter: 'custom', source: input.source }
    },
  }
  const customClient = new NormalizationClient().register(custom)
  const request = { adapter: 'custom', source: { id: 'custom.txt' }, content: 'input' }
  assert.equal((await customClient.normalize(request)).adapter, 'custom')
  assert.throws(() => customClient.register(custom), { code: 'NORMALIZATION_CONFIGURATION_ERROR' })
  await assert.rejects(customClient.normalize({ ...request, adapter: 'missing' }), { code: 'NORMALIZATION_ADAPTER_NOT_FOUND' })
  await assert.rejects(customClient.normalize({ ...request, content: null }), { code: 'NORMALIZATION_INVALID_INPUT' })
  await assert.rejects(customClient.normalize({ ...request, signal: AbortSignal.abort() }), { code: 'NORMALIZATION_ABORTED' })
  assert.equal(called, 1)
  const broken = new NormalizationClient([{
    name: 'broken',
    async normalize() {
      throw new Error('private document content')
    },
  }])
  await assert.rejects(broken.normalize({ ...request, adapter: 'broken' }), { code: 'NORMALIZATION_TRANSFORM_ERROR', message: 'Document normalization failed' })
})

test('source mapping distinguishes precise fragments, synthesized envelopes and missing positions', async () => {
  const { sourceFragment } = await import('../dist/rag/normalization/source.js')
  const document = await normalize('<ZoomImage src="/image.png" alt="图" />')
  assert.equal(document.schemaVersion, 2)
  assert.equal(document.blockSources[0].text, document.originalContent)
  assert.equal(document.blockSources[0].exact, false)
  const missing = sourceFragment({ type: 'paragraph', children: [{ type: 'text', value: 'text' }] }, 'text')
  assert.deepEqual(missing, { text: null, exact: false })
  const heading = await normalize('# Heading')
  assert.equal(heading.blockSources[0].exact, true)
  assert.equal(heading.blockSources[0].text, '# Heading')
  heading.blockSources[0].position.start.line = 999
  assert.equal(heading.ast.children[0].position.start.line, 1)
})
