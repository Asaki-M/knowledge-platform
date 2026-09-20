import type { Attributes } from '@opentelemetry/api'
import { context } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'

const logger = logs.getLogger('knowledge-server')

function emit(severityText: 'INFO' | 'WARN' | 'ERROR', body: string, attributes: Attributes = {}) {
  logger.emit({
    severityText,
    severityNumber: SeverityNumber[severityText],
    body,
    attributes,
    context: context.active(),
  })
}

export const log = {
  info: (body: string, attributes?: Attributes) => emit('INFO', body, attributes),
  warn: (body: string, attributes?: Attributes) => emit('WARN', body, attributes),
  error: (body: string, attributes?: Attributes) => emit('ERROR', body, attributes),
}
