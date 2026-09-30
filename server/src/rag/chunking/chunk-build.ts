import type { Root, RootContent } from 'mdast'
import type { DocumentSection } from '../sections/types.js'
import type { ChunkBuildOptions, ChunkBuildResult, ChunkPart, DocumentChunk } from './types.js'
import { CHUNK_BUILD_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { isRecord } from '../../utils/type-guards.js'
import { plainText, renderMarkdown, visitMarkdown } from '../markdown.js'
import { indexDefinitions, withReferences } from '../references.js'
import { assertSection } from '../sections/index.js'
import { fragmentBlock } from './fragments.js'
import { countChunkTokens } from './tokens.js'

interface Fragment {
  node: RootContent
  part: ChunkPart
}

/** 只做确定性的内容构建；不调用模型，不拼 embeddingText，不提前生成数据库记录。 */
export function buildChunks(section: DocumentSection, options: ChunkBuildOptions = {}): ChunkBuildResult {
  if (!isRecord(options))
    throw new AppError(CODES.INVALID_OPTIONS, 'Chunk options must be an object')
  const maxTokens = options.maxTokens ?? 800
  const overlapTokens = options.overlapTokens ?? 0
  const oversized = options.oversized ?? 'keep'
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens
    || !['keep', 'error'].includes(oversized) || (options.countTokens !== undefined && typeof options.countTokens !== 'function')) {
    throw new AppError(CODES.INVALID_OPTIONS, 'Invalid chunk token budget, overlap or oversized policy')
  }
  try {
    assertSection(section)
  }
  catch {
    throw new AppError(CODES.INVALID_INPUT, 'A current section with valid content is required')
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
    const headingIndex = section.depth === 0 ? -1 : section.ast.children.findIndex(node => node.type === 'heading' && node.depth === section.depth)
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
        documentId: section.documentId,
        sectionRevision: section.revision,
        previousChunkId: null,
        nextChunkId: null,
        index,
        sourcePath: section.sourcePath,
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
          if (piece.range) {
            // 细分片段不再沿用原块行列；原始位置仍保存在 parts 中。
            visitMarkdown(content, (node) => {
              delete node.position
            })
          }
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
    // 全部 chunk 生成后再建立双向顺序引用，避免失败途中出现悬空的后继 ID。
    for (const [index, chunk] of chunks.entries()) {
      chunk.previousChunkId = chunks[index - 1]?.id ?? null
      chunk.nextChunkId = chunks[index + 1]?.id ?? null
    }
    return {
      schemaVersion: 3,
      sectionId: section.id,
      documentId: section.documentId,
      sectionRevision: section.revision,
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
