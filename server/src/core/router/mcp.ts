import type { McpServices } from '../service/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { mcpAuthConfig, validAccessToken } from '../service/mcp-auth.js'
import { createMcpServer } from '../service/mcp.js'

export function createMcpRouter(services?: McpServices) {
  return new Hono().all('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const config = mcpAuthConfig()
    const origin = c.req.header('origin')
    if (new URL(c.req.url).host !== new URL(config.issuer).host || (origin && origin !== config.issuer))
      throw new HTTPException(403, { message: 'MCP host or origin is not allowed' })
    // 每次请求先鉴权；发现工具也不绕过访问控制。
    const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token || !validAccessToken(token, config)) {
      c.header('WWW-Authenticate', `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp", scope="knowledge:read"`)
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST')
      return c.json({ error: 'method_not_allowed' }, 405)
    }
    // Vercel 实例可随请求重建；不依赖内存会话，也不保持长期 SSE 连接。
    const server = createMcpServer(services, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(240000)]))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 32768 })
    try {
      await server.connect(transport)
      return await transport.handleRequest(c.req.raw)
    }
    finally { await server.close() }
  })
}
