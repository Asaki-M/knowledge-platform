import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 使用真实规则投影构造内存提取结果。
import { extractSectionData } from '../dist/rag/enrichment/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 本地构造标准化的来源快照，无服务调用。
import { NextraMdxAdapter } from '../dist/rag/normalization/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 构造 Section 测试输入。
import { splitSections } from '../dist/rag/sections/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 单测新的聚合与增量公共接口。
import { buildWiki, getWikiNodesForSection, updateWiki } from '../dist/rag/wiki/index.js'

const text = 'Atlas 调用 Gateway。生产环境使用 HTTPS。'
async function input(documentId, content = text, path = `${documentId}.mdx`) {
  const document = await new NextraMdxAdapter().normalize({ source: { id: documentId, path }, content: `# 接口\n\n${content}` })
  const [section] = splitSections(document)
  return { section, enrichedSection: {
    schemaVersion: 3,
    sectionId: section.id,
    documentId,
    sectionRevision: section.revision,
    extracted: extractSectionData(section),
    generation: { provider: 'stub', model: 'local', responseId: 'r1', usage: null },
    enrichment: { summary: '不得复制到所有节点的整节摘要', keywords: [], aliases: [], questions: [], knowledgeType: 'guide', entities: [
      { id: 'e1', name: 'Atlas', type: 'product', aliases: [], description: '调用方', evidence: ['Atlas 调用 Gateway。'] },
      { id: 'e2', name: 'Gateway', type: 'service', aliases: [], description: '被调用方', evidence: ['Atlas 调用 Gateway。'] },
    ], concepts: [{ id: 'c1', name: 'HTTPS', aliases: [], description: '生产协议', evidence: ['生产环境使用 HTTPS。'] }], relations: [
      { sourceId: 'e1', targetId: 'e2', type: 'calls', description: '调用服务', evidence: ['Atlas 调用 Gateway。'] },
      { sourceId: 'e1', targetId: 'c1', type: 'uses', description: '生产环境协议', evidence: ['生产环境使用 HTTPS。'] },
    ], facts: [{ statement: '生产环境使用 HTTPS', nodeIds: ['c1'], evidence: ['生产环境使用 HTTPS。'] }] },
  } }
}
function options(inputs = [], merge = true) {
  return { knowledgeBaseId: 'kb', canonicalNodes: merge ? [{ id: 'atlas', kind: 'entity', title: 'Atlas' }, { id: 'https', kind: 'concept', title: 'HTTPS' }] : [], mappings: merge ? inputs.flatMap(({ section }) => ['e1', 'c1'].map(localNodeId => ({ sectionId: section.id, sectionRevision: section.revision, localNodeId, canonicalId: localNodeId === 'e1' ? 'atlas' : 'https' }))) : [] }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}

test('explicit identity mappings aggregate multiple sections with attributed entity/concept relationships', async () => {
  const inputs = [await input('doc-a'), await input('doc-b')]
  const before = structuredClone(inputs)
  const config = options(inputs)
  const wiki = buildWiki(freeze(inputs), freeze(config))
  assert.equal(wiki.schemaVersion, 2)
  assert.equal(wiki.nodes.length, 4)
  const atlas = wiki.nodes.find(node => node.canonicalId === 'atlas')
  const https = wiki.nodes.find(node => node.canonicalId === 'https')
  assert.equal(atlas.sectionIds.length, 2)
  assert.equal(atlas.descriptions.length, 1)
  assert.equal(atlas.descriptions[0].citations.length, 2)
  assert.equal(atlas.facts.length, 0)
  assert.equal(https.kind, 'concept')
  assert.equal(https.facts[0].citations.length, 2)
  assert.equal(wiki.edges.filter(edge => edge.type === 'uses').length, 1)
  assert.equal(wiki.edges.find(edge => edge.type === 'uses').citations.length, 2)
  assert.ok(wiki.edges.every(edge => wiki.nodes.some(node => node.id === edge.sourceId) && wiki.nodes.some(node => node.id === edge.targetId)))
  for (const node of wiki.nodes) {
    assert.ok(!node.markdown.includes('不得复制'))
    assert.ok(node.markdown.includes('Section：'))
    assert.ok(node.markdown.includes('版本：'))
  }
  assert.deepEqual(buildWiki([...inputs].reverse(), { ...config, mappings: [...config.mappings].reverse() }), wiki)
  assert.deepEqual(inputs, before)
  assert.equal(getWikiNodesForSection(wiki, inputs[0].section.id, inputs[0].section.revision).length, 3)
  assert.throws(() => getWikiNodesForSection(wiki, inputs[0].section.id, 'stale'), { code: 'WIKI_INVALID_ASSOCIATION' })
})

