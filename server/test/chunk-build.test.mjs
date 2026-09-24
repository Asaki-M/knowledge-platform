import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled shared exception identity.
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the public section-to-chunk API.
import { buildChunks, countChunkTokens, splitSections } from '../dist/rag/chunking/index.js'
// eslint-disable-next-line antfu/no-import-dist -- Rules produce the current enrichment input contract.
import { extractSectionData } from '../dist/rag/enrichment/index.js'
// eslint-disable-next-line antfu/no-import-dist -- Project original and reconstructed AST content independently.
import { plainText } from '../dist/rag/markdown.js'

// eslint-disable-next-line antfu/no-import-dist -- Exercise actual normalization before building chunks.
import { NextraMdxAdapter, NormalizationClient } from '../dist/rag/normalization/index.js'

const normalization = new NormalizationClient([new NextraMdxAdapter()])
async function input(content) {
  const document = await normalization.normalize({ adapter: 'nextra-mdx', source: { id: 'kb/doc', path: 'doc.mdx' }, content })
  const section = splitSections(document)[0]
  // Chunk Build 不调用模型；此处使用符合已校验 EnrichedSection 契约的固定测试结果。
  const enrichment = {
    schemaVersion: 2,
    sectionId: section.id,
    source: { ...section.source },
    extracted: extractSectionData(section),
    enrichment: { summary: '测试摘要', keywords: ['测试'], aliases: [], questions: [], entities: [], concepts: [], relations: [], facts: [], knowledgeType: 'guide' },
    generation: { provider: 'test', model: 'test', responseId: 'r1', usage: null },
  }
  return { section, enrichment }
}

const characterCount = value => Array.from(value).length
function nodes(tree) {
  return [tree, ...(tree.children ?? []).flatMap(nodes)]
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}

function withinBudget(result, counter) {
  for (const chunk of result.chunks) {
    assert.equal(chunk.tokenCount, counter(chunk.markdown))
    assert.equal(chunk.oversized, chunk.tokenCount > result.maxTokens)
    assert.equal(chunk.oversized, false)
  }
}

test('default tokenizer and paragraph fragmentation preserve Unicode and formatting under the full Markdown budget', async () => {
  const text = '中文说明与 👨‍👩‍👧‍👦 emoji，保留每一个字符。'.repeat(35)
  const { section, enrichment } = await input(`# 标题\n\n**${text}**`)
  const result = buildChunks(section, enrichment, { maxTokens: 100 })
  assert.equal(result.tokenizer, 'cl100k_base')
  assert.ok(result.chunks.length > 1)
  withinBudget(result, countChunkTokens)
  const paragraphs = result.chunks.flatMap(chunk => chunk.ast.children.filter(node => node.type === 'paragraph'))
  assert.equal(paragraphs.map(plainText).join(''), text)
  assert.ok(paragraphs.every(node => node.children.every(child => child.type === 'strong')))
  assert.equal(JSON.stringify(result).includes('�'), false)
  const parts = result.chunks.flatMap(chunk => chunk.parts)
  assert.equal(parts[0].range.start, 0)
  assert.equal(parts.at(-1).range.end, text.length)
  assert.ok(parts.every(part => part.position.start.line === 3 && part.range.kind === 'text'))
  assert.ok(paragraphs.every(node => node.position === undefined))
  assert.ok(countChunkTokens('<|endoftext|>') > 0)
})

test('code splits by complete lines, tables repeat headers and ordered lists retain numbering', async () => {
  const code = Array.from({ length: 12 }, (_, index) => `const value${index} = ${index}`).join('\n')
  const tableRows = Array.from({ length: 10 }, (_, index) => `| row${index} | 说明${index} |`).join('\n')
  const list = Array.from({ length: 10 }, (_, index) => `${index + 3}. item-${index} description`).join('\n')
  const { section, enrichment } = await input(`# 标题\n\n\`\`\`ts title="demo"\n${code}\n\`\`\`\n\n| 字段 | 说明 |\n| --- | --- |\n${tableRows}\n\n${list}`)
  const result = buildChunks(section, enrichment, { maxTokens: 140, countTokens: characterCount })
  withinBudget(result, characterCount)
  const output = result.chunks.flatMap(chunk => chunk.ast.children)
  const codes = output.filter(node => node.type === 'code')
  assert.ok(codes.length > 1)
  assert.equal(codes.map(node => node.value).join('\n'), code)
  assert.ok(codes.every(node => node.lang === 'ts' && node.meta === 'title="demo"'))
  const tables = output.filter(node => node.type === 'table')
  assert.ok(tables.length > 1)
  assert.deepEqual(tables.flatMap(node => node.children.slice(1).map(plainText)), section.ast.children.find(node => node.type === 'table').children.slice(1).map(plainText))
  assert.ok(tables.every(node => plainText(node.children[0]) === '字段\t说明'))
  const lists = output.filter(node => node.type === 'list')
  let expectedStart = 3
  for (const node of lists) {
    assert.equal(node.start, expectedStart)
    expectedStart += node.children.length
  }
  assert.equal(expectedStart, 13)
})

