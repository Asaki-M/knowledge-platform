import type { OAuthGrantStore } from './dao/mcp-auth.js'
import type { McpServices } from './service/mcp.js'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { errorResponse } from './error-response.js'
import { tracingMiddleware } from './middleware/tracing.js'
import { createMcpAuthRouter } from './router/mcp-auth.js'
import { createMcpRouter } from './router/mcp.js'

/** 公网入口只暴露 MCP 与 OAuth，个人工作台的入库、日志接口继续由本地服务提供。 */
export function createMcpApp(services?: McpServices, grants?: OAuthGrantStore) {
  const app = new Hono()
  app.use('*', requestId())
  app.use('*', tracingMiddleware)
  app.route('/', createMcpAuthRouter(undefined, grants))
  app.route('/mcp', createMcpRouter(services))
  app.onError((error, c) => {
    const failure = errorResponse(error, c.get('requestId'))
    return c.json(failure.body, failure.status)
  })
  return app
}
