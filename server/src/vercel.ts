import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import './telemetry/sdk.js'

// 遥测必须先于路由加载；Vercel 使用独立入口，不启动 Node 监听端口。
// eslint-disable-next-line antfu/no-top-level-await -- 在加载 HTTP 应用前初始化遥测。
const { createMcpApp } = await import('./core/mcp-app.js')

const listener = getRequestListener(createMcpApp().fetch)
const paths = new Set(['/mcp', '/oauth/authorize', '/oauth/token', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'])

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  // 平台 rewrite 可能传递函数路径；显式还原允许的路由，不依赖部署平台保留原始 URL。
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = url.searchParams.get('__mcp_route')
  if (route) {
    if (url.searchParams.getAll('__mcp_route').length !== 1 || !paths.has(route)) {
      response.writeHead(404)
      response.end()
      return
    }
    url.searchParams.delete('__mcp_route')
    request.url = `${route}${url.search}`
  }
  return listener(request, response)
}