test('unmapped same names remain distinct and empty or semantic-empty inputs are valid', async () => {
  const inputs = [await input('doc-a'), await input('doc-b')]
  assert.equal(buildWiki(inputs, options([], false)).nodes.length, 6)
  assert.deepEqual(buildWiki([], options([], false)).nodes, [])
  const empty = await input('empty')
  Object.assign(empty.enrichedSection.enrichment, { entities: [], concepts: [], relations: [], facts: [] })
  const wiki = buildWiki([empty], options([], false))
  assert.equal(wiki.nodes.length, 0)
  assert.equal(wiki.contributions.length, 1)
  assert.deepEqual(wiki.sectionLinks[0].nodeIds, [])
})

test('stale enrichment, malformed evidence, conflicting mappings and old versions fail explicitly', async () => {
  const original = await input('doc-a')
  for (const change of [
    item => item.enrichedSection.sectionRevision = 'stale',
    item => item.enrichedSection.schemaVersion = 2,
    item => item.enrichedSection.documentId = 'wrong',
    item => item.enrichedSection.extracted.metadata = { stale: true },
    item => item.enrichedSection.enrichment.concepts[0].evidence = ['private-missing-quote'],
    item => item.enrichedSection.enrichment.relations[0].targetId = 'absent',
    item => item.section.markdown += 'private-tamper',
  ]) {
    const item = structuredClone(original)
    change(item)
    assert.throws(() => buildWiki([item], options([item])), error => error.code === 'WIKI_INVALID_INPUT' && !error.message.includes('private-'))
  }
  assert.throws(() => buildWiki([original, original], options([original])), { code: 'WIKI_INVALID_INPUT' })
  for (const change of [
    config => config.mappings.push({ ...config.mappings[0] }),
    config => config.mappings[0].sectionRevision = 'stale',
    config => config.mappings[0].localNodeId = 'unknown',
    config => config.mappings[0].canonicalId = 'missing',
    config => config.canonicalNodes[0].kind = 'concept',
    config => config.canonicalNodes.push({ ...config.canonicalNodes[0] }),
  ]) {
    const config = options([original])
    change(config)
    assert.throws(() => buildWiki([original], config), { code: 'WIKI_INVALID_MAPPING' })
  }
})

test('one section update equals full rebuild and preserves unrelated node revisions', async () => {
  const a = await input('doc-a')
  const b = await input('doc-b')
  const wiki = buildWiki([a, b], options([a, b]))
  const changed = await input('doc-a', `${text}\n\n新说明。`)
  changed.enrichedSection.enrichment.entities[0].description = '有新说明的调用方'
  const result = updateWiki(freeze(wiki), { inputs: [changed], removedSectionIds: [] }, options([changed, b]))
  assert.deepEqual(result, buildWiki([changed, b], options([changed, b])))
  const gateway = wiki.nodes.find(node => node.title === 'Gateway' && node.sectionIds.includes(b.section.id))
  assert.deepEqual(result.nodes.find(node => node.id === gateway.id), gateway)
  const unchangedEdge = wiki.edges.find(edge => edge.targetId === gateway.id)
  assert.deepEqual(result.edges.find(edge => edge.id === unchangedEdge.id), unchangedEdge)
  const atlas = result.nodes.find(node => node.canonicalId === 'atlas')
  assert.equal(atlas.descriptions.length, 2)
  assert.equal(atlas.id, wiki.nodes.find(node => node.canonicalId === 'atlas').id)
})

