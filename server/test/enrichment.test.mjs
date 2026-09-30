import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- Verify the compiled pipeline and shared error contract.
import { AppError } from '../dist/errors.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the real LlmClient with SDK or local adapters.
import { LlmClient } from '../dist/llm/index.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the public enrichment API.
import { DEFAULT_KNOWLEDGE_TYPES, extractSectionData, KnowledgeEnricher } from '../dist/rag/enrichment/index.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled public pipeline.
import { NextraMdxAdapter, NormalizationClient } from '../dist/rag/normalization/index.js'
// eslint-disable-next-line antfu/no-import-dist -- Exercise the compiled public pipeline.
import { splitSections } from '../dist/rag/sections/index.js'

const markdown = '# Atlas 接口\n\nAtlas 调用 Gateway。\n\n生产环境必须使用 HTTPS。\n\n支持 Linux，版本 v2，示例使用 Go。'
const normalized = await new NormalizationClient([new NextraMdxAdapter()]).normalize({ adapter: 'nextra-mdx', source: { id: 'kb/atlas', path: 'private/local/path.mdx' }, content: markdown })
const section = splitSections(normalized)[0]
const options = { provider: 'test', model: 'test-model' }

function enrichment() {
  return {
    summary: 'Atlas 调用 Gateway，生产环境要求 HTTPS。',
    keywords: ['Atlas', 'HTTPS', 'HTTPS'],
    aliases: [],
    questions: ['Atlas 在生产环境使用什么协议？'],
    entities: [
      { id: 'e1', name: 'Atlas', type: 'product', aliases: [], description: '调用 Gateway 的产品', evidence: ['Atlas 调用 Gateway。'] },
      { id: 'e2', name: 'Gateway', type: 'service', aliases: [], description: '被 Atlas 调用的服务', evidence: ['Atlas 调用 Gateway。'] },
    ],
    concepts: [{ id: 'c1', name: 'HTTPS', aliases: [], description: '生产环境协议要求', evidence: ['生产环境必须使用 HTTPS。'] }],
    relations: [{ sourceId: 'e1', targetId: 'e2', type: 'calls', description: 'Atlas 调用 Gateway', evidence: ['Atlas 调用 Gateway。'] }],
    facts: [{ statement: 'Atlas 调用 Gateway', nodeIds: ['e1', 'e2'], evidence: ['Atlas 调用 Gateway。'] }],
    knowledgeType: 'security-rule',
  }
}

function response(value = enrichment(), overrides = {}) {
  return { id: 'r1', provider: 'test', model: 'actual-model', text: JSON.stringify(value), usage: null, finishReason: 'stop', ...overrides }
}

function create(generate, config = {}) {
  return new KnowledgeEnricher(new LlmClient([{ provider: 'test', generate }]), { ...options, ...config })
}

test('enrichment uses an in-memory model and binds output to the section revision', async () => {
  let request
  const before = structuredClone(section)
  const result = await create(async (input) => {
    request = input
    return response()
  }).enrich(section)
  assert.equal(request.model, 'test-model')
  assert.deepEqual(request.messages.map(message => message.role), ['system', 'user'])
  assert.equal(JSON.parse(request.messages[1].content).markdown, section.markdown)
  assert.equal(JSON.stringify(request).includes('private/local/path.mdx'), false)
  assert.equal(JSON.stringify(request).includes(section.id), false)
  assert.equal(result.schemaVersion, 3)
  assert.equal(result.documentId, section.documentId)
  assert.equal(result.sectionRevision, section.revision)
  assert.deepEqual(result.extracted, extractSectionData(section))
  assert.deepEqual(result.enrichment, { ...enrichment(), keywords: ['Atlas', 'HTTPS'] })
  assert.deepEqual(section, before)
})

test('knowledge type dictionary extends without changing adapters and rejects unregistered types', async () => {
  let prompt
  const config = { knowledgeTypes: { runbook: '值班操作手册' } }
  const value = { ...enrichment(), knowledgeType: 'runbook' }
  const enricher = create(async (input) => {
    prompt = input.messages[0].content
    return response(value)
  }, config)
  config.knowledgeTypes.runbook = 'changed-after-construction'
  const result = await enricher.enrich(section)
  assert.equal(result.enrichment.knowledgeType, 'runbook')
  assert.ok(prompt.includes('值班操作手册'))
  assert.ok(!prompt.includes('changed-after-construction'))
  assert.ok(Object.hasOwn(DEFAULT_KNOWLEDGE_TYPES, 'architecture'))
  await assert.rejects(create(async () => response(value)).enrich(section), { code: 'ENRICHMENT_INVALID_OUTPUT' })
})

