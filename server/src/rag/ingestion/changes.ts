import type { DocumentSection } from '../sections/types.js'
import { INGESTION_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { contentHash } from '../content-hash.js'
import { assertSection } from '../sections/index.js'

export interface SectionChanges {
  added: string[]
  modified: string[]
  removed: string[]
  sourceOnly: string[]
  unchanged: string[]
  rebuildChunkSectionIds: string[]
  rebuildEnrichmentSectionIds: string[]
  /** 更新 Wiki 时撤销这些旧贡献；新结果未完成的节应传入 pendingSections。 */
  invalidateWikiSectionIds: string[]
}

/** 两侧均为同一比较范围的完整快照；缺席章节表示删除，不把部分列表当全量。 */
export function planSectionChanges(previous: readonly DocumentSection[], next: readonly DocumentSection[]): SectionChanges {
  try {
    const index = (values: readonly DocumentSection[]) => {
      if (!Array.isArray(values))
        throw new Error('Invalid snapshot')
      values.forEach(assertSection)
      const map = new Map(values.map(section => [section.id, section]))
      if (map.size !== values.length)
        throw new Error('Duplicate section')
      return map
    }
    const before = index(previous)
    const after = index(next)
    const added: string[] = []
    const modified: string[] = []
    const removed = [...before.keys()].filter(id => !after.has(id)).sort()
    const sourceOnly: string[] = []
    const unchanged: string[] = []
    for (const section of after.values()) {
      const old = before.get(section.id)
      if (!old)
        added.push(section.id)
      else if (old.revision !== section.revision)
        modified.push(section.id)
      else if (contentHash(old) !== contentHash(section))
        sourceOnly.push(section.id)
      else
        unchanged.push(section.id)
    }
    const rebuild = [...added, ...modified].sort()
    return { added: added.sort(), modified: modified.sort(), removed, sourceOnly: sourceOnly.sort(), unchanged: unchanged.sort(), rebuildChunkSectionIds: [...rebuild], rebuildEnrichmentSectionIds: [...rebuild], invalidateWikiSectionIds: [...modified, ...removed].sort() }
  }
  catch {
    throw new AppError(CODES.INVALID_SNAPSHOT, 'Section change planning requires valid complete snapshots')
  }
}
