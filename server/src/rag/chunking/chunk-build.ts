import type { Root, RootContent } from 'mdast'
import type { EnrichedSection } from '../enrichment/types.js'
import type { ChunkBuildOptions, ChunkBuildResult, ChunkPart, DocumentChunk, DocumentSection } from './types.js'
import { CHUNK_BUILD_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { plainText, renderMarkdown } from '../markdown.js'
import { fragmentBlock } from './fragments.js'
import { indexDefinitions, withReferences } from './references.js'
import { countChunkTokens } from './tokens.js'

interface Fragment {
  node: RootContent
  part: ChunkPart
}

/** 细分后的节点不再沿用整块行列；原文粗粒度位置保存在 parts 中。 */
function removePositions(node: Root | RootContent) {
  delete node.position
  if ('children' in node)
    node.children.forEach(removePositions)
}

/** 只做确定性的内容构建；不调用模型，不拼 embeddingText，不提前生成数据库记录。 */
export function buildChunks(section: DocumentSection, enrichment: EnrichedSection, options: ChunkBuildOptions = {}): ChunkBuildResult {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new AppError(CODES.INVALID_OPTIONS, 'Chunk options must be an object')
  const maxTokens = options.maxTokens ?? 800
  const overlapTokens = options.overlapTokens ?? 0
  const oversized = options.oversized ?? 'keep'
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens
    || !['keep', 'error'].includes(oversized) || (options.countTokens !== undefined && typeof options.countTokens !== 'function')) {
    throw new AppError(CODES.INVALID_OPTIONS, 'Invalid chunk token budget, overlap or oversized policy')
  }
  if (!section || typeof section.id !== 'string' || !section.id.trim() || typeof section.source?.id !== 'string' || !section.source.id.trim() || section.ast?.type !== 'root' || !Array.isArray(section.ast.children) || !Array.isArray(section.headingPath)
    || !enrichment || enrichment.schemaVersion !== 2 || enrichment.sectionId !== section.id || enrichment.source?.id !== section.source.id || !enrichment.enrichment || !enrichment.extracted
    || (section.source.path !== undefined && enrichment.source.path !== undefined && section.source.path !== enrichment.source.path)) {
    throw new AppError(CODES.INVALID_INPUT, 'Section and enrichment must have matching section and source IDs')
  }

  try {
    const counter = options.countTokens ?? countChunkTokens
    const counts = new Map<string, number>()
    const count = (value: string) => {
      const previous = counts.get(value)
      if (previous !== undefined)
        return previous
      let total: number
      try {
        total = counter(value)
      }
      catch {
        throw new AppError(CODES.TOKEN_COUNT_FAILED, 'Chunk token counting failed')
      }
      if (!Number.isSafeInteger(total) || total < 0)
        throw new AppError(CODES.TOKEN_COUNT_FAILED, 'Token count must be a non-negative integer')
      counts.set(value, total)
      return total
    }
    const definitions = indexDefinitions(section.ast)
    const headingIndex = section.ast.children.findIndex(node => node.type === 'heading')
    const heading = headingIndex < 0 ? [] : [section.ast.children[headingIndex]]
    const originalBlocks = section.ast.children.flatMap((node, blockIndex) => blockIndex === headingIndex || node.type === 'definition' || node.type === 'footnoteDefinition' ? [] : [{ node, blockIndex }])
    const render = (nodes: RootContent[], includeHeading = true) => {
      const ast: Root = { type: 'root', children: withReferences([...(includeHeading ? heading : []), ...nodes], definitions) }
      const markdown = renderMarkdown(ast)
      return { ast, markdown, tokenCount: count(markdown) }
    }
    const fits = (nodes: RootContent[]) => render(nodes).tokenCount <= maxTokens
    const chunks: DocumentChunk[] = []
    const emit = (fragments: Fragment[]) => {
      const rendered = render(fragments.map(fragment => fragment.node))
      const isOversized = rendered.tokenCount > maxTokens
      if (isOversized && oversized === 'error')
        throw new AppError(CODES.OVERSIZED_CONTENT, 'An indivisible chunk exceeds the configured token budget')
      const index = chunks.length
      chunks.push({
        id: `${section.id}#chunk-${index}`,
        sectionId: section.id,
        index,
        source: { ...section.source },
        documentTitle: section.documentTitle,
        headingPath: structuredClone(section.headingPath),
        parts: structuredClone(fragments.map(fragment => fragment.part)),
        ast: structuredClone(rendered.ast),
        markdown: rendered.markdown,
        text: plainText(rendered.ast).trim(),
        tokenCount: rendered.tokenCount,
        oversized: isOversized,
      })
    }

    if (!fits([])) {
      // 固定标题/其引用已超预算，继续拆正文无法解决，整体保留并明确标记。
      emit(originalBlocks.map(({ node, blockIndex }) => ({ node, part: { blockIndex, partIndex: 0, partCount: 1, overlap: false, position: node.position } })))
    }
    else {
      let group: Fragment[] = []
      for (const { node, blockIndex } of originalBlocks) {
        const pieces = fragmentBlock(node, part => fits([part]))
        for (const [partIndex, piece] of pieces.entries()) {
          const content = structuredClone(piece.node)
          if (piece.range)
            removePositions(content)
          const fragment: Fragment = {
            node: content,
            part: { blockIndex, partIndex, partCount: pieces.length, overlap: false, range: piece.range, position: node.position },
          }
          if (!fits([content])) {
            if (group.length)
              emit(group)
            // 单独输出超长原子块，不把它作为下一个 chunk 的 overlap。
            emit([fragment])
            group = []
            continue
          }
          if (group.length && !fits([...group.map(item => item.node), content])) {
            emit(group)
            const overlap: Fragment[] = []
            if (overlapTokens) {
              for (let index = group.length - 1; index >= 0; index--) {
                const candidate = [group[index], ...overlap]
                if (render(candidate.map(item => item.node), false).tokenCount > overlapTokens)
                  break
                overlap.unshift({ ...group[index], part: { ...group[index].part, overlap: true } })
              }
            }
            // 新内容优先；减少 overlap 直到能容纳新片段，每次输出都保证有进展。
            while (overlap.length && !fits([...overlap.map(item => item.node), content]))
              overlap.shift()
            group = overlap
          }
          group.push(fragment)
        }
      }
      if (group.length)
        emit(group)
      else if (!chunks.length && heading.length)
        emit([])
    }
    return {
      schemaVersion: 1,
      sectionId: section.id,
      sectionEnrichment: structuredClone(enrichment),
      tokenizer: options.countTokens ? 'custom' : 'cl100k_base',
      maxTokens,
      overlapTokens,
      chunks,
    }
  }
  catch (error) {
    if (error instanceof AppError)
      throw error
    throw new AppError(CODES.INVALID_INPUT, 'Could not build chunks from the section AST')
  }
}