test('missing semantic information uses empty arrays and rule metadata stays empty', async () => {
  const value = { summary: '一个简短概念说明', keywords: [], aliases: [], questions: [], entities: [], concepts: [], relations: [], facts: [], knowledgeType: 'other' }
  assert.deepEqual((await create(async () => response(value)).enrich(section)).enrichment, value)
})

test('invalid model schemas, entity links, categories and evidence fail without leaking output', async () => {
  const mutations = [
    value => delete value.summary,
    value => value.keywords = 'HTTPS',
    value => value.aliases = [42],
    value => value.summary = '',
    value => value.extra = 'secret-model-output',
    value => value.entities.push({ ...value.entities[0] }),
    value => value.relations[0].targetId = 'missing-entity',
    value => value.facts[0].nodeIds = ['missing-entity'],
    value => value.constraints = [],
    value => value.entities[0].evidence = ['secret-model-output'],
    value => value.relations[0].evidence = [],
    value => value.facts[0].evidence = ['不需要 HTTPS'],
    value => value.knowledgeType = 'constructor',
    value => value.metadata = { product: 'secret-model-output' },
    value => value.title = 'secret-model-output',
    value => value.links = [],
  ]
  for (const mutate of mutations) {
    const value = enrichment()
    mutate(value)
    await assert.rejects(create(async () => response(value)).enrich(section), error => error instanceof AppError && error.code === 'ENRICHMENT_INVALID_OUTPUT' && !error.message.includes('secret-model-output'))
  }
  for (const text of ['not JSON secret-model-output', 'null', '[]', `\`\`\`json\n${JSON.stringify(enrichment())}\n\`\`\``])
    await assert.rejects(create(async () => response(undefined, { text })).enrich(section), { code: 'ENRICHMENT_INVALID_OUTPUT' })
})

test('refusals and incomplete responses never become successful enrichment or get retried', async () => {
  let calls = 0
  for (const [finishReason, code] of [['length', 'ENRICHMENT_OUTPUT_TRUNCATED'], ['content_filter', 'ENRICHMENT_CONTENT_FILTERED'], ['unknown', 'ENRICHMENT_INCOMPLETE_RESPONSE'], ['refusal', 'ENRICHMENT_REFUSED']]) {
    const enricher = create(async () => {
      calls++
      return response(undefined, { finishReason })
    })
    await assert.rejects(enricher.enrich(section), { code })
  }
  assert.equal(calls, 4)
  await assert.rejects(create(async () => response(undefined, { refusal: 'private-refusal' })).enrich(section), { code: 'ENRICHMENT_REFUSED' })
})

test('invalid configuration, input size and pre-cancellation fail before invoking LLM', async () => {
  let calls = 0
  const generate = async () => {
    calls++
    return response()
  }
  for (const config of [{ model: '' }, { provider: '' }, { maxInputCharacters: 0 }, { maxOutputTokens: -1 }, { knowledgeTypes: { 'Bad Type': 'x' } }, { knowledgeTypes: { custom: '' } }])
    assert.throws(() => create(generate, config), { code: 'ENRICHMENT_CONFIGURATION_ERROR' })
  const enricher = create(generate)
  for (const input of [null, { ...section, markdown: '' }, { ...section, headingPath: [null] }, { ...section, documentId: '' }])
    await assert.rejects(enricher.enrich(input), { code: 'ENRICHMENT_INVALID_INPUT' })
  await assert.rejects(create(generate, { maxInputCharacters: 10 }).enrich(section), { code: 'ENRICHMENT_INPUT_TOO_LARGE' })
  await assert.rejects(enricher.enrich(section, { signal: AbortSignal.abort() }), { code: 'ABORTED' })
  assert.equal(calls, 0)
})

test('cancellation propagates; source snapshots and upstream AppErrors retain their semantics', async () => {
  const controller = new AbortController()
  await assert.rejects(create(async (input) => {
    assert.equal(input.signal, controller.signal)
    controller.abort()
    return response()
  }).enrich(section, { signal: controller.signal }), { code: 'ABORTED' })
  const mutable = structuredClone(section)
  const enricher = create(async () => {
    mutable.id = 'modified'
    mutable.documentId = 'modified'
    mutable.markdown = 'changed while awaiting'
    return response()
  })
  const result = await enricher.enrich(mutable)
  assert.equal(result.sectionId, section.id)
  assert.equal(result.documentId, section.documentId)
  const original = new AppError('RATE_LIMITED', 'Rate limited', { provider: 'test', status: 429, retryable: true, requestId: 'req_limit' })
  await assert.rejects(create(async () => {
    throw original
  }).enrich(section), error => error === original)
})

