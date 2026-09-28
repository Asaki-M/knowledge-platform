import type { Concept, Entity, ExtractedSectionData, Fact, KnowledgeEnrichment, Relation } from './types.js'

const unique = (values: string[]) => [...new Set(values)]

/** 完全相同的代码与链接才合并，URL、代码缩进和大小写具有实际语义。 */
export function deduplicateExtracted(data: ExtractedSectionData): ExtractedSectionData {
  return {
    ...data,
    codeBlocks: [...new Map(data.codeBlocks.map(item => [JSON.stringify([item.language, item.meta, item.code]), item])).values()],
    links: [...new Map(data.links.map(item => [JSON.stringify([item.kind, item.url, item.text, item.title]), item])).values()],
  }
}

/** 本节内保守去重，不用模糊匹配合并同名但含义不同的实体，也不分配全局 ID。 */
export function deduplicateEnrichment(input: KnowledgeEnrichment): KnowledgeEnrichment {
  const entities = new Map<string, Entity>()
  const ids = new Map<string, string>()
  for (const entity of input.entities) {
    const key = JSON.stringify([entity.name, entity.type, entity.description])
    const previous = entities.get(key)
    if (previous) {
      ids.set(entity.id, previous.id)
      previous.aliases = unique([...previous.aliases, ...entity.aliases])
      previous.evidence = unique([...previous.evidence, ...entity.evidence])
    }
    else {
      ids.set(entity.id, entity.id)
      entities.set(key, { ...entity, aliases: unique(entity.aliases), evidence: unique(entity.evidence) })
    }
  }
  const concepts = new Map<string, Concept>()
  for (const concept of input.concepts) {
    const key = JSON.stringify([concept.name, concept.description])
    const previous = concepts.get(key)
    ids.set(concept.id, previous?.id ?? concept.id)
    if (previous) {
      previous.aliases = unique([...previous.aliases, ...concept.aliases])
      previous.evidence = unique([...previous.evidence, ...concept.evidence])
    }
    else {
      concepts.set(key, { ...concept, aliases: unique(concept.aliases), evidence: unique(concept.evidence) })
    }
  }
  // 先重映射实体和概念引用，再合并关系/事实，避免去重后产生悬空 ID。
  const relations = new Map<string, Relation>()
  for (const relation of input.relations) {
    const sourceId = ids.get(relation.sourceId)!
    const targetId = ids.get(relation.targetId)!
    const key = JSON.stringify([sourceId, targetId, relation.type, relation.description])
    const previous = relations.get(key)
    if (previous)
      previous.evidence = unique([...previous.evidence, ...relation.evidence])
    else
      relations.set(key, { ...relation, sourceId, targetId, evidence: unique(relation.evidence) })
  }
  const facts = new Map<string, Fact>()
  for (const fact of input.facts) {
    const nodeIds = unique(fact.nodeIds.map(id => ids.get(id)!))
    const key = JSON.stringify([fact.statement, [...nodeIds].sort()])
    const previous = facts.get(key)
    if (previous)
      previous.evidence = unique([...previous.evidence, ...fact.evidence])
    else
      facts.set(key, { ...fact, nodeIds, evidence: unique(fact.evidence) })
  }
  return {
    ...input,
    keywords: unique(input.keywords),
    aliases: unique(input.aliases),
    questions: unique(input.questions),
    concepts: [...concepts.values()],
    entities: [...entities.values()],
    relations: [...relations.values()],
    facts: [...facts.values()],
  }
}
