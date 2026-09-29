import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 验证构建后的公共模块组合。
import { buildChunks } from '../dist/rag/chunking/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 使用真实统一客户端验证向量响应。
import { EmbeddingClient } from '../dist/rag/embedding/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 规则字段仍由已有实现生成。
import { extractSectionData } from '../dist/rag/enrichment/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 测试双索引公共入口。
import { buildIndexDocuments, embedDualIndex } from '../dist/rag/indexing/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 从短文构造真实标准化文档。
import { NextraMdxAdapter } from '../dist/rag/normalization/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 使用真实 Section 切分。
import { splitSections } from '../dist/rag/sections/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证 Wiki 更新后的索引行为。
import { buildWiki, updateWiki } from '../dist/rag/wiki/index.js'

async function fixture(path = 'demo.mdx') {
  const document = await new NextraMdxAdapter().normalize({ source: { id: 'demo', path }, content: '---\ntitle: 接口指南\n---\n\n## 生产\n\nAtlas 使用 HTTPS。\n\n```js\nconst ready = true\n```\n\n## 测试\n\nAtlas 用于本地测试。' })
  const sections = splitSections(document)
  const inputs = sections.map((section, index) => ({ section, enrichedSection: {
    schemaVersion: 3,
    sectionId: section.id,
    sectionRevision: section.revision,
    documentId: section.documentId,
    extracted: extractSectionData(section),
    generation: { provider: 'stub', model: 'local', responseId: 'r1', usage: null },
    enrichment: {
      summary: '不要把整节摘要复制到所有节点',
      keywords: [],
      aliases: [],
      questions: [],
      knowledgeType: 'guide',
      entities: [{ id: 'e1', name: 'Atlas', type: 'product', aliases: ['示例产品'], description: index ? '仅用于本地测试的描述' : '生产环境的调用方', evidence: [index ? 'Atlas 用于本地测试。' : 'Atlas 使用 HTTPS。'] }],
      concepts: index ? [] : [{ id: 'c1', name: 'HTTPS', aliases: [], description: '生产协议', evidence: ['Atlas 使用 HTTPS。'] }],
      relations: index ? [] : [{ sourceId: 'e1', targetId: 'c1', type: 'uses', description: '使用协议', evidence: ['Atlas 使用 HTTPS。'] }],
      facts: index ? [] : [{ statement: 'Atlas 使用 HTTPS', nodeIds: ['e1', 'c1'], evidence: ['Atlas 使用 HTTPS。'] }],
    },
  } }))
  const options = { knowledgeBaseId: 'demo-kb', canonicalNodes: [{ id: 'atlas', kind: 'entity', title: 'Atlas' }], mappings: sections.map(section => ({ sectionId: section.id, sectionRevision: section.revision, localNodeId: 'e1', canonicalId: 'atlas' })) }
  const chunks = sections.flatMap(section => buildChunks(section).chunks)
  return { document, sections, inputs, options, chunks, wiki: buildWiki(inputs, options) }
}

function stubClient(handler) {
  const calls = []
  const client = new EmbeddingClient([{ provider: 'stub', async embed(request) {
    calls.push(request)
    const response = { provider: 'stub', model: request.model, dimensions: 3, embeddings: request.input.map((_, index) => [calls.length, index, 0.5]), usage: { inputTokens: request.input.length, totalTokens: request.input.length } }
    return handler ? handler(request, response, calls) : response
  } }])
  return { client, calls }
}
const config = { provider: 'stub', model: 'vectors', batchSize: 2 }

test('two indexes retain complete original chunks and select only current section knowledge', async () => {
  const fixtureData = await fixture()
  const original = structuredClone(fixtureData)
  const result = buildIndexDocuments(fixtureData)
  assert.equal(result.chunks.length, 2)
  assert.equal(result.wikiNodes.length, 2)
  const first = result.chunks[0]
  assert.ok(first.embeddingText.includes(fixtureData.chunks[0].markdown))
  assert.ok(first.embeddingText.includes('const ready = true'))
  assert.ok(first.embeddingText.includes('别名：示例产品'))
  assert.ok(first.embeddingText.includes('生产环境的调用方'))
  assert.ok(!first.embeddingText.includes('仅用于本地测试的描述'))
  assert.ok(!first.embeddingText.includes('不要把整节摘要'))
  assert.ok(!first.embeddingText.includes('demo.mdx'))
  assert.equal(first.sources[0].sectionRevision, fixtureData.sections[0].revision)
  const atlas = result.wikiNodes.find(item => item.title === 'Atlas')
  assert.equal(atlas.sources.length, 2)
  assert.ok(atlas.embeddingText.includes('仅用于本地测试的描述'))
  assert.ok(atlas.embeddingText.includes('Atlas → HTTPS（uses）：使用协议'))
  assert.ok(atlas.embeddingText.includes('事实：\nAtlas 使用 HTTPS'))
  assert.ok(!atlas.embeddingText.includes('wiki-node-'))
  assert.ok(!atlas.embeddingText.includes('Section：'))
  assert.deepEqual(fixtureData, original)
  const reordered = structuredClone(fixtureData)
  for (const node of reordered.wiki.nodes)
    node.descriptions.reverse()
  assert.deepEqual(buildIndexDocuments(reordered), result)
})

