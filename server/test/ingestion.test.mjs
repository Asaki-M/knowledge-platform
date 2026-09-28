import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 只验证影响计算纯函数。
import { planSectionChanges } from '../dist/rag/ingestion/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 内存生成快照，无服务或数据库。
import { NextraMdxAdapter } from '../dist/rag/normalization/index.js'
// eslint-disable-next-line antfu/no-import-dist -- 公共 Section 契约。
import { splitSections } from '../dist/rag/sections/index.js'

async function sections(body, path = 'doc.mdx') {
  return splitSections(await new NextraMdxAdapter().normalize({ source: { id: 'doc', path }, content: `---\ntitle: 固定标题\n---\n${body}` }))
}

test('impact planning distinguishes content changes, additions, deletions and source-only shifts', async () => {
  const before = await sections('# A\n\n正文 A\n\n# B\n\n正文 B\n\n# C\n\n正文 C')
  const after = await sections('# New\n\n新增\n\n再一段\n\n# A\n\n正文改变\n\n# C\n\n正文 C')
  const original = structuredClone(before)
  const result = planSectionChanges(before, after)
  assert.deepEqual(result.added, [after[0].id])
  assert.deepEqual(result.modified, [after[1].id])
  assert.deepEqual(result.removed, [before[1].id])
  assert.deepEqual(result.sourceOnly, [before[2].id])
  assert.deepEqual(result.rebuildChunkSectionIds, [after[0].id, after[1].id].sort())
  assert.deepEqual(result.rebuildEnrichmentSectionIds, result.rebuildChunkSectionIds)
  assert.deepEqual(result.invalidateWikiSectionIds, [before[0].id, before[1].id].sort())
  assert.deepEqual(before, original)
  assert.deepEqual(planSectionChanges([...before].reverse(), [...after].reverse()), result)
})

test('path and line changes never trigger chunk or model rebuilding; rename is replacement', async () => {
  const before = await sections('# A\n\n正文')
  const moved = await sections('\n\n# A\n\n正文', 'new.mdx')
  const result = planSectionChanges(before, moved)
  assert.deepEqual(result.sourceOnly, [before[0].id])
  assert.deepEqual(result.rebuildChunkSectionIds, [])
  assert.deepEqual(result.rebuildEnrichmentSectionIds, [])
  assert.deepEqual(planSectionChanges(before, before).unchanged, [before[0].id])
  const renamed = await sections('# Renamed\n\n正文')
  const changes = planSectionChanges(before, renamed)
  assert.deepEqual(changes.added, [renamed[0].id])
  assert.deepEqual(changes.removed, [before[0].id])
})

test('duplicate or stale section snapshots fail and empty snapshots are supported', async () => {
  const [section] = await sections('# A\n\n正文')
  assert.throws(() => planSectionChanges([section, section], []), { code: 'INGESTION_INVALID_SNAPSHOT' })
  assert.throws(() => planSectionChanges([], [{ ...section, markdown: 'changed' }]), { code: 'INGESTION_INVALID_SNAPSHOT' })
  assert.deepEqual(planSectionChanges([], []).rebuildChunkSectionIds, [])
})
