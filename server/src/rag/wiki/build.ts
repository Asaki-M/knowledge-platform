import type { WikiBuildInput, WikiBuildOptions, WikiBuildResult, WikiNode, WikiUpdate } from './types.js'
import { WIKI_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { assertSection } from '../sections/index.js'
import { buildContribution } from './contributions.js'
import { assembleWiki } from './nodes/build.js'

const invalid = () => new AppError(CODES.INVALID_INPUT, 'Wiki updates require unique, current section snapshots')

/** 初次构建只接受已完成提取的 section；没有语义项的 section 仍保留贡献记录。 */
export function buildWiki(inputs: readonly WikiBuildInput[], options: WikiBuildOptions): WikiBuildResult {
  if (!Array.isArray(inputs))
    throw invalid()
  try {
    const contributions = inputs.map(buildContribution)
    if (new Set(contributions.map(item => item.sectionId)).size !== contributions.length)
      throw invalid()
    return assembleWiki(contributions, options, [])
  }
  catch (error) {
    if (error instanceof AppError)
      throw error
    throw invalid()
  }
}

/** 差量操作互斥；调用方必须把待提取的变更节显式标为 pending，先撤销旧知识。 */
export function updateWiki(previous: WikiBuildResult, update: WikiUpdate, options: WikiBuildOptions): WikiBuildResult {
  try {
    if (!previous || previous.schemaVersion !== 2 || previous.knowledgeBaseId !== options?.knowledgeBaseId
      || !Array.isArray(previous.contributions) || !Array.isArray(previous.pendingSections)
      || !update || !Array.isArray(update.inputs) || !Array.isArray(update.removedSectionIds)) {
      throw invalid()
    }
    const fresh = update.inputs.map(buildContribution)
    const pending = update.pendingSections ?? []
    const sources = update.sourceUpdates ?? []
    pending.forEach(assertSection)
    sources.forEach(assertSection)
    const operations = [...fresh.map(item => item.sectionId), ...pending.map(item => item.id), ...sources.map(item => item.id), ...update.removedSectionIds]
    if (operations.some(id => !isNonEmptyString(id)) || new Set(operations).size !== operations.length)
      throw invalid()
    const contributions = new Map(structuredClone(previous.contributions).map(item => [item.sectionId, item]))
    const waiting = new Map(previous.pendingSections.map(item => [item.sectionId, { ...item }]))
    // 原文更新后，迟到的旧模型响应不能覆盖正在等待的新版本。
    for (const contribution of fresh) {
      const expected = waiting.get(contribution.sectionId)
      if (expected && expected.sectionRevision !== contribution.sectionRevision)
        throw invalid()
    }
    for (const id of [...update.removedSectionIds, ...pending.map(item => item.id), ...fresh.map(item => item.sectionId)]) {
      contributions.delete(id)
      waiting.delete(id)
    }
    for (const section of pending)
      waiting.set(section.id, { sectionId: section.id, sectionRevision: section.revision })
    for (const contribution of fresh)
      contributions.set(contribution.sectionId, contribution)
    for (const section of sources) {
      const contribution = contributions.get(section.id)
      if (!contribution && waiting.get(section.id)?.sectionRevision === section.revision)
        continue
      if (!contribution || contribution.sectionRevision !== section.revision || contribution.documentId !== section.documentId)
        throw invalid()
      contribution.sourcePath = section.sourcePath
      contribution.headingPath = structuredClone(section.headingPath)
    }
    return assembleWiki([...contributions.values()], options, [...waiting.values()], previous)
  }
  catch (error) {
    if (error instanceof AppError)
      throw error
    throw invalid()
  }
}

/** Chunk 先回查 Section，再由当前版本的关联索引找到多个语义节点。 */
export function getWikiNodesForSection(wiki: WikiBuildResult, sectionId: string, sectionRevision: string): WikiNode[] {
  if (!wiki || wiki.schemaVersion !== 2)
    throw invalid()
  const link = wiki.sectionLinks.find(item => item.sectionId === sectionId)
  if (!link)
    return []
  if (link.sectionRevision !== sectionRevision)
    throw new AppError(CODES.INVALID_ASSOCIATION, 'Wiki section reference is stale')
  const ids = new Set(link.nodeIds)
  return structuredClone(wiki.nodes.filter(node => ids.has(node.id)))
}