test('text fingerprints track semantic changes but ignore source-only changes', async () => {
  const data = await fixture()
  const before = buildIndexDocuments(data)
  const relocated = await fixture('moved.mdx')
  const moved = buildIndexDocuments(relocated)
  for (const [a, b] of [[before.chunks, moved.chunks], [before.wikiNodes, moved.wikiNodes]]) {
    assert.deepEqual(a.map(item => [item.id, item.textRevision]), b.map(item => [item.id, item.textRevision]))
    assert.ok(b.every(item => item.sources.every(source => source.sourcePath === 'moved.mdx')))
  }
  data.inputs[0].enrichedSection.enrichment.entities[0].description = '更新后的生产调用方描述'
  const changed = buildIndexDocuments({ ...data, wiki: buildWiki(data.inputs, data.options) })
  assert.equal(changed.chunks[0].id, before.chunks[0].id)
  assert.notEqual(changed.chunks[0].textRevision, before.chunks[0].textRevision)
  assert.equal(changed.chunks[1].textRevision, before.chunks[1].textRevision)
  const a = before.wikiNodes.find(item => item.title === 'Atlas')
  const b = changed.wikiNodes.find(item => item.title === 'Atlas')
  assert.equal(a.id, b.id)
  assert.notEqual(a.textRevision, b.textRevision)
  const otherKb = buildIndexDocuments({ ...data, wiki: buildWiki(data.inputs, { ...data.options, knowledgeBaseId: 'another-kb' }) })
  assert.notEqual(otherKb.chunks[0].id, before.chunks[0].id)
})

test('pending and unavailable knowledge keep original text; stale revisions fail', async () => {
  const data = await fixture()
  const [section] = data.sections
  const options = { ...data.options, mappings: data.options.mappings.filter(item => item.sectionId !== section.id) }
  const wiki = updateWiki(data.wiki, { inputs: [], removedSectionIds: [], pendingSections: [section] }, options)
  const result = buildIndexDocuments({ chunks: data.chunks, wiki })
  assert.equal(result.chunks[0].knowledgeStatus, 'pending')
  assert.equal(result.chunks[0].wikiNodes.length, 0)
  assert.ok(!result.chunks[0].embeddingText.includes('生产环境的调用方'))
  assert.ok(result.chunks[0].embeddingText.includes(data.chunks[0].markdown))
  assert.equal(result.wikiNodes.length, 1)
  assert.ok(!result.wikiNodes[0].embeddingText.includes('生产环境的调用方'))
  const unavailable = buildIndexDocuments({ chunks: data.chunks, wiki: buildWiki([], { knowledgeBaseId: 'demo-kb', canonicalNodes: [], mappings: [] }) })
  assert.equal(unavailable.wikiNodes.length, 0)
  assert.ok(unavailable.chunks.every(item => item.knowledgeStatus === 'unavailable'))
  data.chunks[0].sectionRevision = 'stale'
  for (const snapshot of [data.wiki, wiki])
    assert.throws(() => buildIndexDocuments({ chunks: data.chunks, wiki: snapshot }), { code: 'INDEXING_STALE_SOURCE' })
})

test('duplicate identities, dangling links, stale citations and wrong source documents are rejected', async () => {
  const original = await fixture()
  for (const mutate of [
    data => data.chunks.push(data.chunks[0]),
    data => data.wiki.nodes.push(data.wiki.nodes[0]),
    data => data.wiki.sectionLinks[0].nodeIds.push('missing'),
    data => data.wiki.nodes[0].descriptions[0].citations[0].sectionRevision = 'stale',
    data => data.wiki.edges[0].targetId = 'missing',
    data => data.wiki.pendingSections.push({ sectionId: data.sections[0].id, sectionRevision: data.sections[0].revision }),
  ]) {
    const changed = structuredClone(original)
    mutate(changed)
    assert.throws(() => buildIndexDocuments(changed), { code: 'INDEXING_INVALID_INPUT' })
  }
  const changed = structuredClone(original)
  changed.chunks[0].documentId = 'another-document'
  assert.throws(() => buildIndexDocuments(changed), { code: 'INDEXING_STALE_SOURCE' })
})

test('budget counts complete embeddingText and never silently truncates source or knowledge', async () => {
  const data = await fixture()
  const result = buildIndexDocuments(data, { countTokens: text => text.length })
  const maximum = Math.max(...result.chunks.concat(result.wikiNodes).map(item => item.tokenCount))
  assert.deepEqual(buildIndexDocuments(data, { maxTokens: maximum, countTokens: text => text.length }).chunks, result.chunks)
  assert.throws(() => buildIndexDocuments(data, { maxTokens: maximum - 1, countTokens: text => text.length }), { code: 'INDEXING_INPUT_TOO_LARGE' })
  assert.throws(() => buildIndexDocuments(data, { maxTokens: 0 }), { code: 'INDEXING_INVALID_OPTIONS' })
  for (const countTokens of [() => -1, () => Number.NaN, () => {
    throw new Error('private input')
  }])
    assert.throws(() => buildIndexDocuments(data, { countTokens }), { code: 'INDEXING_TOKEN_COUNT_FAILED' })
})

