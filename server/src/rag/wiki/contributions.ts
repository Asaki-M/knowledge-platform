import type { WikiBuildInput, WikiSectionContribution } from './types.js'
import { isDeepStrictEqual } from 'node:util'
import { WIKI_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isNonEmptyString } from '../../utils/type-guards.js'
import { deduplicateEnrichment, deduplicateExtracted } from '../enrichment/deduplication.js'
import { extractSectionData } from '../enrichment/extraction.js'
import { parseEnrichment } from '../enrichment/validation.js'
import { assertSection } from '../sections/index.js'

/** 提取结果必须绑定当前原文版本；规则投影与逐字证据也再次复查。 */
export function buildContribution(input: WikiBuildInput): WikiSectionContribution {
  try {
    const { section, enrichedSection: enriched } = input
    assertSection(section)
    if (!enriched || enriched.schemaVersion !== 3 || enriched.sectionId !== section.id
      || enriched.documentId !== section.documentId || enriched.sectionRevision !== section.revision
      || !isDeepStrictEqual(enriched.extracted, deduplicateExtracted(extractSectionData(section)))
      || !isNonEmptyString(enriched.generation?.provider) || !isNonEmptyString(enriched.generation?.model)
      || !isNonEmptyString(enriched.generation?.responseId)) {
      throw new Error('Invalid contribution')
    }
    const dictionary = { [enriched.enrichment.knowledgeType]: '已校验分类' }
    const knowledge = deduplicateEnrichment(parseEnrichment(JSON.stringify(enriched.enrichment), section.markdown, dictionary))
    parseEnrichment(JSON.stringify(knowledge), section.markdown, dictionary)
    return structuredClone({
      documentId: section.documentId,
      sectionId: section.id,
      sectionRevision: section.revision,
      sourcePath: section.sourcePath,
      headingPath: section.headingPath,
      generation: enriched.generation,
      knowledge: { entities: knowledge.entities, concepts: knowledge.concepts, relations: knowledge.relations, facts: knowledge.facts },
    })
  }
  catch {
    throw new AppError(CODES.INVALID_INPUT, 'Wiki requires current sections and valid enrichment')
  }
}