test('overlap repeats only labeled trailing parts and never loses new content or exceeds the budget', async () => {
  const { section, enrichment } = await input(`# Heading\n\n${Array.from({ length: 8 }, (_, index) => `Paragraph ${index} with detail.`).join('\n\n')}`)
  const result = buildChunks(section, enrichment, { maxTokens: 100, overlapTokens: 30, countTokens: characterCount })
  withinBudget(result, characterCount)
  assert.ok(result.chunks.length > 1)
  assert.ok(result.chunks.slice(1).some(chunk => chunk.parts.some(part => part.overlap)))
  assert.ok(result.chunks.every(chunk => chunk.parts.some(part => !part.overlap)))
  const newParts = result.chunks.flatMap(chunk => chunk.parts.filter(part => !part.overlap))
  assert.deepEqual(newParts.map(part => part.blockIndex), [1, 2, 3, 4, 5, 6, 7, 8])
  for (const [index, chunk] of result.chunks.entries()) {
    assert.equal(chunk.index, index)
    assert.equal(chunk.sectionId, section.id)
    assert.ok(chunk.ast.children[0].type === 'heading')
  }
})

test('reference definitions are restored in each chunk and included in the token budget', async () => {
  const { section, enrichment } = await input('# 标题\n\n[帮助][help] 的第一段说明。\n\n[帮助][help] 的第二段说明。\n\n[help]: https://example.test/help')
  const result = buildChunks(section, enrichment, { maxTokens: characterCount(section.markdown) - 1, countTokens: characterCount })
  withinBudget(result, characterCount)
  assert.equal(result.chunks.length, 2)
  for (const chunk of result.chunks) {
    assert.ok(chunk.ast.children.some(node => node.type === 'definition' && node.url === 'https://example.test/help'))
    const reparsed = await normalization.normalize({ adapter: 'nextra-mdx', source: { id: 'chunk' }, content: chunk.markdown })
    assert.ok(nodes(reparsed.ast).some(node => node.type === 'linkReference'))
  }
})

test('indivisible content and oversized headings are explicit, with an optional strict failure policy', async () => {
  const longLine = 'x'.repeat(200)
  for (const content of [`# Title\n\n\`\`\`txt\n${longLine}\n\`\`\``, `# ${longLine}\n\n正文`, `# Title\n\n| Key | Value |\n| --- | --- |\n| a | ${longLine} |`, `# Title\n\n1. ${longLine}`]) {
    const { section, enrichment } = await input(content)
    const config = { maxTokens: 50, countTokens: characterCount }
    const result = buildChunks(section, enrichment, config)
    assert.ok(result.chunks.some(chunk => chunk.oversized))
    assert.ok(result.chunks.some(chunk => chunk.markdown.includes(longLine)))
    assert.throws(() => buildChunks(section, enrichment, { ...config, oversized: 'error' }), { code: 'CHUNK_BUILD_OVERSIZED_CONTENT' })
  }
})

test('build is deterministic, keeps enrichment scoped to the section and isolates returned objects', async () => {
  const { section, enrichment } = await input('# Title\n\n第一段正文。\n\n第二段正文。')
  freeze(section)
  freeze(enrichment)
  const options = { maxTokens: 23, countTokens: characterCount }
  const result = buildChunks(section, enrichment, options)
  assert.deepEqual(buildChunks(section, enrichment, options), result)
  assert.deepEqual(result.sectionEnrichment, enrichment)
  assert.ok(result.chunks.length > 1)
  result.sectionEnrichment.enrichment.keywords.push('new')
  result.chunks[0].headingPath[0].title = 'changed'
  result.chunks[0].source.id = 'changed'
  result.chunks[0].ast.children[0].children[0].value = 'changed'
  assert.deepEqual(enrichment.enrichment.keywords, ['测试'])
  assert.equal(result.chunks[1].headingPath[0].title, 'Title')
  assert.equal(result.chunks[1].source.id, section.source.id)
  assert.equal(section.ast.children[0].children[0].value, 'Title')
})

test('heading-only and empty sections do not invent body content', async () => {
  const { section, enrichment } = await input('# 仅标题')
  const result = buildChunks(section, enrichment)
  assert.equal(result.chunks.length, 1)
  assert.deepEqual(result.chunks[0].parts, [])
  assert.equal(result.chunks[0].text, '仅标题')
  const empty = { ...section, ast: { type: 'root', children: [] } }
  assert.deepEqual(buildChunks(empty, enrichment).chunks, [])
})

test('invalid options, mismatched enrichment and broken counters fail as AppError without leaking content', async () => {
  const { section, enrichment } = await input('# Title\n\n正文')
  for (const options of [null, { maxTokens: 0 }, { maxTokens: 1.5 }, { overlapTokens: -1 }, { maxTokens: 10, overlapTokens: 10 }, { oversized: 'drop' }, { countTokens: 3 }])
    assert.throws(() => buildChunks(section, enrichment, options), error => error instanceof AppError && error.code === 'CHUNK_BUILD_INVALID_OPTIONS')
  assert.throws(() => buildChunks(section, { ...enrichment, sectionId: 'other' }), { code: 'CHUNK_BUILD_INVALID_INPUT' })
  assert.throws(() => buildChunks(section, { ...enrichment, schemaVersion: 1 }), { code: 'CHUNK_BUILD_INVALID_INPUT' })
  assert.throws(() => buildChunks(section, { ...enrichment, extracted: undefined }), { code: 'CHUNK_BUILD_INVALID_INPUT' })
  assert.throws(() => buildChunks(section, { ...enrichment, source: { id: 'other' } }), { code: 'CHUNK_BUILD_INVALID_INPUT' })
  assert.throws(() => buildChunks(null, enrichment), { code: 'CHUNK_BUILD_INVALID_INPUT' })
  for (const countTokens of [() => -1, () => Number.NaN, () => 1.5, () => {
    throw new Error('private-content')
  }])
    assert.throws(() => buildChunks(section, enrichment, { countTokens }), error => error instanceof AppError && error.code === 'CHUNK_BUILD_TOKEN_COUNT_FAILED' && !error.message.includes('private-content'))
})