test('embedding preserves two index identities, batching order, vectors and usage', async () => {
  const input = buildIndexDocuments(await fixture())
  const { client, calls } = stubClient()
  const result = await embedDualIndex(input, client, config)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.flatMap(call => call.input), [...input.chunks, ...input.wikiNodes].map(item => item.embeddingText))
  assert.deepEqual(result.chunks.map(item => item.vector), [[1, 0, 0.5], [1, 1, 0.5]])
  assert.deepEqual(result.wikiNodes.map(item => item.vector), [[2, 0, 0.5], [2, 1, 0.5]])
  assert.equal(result.model, 'vectors')
  assert.equal(result.dimensions, 3)
  assert.deepEqual(result.usage, { inputTokens: 4, totalTokens: 4 })
  assert.equal(result.batches.length, 2)
  assert.deepEqual(result.chunks.map(item => item.sources), input.chunks.map(item => item.sources))
  const { client: secondClient } = stubClient()
  const differentModel = await embedDualIndex(input, secondClient, { ...config, model: 'another-space' })
  assert.notEqual(result.chunks[0].embeddingRevision, differentModel.chunks[0].embeddingRevision)
})

test('input snapshots remain isolated during asynchronous batches', async () => {
  const input = buildIndexDocuments(await fixture())
  const expected = structuredClone(input)
  const { client, calls } = stubClient((_request, response, requests) => {
    if (requests.length === 1) {
      input.wikiNodes[0].embeddingText = 'mutated'
      input.wikiNodes[0].sources[0].sourcePath = 'mutated-path'
    }
    return response
  })
  const result = await embedDualIndex(input, client, config)
  assert.equal(calls[1].input[0], expected.wikiNodes[0].embeddingText)
  assert.deepEqual(result.wikiNodes[0].sources, expected.wikiNodes[0].sources)
})

test('missing usage remains null, empty indexes make no calls and corrupt documents fail before calls', async () => {
  const input = buildIndexDocuments(await fixture())
  const { client, calls } = stubClient((_request, response, requests) => ({ ...response, usage: requests.length === 2 ? null : response.usage }))
  const result = await embedDualIndex(input, client, config)
  assert.equal(result.usage, null)
  assert.deepEqual(result.batches[0].usage, { inputTokens: 2, totalTokens: 2 })
  const empty = buildIndexDocuments({ chunks: [], wiki: buildWiki([], { knowledgeBaseId: 'empty', canonicalNodes: [], mappings: [] }) })
  const resultEmpty = await embedDualIndex(empty, client, config)
  assert.equal(calls.length, 2)
  assert.equal(resultEmpty.model, null)
  assert.equal(resultEmpty.dimensions, null)
  assert.equal(resultEmpty.usage, null)
  input.chunks[0].embeddingText += 'tampered'
  await assert.rejects(embedDualIndex(input, client, config), { code: 'INDEXING_INVALID_INPUT' })
  assert.equal(calls.length, 2)
})

test('model or dimension drift, provider failure and cancellation cannot produce partial indexes', async () => {
  const input = buildIndexDocuments(await fixture())
  for (const change of [
    response => ({ ...response, model: 'different-actual-model' }),
    response => ({ ...response, dimensions: 2, embeddings: response.embeddings.map(vector => vector.slice(0, 2)) }),
  ]) {
    const { client } = stubClient((_request, response, calls) => calls.length === 2 ? change(response) : response)
    await assert.rejects(embedDualIndex(input, client, config), { code: 'INDEXING_INCONSISTENT_SPACE' })
  }
  const { client: failing } = stubClient((_request, response, calls) => {
    if (calls.length === 2)
      throw new Error('upstream body must not escape')
    return response
  })
  await assert.rejects(embedDualIndex(input, failing, config), { code: 'EMBEDDING_PROVIDER_ERROR' })
  const controller = new AbortController()
  const { client, calls } = stubClient((_request, response) => {
    controller.abort()
    return response
  })
  await assert.rejects(embedDualIndex(input, client, { ...config, signal: controller.signal }), { code: 'EMBEDDING_ABORTED' })
  assert.equal(calls.length, 1)
  await assert.rejects(embedDualIndex(input, client, { ...config, signal: AbortSignal.abort() }), { code: 'EMBEDDING_ABORTED' })
  assert.equal(calls.length, 1)
  await assert.rejects(embedDualIndex(input, client, { ...config, batchSize: 0 }), { code: 'INDEXING_INVALID_OPTIONS' })
})
