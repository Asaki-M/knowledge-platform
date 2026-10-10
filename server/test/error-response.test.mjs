import assert from 'node:assert/strict'
import { test } from 'node:test'
// eslint-disable-next-line antfu/no-import-dist -- 验证集中错误描述保持对外状态与脱敏行为。
import { describeAppError, isCancelledError } from '../dist/core/error-presentation.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证真实 HTTP 错误包装。
import { errorResponse } from '../dist/core/error-response.js'
// eslint-disable-next-line antfu/no-import-dist -- 枚举全部领域错误，而不是按字符串片段猜测分类。
import * as errorCodes from '../dist/error-codes.js'
// eslint-disable-next-line antfu/no-import-dist -- 共用领域异常。
import { AppError } from '../dist/errors.js'

test('all configured error groups share safe classification while HTTP and log text retain their own purpose', () => {
  const categories = { CONFIGURATION_ERROR: ['configuration', 503], CHECKPOINT_CONFIGURATION_ERROR: ['configuration', 503], ABORTED: ['cancelled', 502], AUTHENTICATION_ERROR: ['authentication', 502], RATE_LIMITED: ['rate-limit', 502], TIMEOUT: ['timeout', 502], DATABASE_ERROR: ['database', 502], CHECKPOINT_DATABASE_ERROR: ['database', 502] }
  for (const group of Object.values(errorCodes)) {
    for (const [key, code] of Object.entries(group)) {
      const expected = categories[key]
      if (!expected)
        continue
      const error = new AppError(code, 'private provider output and credentials')
      const presentation = describeAppError(error)
      assert.deepEqual([presentation.category, presentation.status], expected)
      assert.equal(errorResponse(error, 'request-id').status, expected[1])
      assert.equal(isCancelledError(error), key === 'ABORTED')
      assert.ok(!JSON.stringify(presentation).includes('private'))
    }
  }
  const error = new AppError(errorCodes.ENRICHMENT_ERROR_CODES.OUTPUT_TRUNCATED, 'private output')
  const { httpMessage, logMessage } = describeAppError(error)
  assert.ok(httpMessage.includes('调整提取输出预算'))
  assert.ok(!logMessage.includes('调整提取输出预算'))
  assert.ok(!isCancelledError(new Error('ABORTED')))
})

test('domain-specific 400/404/409 errors and unknown failures keep stable response semantics', () => {
  for (const [code, status] of [
    [errorCodes.HTTP_ERROR_CODES.INVALID_INPUT, 400],
    [errorCodes.NORMALIZATION_ERROR_CODES.PARSE_ERROR, 400],
    [errorCodes.QUERY_ERROR_CODES.CONTEXT_TOO_LARGE, 400],
    [errorCodes.INGESTION_ERROR_CODES.TASK_NOT_FOUND, 404],
    [errorCodes.INGESTION_ERROR_CODES.TASK_CONFLICT, 409],
    [errorCodes.VECTOR_STORE_ERROR_CODES.CONFLICT, 409],
    [errorCodes.VECTOR_STORE_ERROR_CODES.INCONSISTENT_SPACE, 409],
  ]) {
    const result = errorResponse(new AppError(code, 'Controlled input explanation'), 'request-id')
    assert.equal(result.status, status)
    assert.equal(result.body.requestId, 'request-id')
    assert.equal(result.body.error.code, code)
  }
  assert.equal(errorResponse(new Error('private raw exception'), 'request-id').status, 500)
  const result = errorResponse(new AppError(errorCodes.INDEXING_ERROR_CODES.INCONSISTENT_SPACE, 'private model data'), 'request-id')
  assert.equal(result.status, 502)
  assert.ok(!JSON.stringify(result).includes('private'))
})