test('rules retain frontmatter, nested code and reference links before semantic generation', async () => {
  const doc = await new NormalizationClient([new NextraMdxAdapter()]).normalize({
    adapter: 'nextra-mdx',
    source: { id: 'private-id', path: '/private/document.mdx' },
    content: [
      '---',
      'product: Atlas',
      'version: [v2]',
      'custom: { enabled: true }',
      '---',
      '# Guide',
      '',
      '> ```ts title="sample"',
      '>   const value = 1',
      '> ```',
      '',
      '```ts title="sample"',
      '  const value = 1',
      '```',
      '',
      '[Help][DOC] [Help][doc] [Other label](/guide?a=1#part "Manual") ![Diagram][pic]',
      '',
      '## Definitions',
      '',
      '[doc]: /guide?a=1#part "Manual"',
      '[pic]: ./image.png',
      '[unused]: /never-linked',
    ].join('\n'),
  })
  const [input] = splitSections(doc)
  const before = structuredClone(input)
  const raw = extractSectionData(input)
  assert.equal(raw.title, 'Guide')
  assert.deepEqual(raw.metadata, { product: 'Atlas', version: ['v2'], custom: { enabled: true } })
  assert.equal(raw.codeBlocks.length, 2)
  assert.deepEqual(raw.codeBlocks[0], { language: 'ts', meta: 'title="sample"', code: '  const value = 1' })
  assert.deepEqual(raw.links.map(link => link.url), ['/guide?a=1#part', '/guide?a=1#part', '/guide?a=1#part', './image.png'])
  let sent
  const semantic = { summary: '示例与参考链接', keywords: [' Guide ', 'Guide'], aliases: [], questions: [], entities: [], concepts: [], relations: [], facts: [], knowledgeType: 'example' }
  const result = await create(async (request) => {
    sent = JSON.parse(request.messages[1].content)
    // 模型等待期间的调用方变更不得影响保存的规则结果。
    input.metadata.custom.enabled = false
    input.headingPath[0].title = 'changed'
    return response(semantic)
  }).enrich(input)
  assert.equal(sent.extracted.title, 'Guide')
  assert.deepEqual(sent.extracted.metadata, raw.metadata)
  assert.deepEqual(sent.extracted.codeBlocks, raw.codeBlocks)
  assert.equal(JSON.stringify(sent).includes('private-id'), false)
  assert.equal(JSON.stringify(sent).includes('/private/document.mdx'), false)
  assert.equal(result.extracted.codeBlocks.length, 1)
  assert.equal(result.extracted.links.length, 3)
  assert.equal(result.extracted.links[2].kind, 'image')
  assert.deepEqual(result.extracted.headingPath, before.headingPath)
  assert.deepEqual(result.extracted.metadata, before.metadata)
  assert.deepEqual(result.enrichment.keywords, ['Guide'])
  assert.equal(Object.hasOwn(result.enrichment, 'metadata'), false)
  assert.equal(Object.hasOwn(result.enrichment, 'constraints'), false)
})

test('validated duplicate entities remap references before relation and fact deduplication', async () => {
  const value = enrichment()
  value.entities.push({ ...value.entities[0], id: 'e3', aliases: ['Atlas', 'Atlas'], evidence: ['Atlas'] })
  value.entities.push({ ...value.entities[0], id: 'e4', description: '不同角色的 Atlas' })
  value.relations.push({ ...value.relations[0], sourceId: 'e3', evidence: ['Gateway'] })
  value.facts.push({ ...value.facts[0], nodeIds: ['e2', 'e3', 'e3'], evidence: ['Gateway'] })
  value.aliases = [' Atlas ', 'Atlas']
  value.questions.push(value.questions[0])
  value.concepts.push({ ...value.concepts[0], id: 'c2', name: ' HTTPS ' })
  const result = (await create(async () => response(value)).enrich(section)).enrichment
  assert.deepEqual(result.entities.map(entity => entity.id), ['e1', 'e2', 'e4'])
  assert.deepEqual(result.entities[0].aliases, ['Atlas'])
  assert.deepEqual(result.entities[0].evidence, ['Atlas 调用 Gateway。', 'Atlas'])
  assert.equal(result.relations.length, 1)
  assert.equal(result.relations[0].sourceId, 'e1')
  assert.equal(result.facts.length, 1)
  assert.deepEqual(result.facts[0].nodeIds, ['e1', 'e2'])
  assert.deepEqual(result.facts[0].evidence, ['Atlas 调用 Gateway。', 'Gateway'])
  assert.deepEqual(result.aliases, ['Atlas'])
  assert.equal(result.questions.length, 1)
  assert.deepEqual(result.concepts, enrichment().concepts)
  assert.equal(value.entities.length, 4)
})

