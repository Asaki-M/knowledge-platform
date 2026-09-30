export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<{ data: T, requestId: string | null }> {
  const response = await fetch(path, init)
  const requestId = response.headers.get('X-Request-Id')
  let body: unknown
  try {
    body = await response.json()
  }
  catch {
    throw new ApiError('服务返回了无法读取的响应，请检查服务连接。', `HTTP_${response.status}`, requestId ?? undefined)
  }
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : {}
    throw new ApiError(
      typeof error.message === 'string' ? error.message : '请求失败，请稍后重试。',
      typeof error.code === 'string' ? error.code : `HTTP_${response.status}`,
      isRecord(body) && typeof body.requestId === 'string' ? body.requestId : requestId ?? undefined,
    )
  }
  return { data: body as T, requestId }
}

export function errorMessage(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('无法连接服务，请检查网络后重试。')
}
