import { createHash } from 'node:crypto'
import { isRecord } from '../utils/type-guards.js'

/** 内容版本不依赖对象键插入顺序；数组顺序由所属能力明确规范。 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)).digest('hex')
}
