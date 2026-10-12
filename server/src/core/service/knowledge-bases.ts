import { z } from 'zod'
import { HTTP_ERROR_CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { KnowledgeBasesDao } from '../dao/knowledge-bases.js'

const description = z.string().trim().max(1000).refine(value => !value.includes('\0'))
const createSchema = z.strictObject({ name: z.string().trim().min(1).max(64).refine(value => !value.includes('\0')), description: description.optional().default('') })
const updateSchema = z.strictObject({ description })

export async function createKnowledgeBase(body: unknown, dao = new KnowledgeBasesDao()) {
  const input = createSchema.safeParse(body)
  if (!input.success)
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '需要 1–64 个字符的知识库名称；描述可选，最多 1000 字符。')
  return dao.create({ id: input.data.name, description: input.data.description })
}

export async function updateKnowledgeBaseDescription(id: string, body: unknown, dao = new KnowledgeBasesDao()) {
  const input = updateSchema.safeParse(body)
  if (!id.trim() || id.length > 256 || id.includes('\0') || !input.success)
    throw new AppError(HTTP_ERROR_CODES.INVALID_INPUT, '需要有效的知识库 ID 和 description；描述最多 1000 字符，可留空。')
  return dao.updateDescription({ id, description: input.data.description })
}