test('delete removes only its contribution and orphan nodes/edges disappear', async () => {
  const a = await input('doc-a')
  const b = await input('doc-b')
  const wiki = buildWiki([a, b], options([a, b]))
  const result = updateWiki(wiki, { inputs: [], removedSectionIds: [a.section.id] }, options([b]))
  assert.deepEqual(result, buildWiki([b], options([b])))
  assert.ok(result.nodes.every(node => !node.sectionIds.includes(a.section.id)))
  const empty = updateWiki(result, { inputs: [], removedSectionIds: [b.section.id] }, options())
  assert.deepEqual(empty, buildWiki([], options()))
})

test('pending sections revoke stale knowledge until new enrichment arrives', async () => {
  const old = await input('doc-a')
  const fresh = await input('doc-a', `${text}\n\n变化。`)
  const wiki = buildWiki([old], options([old]))
  const pending = updateWiki(wiki, { inputs: [], removedSectionIds: [], pendingSections: [fresh.section] }, options())
  assert.deepEqual(pending.nodes, [])
  assert.deepEqual(pending.edges, [])
  assert.deepEqual(pending.pendingSections, [{ sectionId: fresh.section.id, sectionRevision: fresh.section.revision }])
  assert.deepEqual(getWikiNodesForSection(pending, fresh.section.id, fresh.section.revision), [])
  assert.deepEqual(updateWiki(pending, { inputs: [fresh], removedSectionIds: [] }, options([fresh])), buildWiki([fresh], options([fresh])))
  assert.throws(() => updateWiki(wiki, { inputs: [fresh], removedSectionIds: [fresh.section.id] }, options([fresh])), { code: 'WIKI_INVALID_INPUT' })
})

test('identity changes move contributions between nodes without new section extraction', async () => {
  const a = await input('doc-a')
  const b = await input('doc-b')
  const old = buildWiki([a, b], options([a, b]))
  const config = options([a, b])
  config.canonicalNodes.push({ id: 'atlas-other', kind: 'entity', title: '另一个 Atlas' })
  config.mappings.find(mapping => mapping.sectionId === a.section.id && mapping.localNodeId === 'e1').canonicalId = 'atlas-other'
  const result = updateWiki(old, { inputs: [], removedSectionIds: [] }, config)
  assert.deepEqual(result, buildWiki([a, b], config))
  assert.equal(result.nodes.find(node => node.canonicalId === 'atlas').sectionIds.length, 1)
  assert.equal(result.nodes.find(node => node.canonicalId === 'atlas-other').sectionIds.length, 1)
})

test('source-only refresh updates citations without changing section revision or needing enrichment', async () => {
  const a = await input('doc-a')
  const moved = await input('doc-a', text, 'new/location.mdx')
  assert.equal(a.section.revision, moved.section.revision)
  const result = updateWiki(buildWiki([a], options([a])), { inputs: [], removedSectionIds: [], sourceUpdates: [moved.section] }, options([moved]))
  assert.deepEqual(result, buildWiki([moved], options([moved])))
  assert.ok(result.nodes.every(node => node.markdown.includes('new/location.mdx')))
})

test('model descriptions are escaped and contradictory claims remain separate with their own evidence', async () => {
  const a = await input('doc-a')
  const b = await input('doc-b')
  a.enrichedSection.enrichment.entities[0].description = '<script>alert(1)</script>\n# 伪造标题'
  b.enrichedSection.enrichment.facts[0].statement = '不同陈述，不按语义合并'
  const wiki = buildWiki([a, b], options([a, b]))
  const atlas = wiki.nodes.find(node => node.canonicalId === 'atlas')
  assert.ok(!atlas.markdown.includes('\n# 伪造标题'))
  assert.ok(atlas.markdown.includes('\\<script>'))
  assert.equal(wiki.nodes.find(node => node.canonicalId === 'https').facts.length, 2)
})

test('a late response for an old section revision cannot replace pending knowledge', async () => {
  const old = await input('doc-a')
  const fresh = await input('doc-a', `${text}\n\n新内容。`)
  const waiting = updateWiki(buildWiki([old], options([old])), { inputs: [], removedSectionIds: [], pendingSections: [fresh.section] }, options())
  assert.throws(() => updateWiki(waiting, { inputs: [old], removedSectionIds: [] }, options([old])), { code: 'WIKI_INVALID_INPUT' })
  assert.deepEqual(waiting.nodes, [])
})
