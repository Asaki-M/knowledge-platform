import type { RequestIdVariables } from 'hono/request-id'
import type { OperationType } from '../dao/operation-logs.js'
import { createMiddleware } from 'hono/factory'
import { OperationTracker } from '../service/operation-logs.js'

export interface OperationLogEnv {
  Variables: RequestIdVariables & { operationLog: OperationTracker }
}

/** 包住请求体校验和业务处理，JSON 解析失败和请求体过大也能形成失败记录。 */
export function operationLogging(type: OperationType) {
  return createMiddleware<OperationLogEnv>(async (c, next) => {
    const tracker = new OperationTracker(type, c.get('requestId') ?? null)
    c.set('operationLog', tracker)
    await tracker.start()
    let failure: unknown
    try {
      await next()
    }
    catch (error) {
      failure = error
      throw error
    }
    finally {
      // Hono 会在 next() 内执行 onError，因此同时检查 c.error 和响应状态。
      await tracker.finish(failure ? 500 : c.res.status, c.error ?? failure)
    }
  })
}