test('invalid duplicates cannot hide bad evidence or dangling references during deduplication', async () => {
  for (const mutate of [
    value => value.entities.push({ ...value.entities[0], id: 'e3', evidence: ['不存在的原文'] }),
    value => value.relations.push({ ...value.relations[0], targetId: 'missing' }),
    value => value.facts.push({ ...value.facts[0], evidence: [] }),
  ]) {
    const value = enrichment()
    mutate(value)
    await assert.rejects(create(async () => response(value)).enrich(section), { code: 'ENRICHMENT_INVALID_OUTPUT' })
  }
})

test('malformed rule inputs fail before LLM and extraction snapshots do not mutate callers', async () => {
  let calls = 0
  const enricher = create(async () => {
    calls++
    return response()
  })
  const cyclic = {}
  cyclic.self = cyclic
  for (const extra of [{ metadata: cyclic }, { metadata: { invalid: undefined } }, { metadata: { invalid: Number.NaN } }, { metadata: [] }, { ast: null }, { headingPath: [{ title: 'x', depth: 1 }] }])
    await assert.rejects(enricher.enrich({ ...section, ...extra }), { code: 'ENRICHMENT_INVALID_INPUT' })
  assert.equal(calls, 0)
  const input = structuredClone(section)
  input.metadata = { nested: { values: ['original'] } }
  const extracted = extractSectionData(input)
  extracted.metadata.nested.values.push('changed')
  extracted.headingPath[0].title = 'changed'
  assert.deepEqual(input.metadata.nested.values, ['original'])
  assert.equal(input.headingPath[0].title, section.headingPath[0].title)
  assert.deepEqual(extractSectionData(section).metadata, {})
})

test('merged evidence limits are rechecked without dropping distinct quotes', async () => {
  const value = enrichment()
  // 每个实体独立满足 10 条上限，合并后超过上限时仍须明确失败。
  const quotes = ['Atlas', 'Gateway', '调用', '生产', '环境', '必须', '使用', 'HTTPS', '支持', 'Linux', '版本', '示例']
  value.entities[0].evidence = quotes.slice(0, 6)
  value.entities.push({ ...value.entities[0], id: 'e3', evidence: quotes.slice(6) })
  await assert.rejects(create(async () => response(value)).enrich(section), { code: 'ENRICHMENT_INVALID_OUTPUT' })
})

test('concept deduplication remaps both relationship endpoints and fact node references', async () => {
  const value = enrichment()
  value.concepts.push({ ...value.concepts[0], id: 'c2', evidence: ['HTTPS'] })
  value.relations.push({ sourceId: 'e1', targetId: 'c2', type: 'requires', description: '生产要求', evidence: ['生产环境必须使用 HTTPS。'] })
  value.facts.push({ statement: '生产环境必须使用 HTTPS', nodeIds: ['c2', 'c1'], evidence: ['生产环境必须使用 HTTPS。'] })
  const result = (await create(async () => response(value)).enrich(section)).enrichment
  assert.equal(result.concepts.length, 1)
  assert.deepEqual(result.concepts[0].evidence, ['生产环境必须使用 HTTPS。', 'HTTPS'])
  assert.equal(result.relations[1].targetId, 'c1')
  assert.deepEqual(result.facts[1].nodeIds, ['c1'])
  for (const mutate of [
    item => item.concepts[0].id = 'e1',
    item => item.concepts = ['HTTPS'],
    item => item.concepts[0].evidence = [],
    item => item.concepts[0].evidence = ['原文不存在的概念'],
  ]) {
    const malformed = enrichment()
    mutate(malformed)
    await assert.rejects(create(async () => response(malformed)).enrich(section), { code: 'ENRICHMENT_INVALID_OUTPUT' })
  }
})

test('shared Markdown traversal preserves nested reference extraction and rejects malformed child nodes', async () => {
  const document = await new NextraMdxAdapter().normalize({
    source: { id: 'shared-reference' },
    content: '# 来源\n\n[Guide   API]: https://example.com/first\n\n[guide api]: https://example.com/second\n\n# 使用\n\n> - [文档][GUIDE api]\n> - ![示意][guide   api]',
  })
  const input = splitSections(document).at(-1)
  assert.deepEqual(extractSectionData(input).links, [
    { kind: 'link', text: '文档', url: 'https://example.com/first', title: null },
    { kind: 'image', text: '示意', url: 'https://example.com/first', title: null },
  ])
  for (const children of [null, {}, [null], [{ value: 'missing type' }], [{ type: 'paragraph', children: null }]]) {
    const malformed = { ...section, ast: { type: 'root', children } }
    assert.throws(() => extractSectionData(malformed), { code: 'ENRICHMENT_INVALID_INPUT' })
  }
})
