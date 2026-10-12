import type { OAuthGrantStore } from '../dao/mcp-auth.js'
import { Buffer } from 'node:buffer'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { z } from 'zod'
import { MCP_AUTH_ERROR_CODES as CODES } from '../../error-codes.js'
import { AppError } from '../../errors.js'
import { McpAuthDao } from '../dao/mcp-auth.js'

const scope = 'knowledge:read'
const claimsSchema = z.strictObject({
  kind: z.enum(['consent', 'code', 'access', 'refresh']),
  iss: z.string(),
  aud: z.string(),
  clientId: z.string(),
  scope: z.literal(scope),
  exp: z.number().int(),
  nonce: z.string(),
  redirectUri: z.string().optional(),
  state: z.string().optional(),
  challenge: z.string().optional(),
})
type Claims = z.infer<typeof claimsSchema>

export interface McpAuthConfig { issuer: string, resource: string, clientId: string, secret: string, signingSecret: string, password: string, redirects: string[] }
function fail(code: typeof CODES[keyof typeof CODES]): never {
  throw new AppError(code, 'MCP authorization failed')
}

export function mcpAuthConfig(): McpAuthConfig {
  const base = process.env.MCP_PUBLIC_URL?.trim()
  const secret = process.env.MCP_OAUTH_CLIENT_SECRET ?? ''
  const signingSecret = process.env.MCP_TOKEN_SECRET ?? ''
  const password = process.env.MCP_ACCESS_PASSWORD ?? ''
  try {
    const url = new URL(base ?? '')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || [secret, signingSecret, password].some(value => value.length < 32) || new Set([secret, signingSecret, password]).size !== 3)
      fail(CODES.CONFIGURATION_ERROR)
    const redirects = (process.env.MCP_OAUTH_REDIRECT_URIS ?? 'https://chatgpt.com/connector_platform_oauth_redirect').split(',').map(uri => uri.trim())
    for (const uri of redirects) {
      const redirect = new URL(uri)
      if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) || redirect.hash || redirect.username || redirect.password)
        fail(CODES.CONFIGURATION_ERROR)
    }
    return { issuer: url.origin, resource: `${url.origin}/mcp`, clientId: process.env.MCP_OAUTH_CLIENT_ID?.trim() || 'knowledge-platform', secret, signingSecret, password, redirects }
  }
  catch { return fail(CODES.CONFIGURATION_ERROR) }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}
function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}
function sign(claims: Claims, config: McpAuthConfig): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${createHmac('sha256', config.signingSecret).update(payload).digest('base64url')}`
}
function verify(token: string, kind: Claims['kind'], config: McpAuthConfig): Claims {
  try {
    const parts = token.split('.')
    if (token.length > 16000 || parts.length !== 2 || !equal(parts[1]!, createHmac('sha256', config.signingSecret).update(parts[0]!).digest('base64url')))
      fail(CODES.INVALID_GRANT)
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()))
    if (claims.kind !== kind || claims.exp <= Math.floor(Date.now() / 1000) || claims.iss !== config.issuer || claims.aud !== config.resource || claims.clientId !== config.clientId)
      fail(CODES.INVALID_GRANT)
    return claims
  }
  catch { return fail(CODES.INVALID_GRANT) }
}

function claims(kind: Claims['kind'], seconds: number, config: McpAuthConfig): Claims {
  return { kind, iss: config.issuer, aud: config.resource, clientId: config.clientId, scope, exp: Math.floor(Date.now() / 1000) + seconds, nonce: randomUUID() }
}

export function protectedResource(config: McpAuthConfig) {
  return { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: [scope] }
}

export function authorizationMetadata(config: McpAuthConfig) {
  return { issuer: config.issuer, authorization_endpoint: `${config.issuer}/oauth/authorize`, token_endpoint: `${config.issuer}/oauth/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'], code_challenge_methods_supported: ['S256'], scopes_supported: [scope], authorization_response_iss_parameter_supported: true }
}

/** 仅允许预配置客户端和逐字匹配的回调地址，避免任意注册或开放重定向。 */
export function beginAuthorization(params: URLSearchParams, config: McpAuthConfig): string {
  for (const key of ['client_id', 'redirect_uri', 'resource', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
    if (params.getAll(key).length > 1)
      fail(CODES.INVALID_REQUEST)
  }
  const redirectUri = params.get('redirect_uri') ?? ''
  const state = params.get('state') ?? ''
  const challenge = params.get('code_challenge') ?? ''
  if (params.get('client_id') !== config.clientId)
    fail(CODES.INVALID_CLIENT)
  if (!config.redirects.includes(redirectUri) || params.get('resource') !== config.resource || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(challenge) || state.length > 2048 || (params.get('scope') && params.get('scope') !== scope))
    fail(CODES.INVALID_REQUEST)
  return sign({ ...claims('consent', 600, config), redirectUri, state, challenge }, config)
}

export async function approveAuthorization(ticket: string, password: string, config: McpAuthConfig, store: OAuthGrantStore = new McpAuthDao()): Promise<string> {
  const consent = verify(ticket, 'consent', config)
  if (!equal(password, config.password))
    fail(CODES.ACCESS_DENIED)
  const codeClaims: Claims = { ...consent, kind: 'code', exp: Math.floor(Date.now() / 1000) + 300, nonce: randomUUID() }
  const code = sign(codeClaims, config)
  await store.save(hash(code), codeClaims.exp)
  const redirect = new URL(consent.redirectUri!)
  redirect.searchParams.set('code', code)
  redirect.searchParams.set('state', consent.state!)
  redirect.searchParams.set('iss', config.issuer)
  return redirect.href
}

/** PKCE 校验成功后原子消费授权；授权码与刷新令牌均只允许使用一次。 */
export async function exchangeToken(params: URLSearchParams, config: McpAuthConfig, store: OAuthGrantStore = new McpAuthDao()) {
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1)
      fail(CODES.INVALID_REQUEST)
  }
  if (!equal(params.get('client_id') ?? '', config.clientId) || !equal(params.get('client_secret') ?? '', config.secret))
    fail(CODES.INVALID_CLIENT)
  if (params.get('resource') !== config.resource)
    fail(CODES.INVALID_REQUEST)
  const kind = params.get('grant_type') === 'authorization_code' ? 'code' : params.get('grant_type') === 'refresh_token' ? 'refresh' : fail(CODES.INVALID_REQUEST)
  const token = params.get(kind === 'code' ? 'code' : 'refresh_token') ?? ''
  const previous = verify(token, kind, config)
  if (params.get('scope') && params.get('scope') !== scope)
    fail(CODES.INVALID_REQUEST)
  if (kind === 'code') {
    const verifier = params.get('code_verifier') ?? ''
    if (params.get('redirect_uri') !== previous.redirectUri || !/^[\w.~-]{43,128}$/.test(verifier) || !equal(hash(verifier), previous.challenge!))
      fail(CODES.INVALID_GRANT)
  }
  // 刷新轮换不能无限延长授权；30 天后须重新输入访问密码授权。
  const refresh = { ...claims('refresh', 30 * 86400, config), ...(kind === 'refresh' ? { exp: previous.exp } : {}) }
  const refreshToken = sign(refresh, config)
  if (!await store.consume(hash(token), { digest: hash(refreshToken), expiresAt: refresh.exp }))
    fail(CODES.INVALID_GRANT)
  return { access_token: sign(claims('access', 3600, config), config), token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken, scope }
}

export function validAccessToken(token: string, config: McpAuthConfig): boolean {
  try {
    verify(token, 'access', config)
    return true
  }
  catch { return false }
}
