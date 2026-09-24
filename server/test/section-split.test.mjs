import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the shared error identity across compiled modules.
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled public module in integration tests.
import { splitSections } from '../dist/rag/chunking/index.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled normalization-to-split pipeline.
import { NextraMdxAdapter, NormalizationClient } from '../dist/rag/normalization/index.js'

const client = new NormalizationClient([new NextraMdxAdapter()])
const normalize = content => client.normalize({ adapter: 'nextra-mdx', source: { id: 'kb/guide.mdx', path: 'guide.mdx' }, content })

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}

function nodes(tree) {
  return [tree, ...(tree.children ?? []).flatMap(nodes)]
}

test('sections retain preamble, hierarchy, skipped levels, repeated titles and exclusive ownership', async () => {
  const document = await normalize('开场说明\n\n# 指南\n\n简介\n\n## 安装\n\n安装正文\n\n#### 配置\n\n配置正文\n\n## 安装\n\n第二种安装\n\n# 附录')
  const sections = splitSections(document)
  assert.deepEqual(sections.map(section => section.title), [null, '指南', '安装', '配置', '安装', '附录'])
  assert.deepEqual(sections.map(section => section.depth), [0, 1, 2, 4, 2, 1])
  assert.deepEqual(sections.map(section => section.parentId), [null, null, sections[1].id, sections[2].id, sections[1].id, null])
  assert.deepEqual(sections[3].headingPath.map(heading => heading.title), ['指南', '安装', '配置'])
  assert.deepEqual(sections[3].headingPath.map(heading => heading.depth), [1, 2, 4])
  assert.equal(new Set(sections.map(section => section.id)).size, sections.length)
  assert.deepEqual(sections.map(section => section.index), [0, 1, 2, 3, 4, 5])
  assert.equal(sections[1].documentTitle, '指南')
  assert.equal(sections[1].text, '指南\n\n简介')
  assert.equal(sections[5].text, '附录')
  assert.deepEqual(sections.flatMap(section => section.ast.children), document.ast.children)
  assert.equal(sections[0].blockRange.start, 0)
  assert.equal(sections.at(-1).blockRange.end, document.ast.children.length)
  sections.slice(1).forEach((section, index) => assert.equal(section.blockRange.start, sections[index].blockRange.end))
  assert.equal(sections[2].position.start.line, 7)
  assert.equal(sections[2].position.end.line, 9)
  assert.equal(sections[2].source.id, 'kb/guide.mdx')
  assert.deepEqual(splitSections(document), sections)
})

test('empty, unheaded and heading-only documents have explicit section semantics', async () => {
  assert.deepEqual(splitSections(await normalize('')), [])
  assert.deepEqual(splitSections(await normalize('---\ntitle: 空文档\n---')), [])
  const [body] = splitSections(await normalize('---\ntitle: 元数据标题\n---\n正文'))
  assert.equal(body.documentTitle, '元数据标题')
  assert.equal(body.title, null)
  assert.equal(body.depth, 0)
  assert.deepEqual(body.headingPath, [])
  assert.equal(body.text, '正文')
  const headings = splitSections(await normalize('# 父标题\n\n## 子标题\n\n### 孙标题'))
  assert.equal(headings.length, 3)
  assert.equal(headings[2].parentId, headings[1].id)
  assert.ok(headings.every(section => section.ast.children.length === 1))
})

