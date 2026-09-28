/** 判断字符串是否包含非空白内容，仅校验，不修改原始值。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 排除 null 和数组；不限制对象原型，也不校验属性值。 */
export function isRecord<T>(value: T): value is T & Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
