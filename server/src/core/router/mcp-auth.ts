import type { OAuthGrantStore } from '../dao/mcp-auth.js'
import type { McpAuthConfig } from '../service/mcp-auth.js'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { MCP_AUTH_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { errorResponse } from '../error-response.js'
import { approveAuthorization, authorizationMetadata, beginAuthorization, exchangeToken, mcpAuthConfig, protectedResource } from '../service/mcp-auth.js'

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\'', '&#39;')
}

function consentPage(ticket: string, rejected = false): string {
  return `<!doctype html><html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接知序知识库</title>
<style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px;line-height:1.6;color:#17252b}input,button{box-sizing:border-box;width:100%;padding:12px;margin:12px 0;font:inherit}button{background:#17252b;color:white;border:0;border-radius:6px}[role=alert]{color:#a31b1b}</style></head>
<body><main><h1>连接知序知识库</h1><p>授权 ChatGPT 读取知识库列表和检索证据。检索返回的资料会发送到 ChatGPT。</p>
${rejected ? '<p role="alert">访问密码不正确，请重试。</p>' : ''}
<form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${escape(ticket)}"><label for="password">个人访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">授权只读访问</button></form></main></body></html>`
}

export function createMcpAuthRouter(config: () => McpAuthConfig = mcpAuthConfig, store?: OAuthGrantStore) {
  const router = new Hono()
  const securityHeaders = createMiddleware(async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', 'default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'; frame-ancestors \'none\'; base-uri \'none\'')
    await next()
  })
  router.use('/oauth/*', bodyLimit({ maxSize: 32768 }), securityHeaders)
  router.use('/.well-known/*', securityHeaders)
  router.onError((error, c) => {
    const name = error instanceof AppError ? new Map<string, string>([[CODES.INVALID_CLIENT, 'invalid_client'], [CODES.INVALID_REQUEST, 'invalid_request'], [CODES.INVALID_GRANT, 'invalid_grant'], [CODES.ACCESS_DENIED, 'access_denied']]).get(error.code) : undefined
    if (!name) {
      const failure = errorResponse(error, '')
      return c.json(failure.body, failure.status)
    }
    if (name === 'invalid_client')
      c.header('WWW-Authenticate', 'Basic realm="knowledge-platform"')
    return c.json({ error: name }, name === 'invalid_client' ? 401 : name === 'access_denied' ? 403 : 400)
  })
  router.get('/.well-known/oauth-protected-resource', c => c.json(protectedResource(config())))
  router.get('/.well-known/oauth-protected-resource/mcp', c => c.json(protectedResource(config())))
  router.get('/.well-known/oauth-authorization-server', c => c.json(authorizationMetadata(config())))
  router.get('/oauth/authorize', (c) => {
    const settings = config()
    const ticket = beginAuthorization(new URL(c.req.url).searchParams, settings)
    return c.html(consentPage(ticket))
  })
  router.post('/oauth/authorize', async (c) => {
    const settings = config()
    if (c.req.header('origin') !== settings.issuer)
      throw new AppError(CODES.INVALID_REQUEST, 'Invalid consent origin')
    const form = new URLSearchParams(await c.req.text())
    const ticket = form.get('ticket') ?? ''
    try {
      return c.redirect(await approveAuthorization(ticket, form.get('password') ?? '', settings, store), 303)
    }
    catch (error) {
      if (error instanceof AppError && error.code === CODES.ACCESS_DENIED)
        return c.html(consentPage(ticket, true), 403)
      throw error
    }
  })
  router.post('/oauth/token', async (c) => {
    const form = new URLSearchParams(await c.req.text())
    const authorization = c.req.header('authorization')
    if (authorization) {
      if (!authorization.startsWith('Basic ') || form.has('client_id') || form.has('client_secret'))
        throw new AppError(CODES.INVALID_CLIENT, 'Invalid client authentication')
      try {
        const credentials = Buffer.from(authorization.slice(6), 'base64').toString()
        const separator = credentials.indexOf(':')
        if (separator < 0)
          throw new Error('Invalid basic credentials')
        form.set('client_id', decodeURIComponent(credentials.slice(0, separator)))
        form.set('client_secret', decodeURIComponent(credentials.slice(separator + 1)))
      }
      catch { throw new AppError(CODES.INVALID_CLIENT, 'Invalid client authentication') }
    }
    return c.json(await exchangeToken(form, config(), store))
  })
  return router
}