test('code, tables, lists and blockquotes stay intact with nested headings', async () => {
  const document = await normalize([
    '# 指南',
    '',
    '```md',
    '# 代码里的标题',
    '  原始缩进',
    '```',
    '',
    '| 字段 | 说明 |',
    '| --- | --- |',
    '| id | 标识 |',
    '',
    '> ## 引用里的标题',
    '>',
    '> 引用正文',
    '',
    '- ### 列表里的标题',
    '  列表正文',
    '',
    '## 下一节',
    '',
    '尾部正文',
  ].join('\n'))
  const sections = splitSections(document)
  assert.equal(sections.length, 2)
  const flat = nodes(sections[0].ast)
  for (const type of ['code', 'table', 'list', 'blockquote'])
    assert.deepEqual(flat.find(node => node.type === type), nodes(document.ast).find(node => node.type === type))
  assert.match(sections[0].markdown, /# 代码里的标题/)
  assert.equal(sections[1].text, '下一节\n\n尾部正文')
})

test('cross-section links, images and recursive footnotes retain their definitions', async () => {
  const document = await normalize([
    '# 开始',
    '',
    '[帮助][help] ![截图][image] 注释[^note]',
    '',
    '# 引用说明',
    '',
    '[help]: /help',
    '[image]: /image.png',
    '',
    '[^note]: 查看[帮助][help]，另见[^second]。',
    '',
    '[^second]: 回到[^note]。',
  ].join('\n'))
  const sections = splitSections(document)
  const flat = nodes(sections[0].ast)
  assert.deepEqual(flat.filter(node => node.type === 'definition').map(node => node.identifier), ['help', 'image'])
  assert.equal(flat.filter(node => node.type === 'footnoteDefinition').length, 2)
  assert.match(sections[0].markdown, /\[help\]: \/help/)
  assert.match(sections[0].markdown, /\[\^second\]:/)
  assert.equal(sections[0].ast.children[0].type, 'heading')
  assert.equal(sections[0].position.end.line, 3)
  assert.doesNotMatch(sections[0].text, /回到/)
  // 每节重新解析后仍然是链接引用，而非丢失定义后的普通括号文字。
  const reparsed = await normalize(sections[0].markdown)
  assert.ok(nodes(reparsed.ast).some(node => node.type === 'linkReference'))
  assert.equal(sections[1].position.start.line, 5)
})

test('split leaves input immutable and isolates AST, source and heading paths between sections', async () => {
  const document = freeze(await normalize('# 指南\n\n[帮助][help]\n\n## 子节\n\n[帮助][help]\n\n[help]: /help'))
  const sections = splitSections(document)
  sections[0].source.id = 'changed'
  sections[0].headingPath[0].title = 'changed'
  nodes(sections[0].ast).find(node => node.type === 'definition').url = '/changed'
  assert.equal(document.source.id, 'kb/guide.mdx')
  assert.equal(sections[1].source.id, 'kb/guide.mdx')
  assert.equal(sections[1].headingPath[0].title, '指南')
  assert.equal(nodes(sections[1].ast).find(node => node.type === 'definition').url, '/help')
  const noPositions = structuredClone(document)
  for (const node of nodes(noPositions.ast))
    delete node.position
  assert.ok(splitSections(noPositions).every(section => section.position === undefined))
})

test('invalid document and malformed heading fail with centralized error codes', async () => {
  const document = await normalize('# 指南')
  for (const input of [null, {}, { ...document, schemaVersion: 2 }, { ...document, source: { id: '' } }, { ...document, ast: { type: 'root' } }])
    assert.throws(() => splitSections(input), error => error instanceof AppError && error.code === 'SECTION_SPLIT_INVALID_DOCUMENT')
  document.ast.children[0].depth = 7
  assert.throws(() => splitSections(document), { code: 'SECTION_SPLIT_INVALID_DOCUMENT' })
})

test('frontmatter travels to sections as independent rule metadata', async () => {
  const document = await normalize('---\nproduct: Atlas\nversion: [v2]\ncustom: { flag: true }\n---\n# Parent\n\n## Child')
  const sections = splitSections(document)
  assert.deepEqual(sections[0].metadata, document.metadata)
  sections[0].metadata.version.push('v3')
  sections[0].metadata.custom.flag = false
  assert.deepEqual(document.metadata.version, ['v2'])
  assert.deepEqual(sections[1].metadata.version, ['v2'])
  assert.equal(sections[1].metadata.custom.flag, true)
})
