import type { Attributes } from '@opentelemetry/api'
import type { AppError } from '../errors.js'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { log } from './logger.js'

interface OperationTrace<T> {
  namespace: string
  name: string
  /** 日志事件前缀可与 span 名称不同，保留现有观测接口。 */
  event: string
  attributes: Attributes
  normalizeError: (error: unknown) => AppError
  successAttributes: (result: T) => Attributes
  failureAttributes?: (error: AppError) => Attributes
}

/** 只接收白名单元数据；领域校验、取消优先级与异常转换由能力模块负责。 */
export function traceOperation<T>(options: OperationTrace<T>, action: () => Promise<T>): Promise<T> {
  const { namespace, name, event } = options
  return trace.getTracer(`knowledge-server.${namespace}`).startActiveSpan(name, async (span) => {
    const started = performance.now()
    span.setAttributes(options.attributes)
    const duration = () => ({ [`${namespace}.duration_ms`]: performance.now() - started })
    try {
      const result = await action()
      const attributes = { ...options.successAttributes(result), ...duration() }
      span.setAttributes(attributes)
      log.info(`${event}.completed`, attributes)
      return result
    }
    catch (error) {
      const normalized = options.normalizeError(error)
      const attributes = { ...options.failureAttributes?.(normalized), [`${namespace}.error.code`]: normalized.code, ...duration() }
      span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.code })
      span.setAttributes(attributes)
      log.error(`${event}.failed`, attributes)
      throw normalized
    }
    finally {
      // 正常、失败和取消均结束 span，沿用调用方当前的异步追踪上下文。
      span.end()
    }
  })
}
