import process from 'node:process'
import { NodeSDK } from '@opentelemetry/sdk-node'

// Local development requires no collector; explicit OTEL_* settings take precedence.
process.env.OTEL_SERVICE_NAME ??= 'knowledge-server'
process.env.OTEL_TRACES_EXPORTER ??= 'console'
process.env.OTEL_LOGS_EXPORTER ??= 'console'
process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??= 'http/json'
process.env.OTEL_LOG_LEVEL ??= 'warn'

const sdk = new NodeSDK({ metricReaders: [] })
sdk.start()

export function shutdownTelemetry() {
  return sdk.shutdown()
}
