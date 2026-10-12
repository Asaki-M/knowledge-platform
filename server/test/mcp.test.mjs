import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import { test } from 'node:test'
import { getRequestListener } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Pool } from 'pg'
// eslint-disable-next-line antfu/no-import-dist -- 数据库连接使用本地 stub，验证授权消费事务。
import { McpAuthDao } from '../dist/core/dao/mcp-auth.js'
// eslint-disable-next-line antfu/no-import-dist -- 协议与 OAuth 集成使用构建后的 HTTP 应用，数据库和模型全部注入 stub。
import { createMcpApp } from '../dist/core/mcp-app.js'
// eslint-disable-next-line antfu/no-import-dist -- 验证真实鉴权公共入口。
import { approveAuthorization, beginAuthorization, exchangeToken, mcpAuthConfig, validAccessToken } from '../dist/core/service/mcp-auth.js'
// eslint-disable-next-line antfu/no-import-dist -- 使用统一错误码验证脱敏响应。
import { AppError } from '../dist/errors.js'

const base = 'https://knowledge.example'
const config = { issuer: base, resource: `${base}/mcp`, clientId: 'knowledge-platform', secret: 'client-secret-'.repeat(4), signingSecret: 'token-signing-secret-'.repeat(3), password: 'personal-password-'.repeat(4), redirects: ['https://chatgpt.com/connector_platform_oauth_redirect'] }
const verifier = 'v'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const authorizationParams = () => new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirects[0], resource: config.resource, scope: 'knowledge:read', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'opaque state' })

function env(t) {
  const variables = { MCP_PUBLIC_URL: base, MCP_OAUTH_CLIENT_ID: config.clientId, MCP_OAUTH_CLIENT_SECRET: config.secret, MCP_TOKEN_SECRET: config.signingSecret, MCP_ACCESS_PASSWORD: config.password, MCP_OAUTH_REDIRECT_URIS: config.redirects.join(',') }
  for (const [key, value] of Object.entries(variables)) {
    const old = process.env[key]
    process.env[key] = value
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old)
  }
}

function fixture() {
  const saved = new Map()
  const calls = []
  const grants = {
    async save(digest, expiry) { saved.set(digest, expiry) },
    async consume(digest, next) {
      if (!saved.has(digest))
        return false
      saved.delete(digest)
      if (next)
        saved.set(next.digest, next.expiresAt)
      return true
    },
  }
  const result = { status: 'found', snapshotRevision: 'v1', sources: [{ id: 'chunk-1', title: '检索说明', text: '完整证据，包括正文和知识关联。', label: 'S1', rerankScore: 0.9, matches: [{ indexId: 'chunk-1', kind: 'chunk', sourceId: 'part-1', vectorScore: 0.8, sources: [{ documentId: 'doc-1', sectionId: 'section-1', sectionRevision: 'r1', sourcePath: 'guide.mdx', headingPath: [{ sectionId: 'section-1', title: '检索说明', depth: 1 }] }] }] }], counts: { chunks: 1, wikiNodes: 0, merged: 1, duplicates: 0, selected: 1 }, embedding: null, rerank: null }
  const services = {
    async listKnowledgeBases() {
      calls.push('list')
      return { knowledgeBases: [{ id: 'kb', documentCount: 1 }] }
    },
    async search(request) {
      calls.push(request)
      return structuredClone(result)
    },
  }
  return { grants, services, result, calls, saved, app: createMcpApp(services, grants) }
}

async function authorize(grants) {
  const ticket = beginAuthorization(authorizationParams(), config)
  const redirect = new URL(await approveAuthorization(ticket, config.password, config, grants))
  assert.equal(redirect.searchParams.get('state'), 'opaque state')
  assert.equal(redirect.searchParams.get('iss'), config.issuer)
  const params = new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier, redirect_uri: config.redirects[0], resource: config.resource, client_id: config.clientId, client_secret: config.secret })
  return { params, tokens: await exchangeToken(params, config, grants) }
}

test('OAuth enforces callback, resource, PKCE, owner password and one-time grants', async () => {
  const { grants } = fixture()
  for (const [key, value] of [['redirect_uri', 'https://attacker.example/callback'], ['resource', 'https://other.example/mcp'], ['code_challenge_method', 'plain'], ['scope', 'knowledge:write'], ['client_id', 'other']]) {
    const params = authorizationParams()
    params.set(key, value)
    assert.throws(() => beginAuthorization(params, config))
  }
  const ticket = beginAuthorization(authorizationParams(), config)
  await assert.rejects(approveAuthorization(ticket, 'wrong', config, grants), { code: 'MCP_AUTH_ACCESS_DENIED' })
  await assert.rejects(approveAuthorization(`${ticket}tampered`, config.password, config, grants), { code: 'MCP_AUTH_INVALID_GRANT' })
  const redirect = new URL(await approveAuthorization(ticket, config.password, config, grants))
  const params = new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: 'wrong'.repeat(12), redirect_uri: config.redirects[0], resource: config.resource, client_id: config.clientId, client_secret: config.secret })
  await assert.rejects(exchangeToken(params, config, grants), { code: 'MCP_AUTH_INVALID_GRANT' })
  params.set('code_verifier', verifier)
  const tokens = await exchangeToken(params, config, grants)
  assert.equal(validAccessToken(tokens.access_token, config), true)
  await assert.rejects(exchangeToken(params, config, grants), { code: 'MCP_AUTH_INVALID_GRANT' })
  const refresh = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: config.resource, client_id: config.clientId, client_secret: config.secret })
  const results = await Promise.allSettled([exchangeToken(refresh, config, grants), exchangeToken(refresh, config, grants)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected')[0].reason.code, 'MCP_AUTH_INVALID_GRANT')
  assert.equal(validAccessToken(tokens.refresh_token, config), false)
  assert.equal(validAccessToken(`${tokens.access_token}tampered`, config), false)
  assert.equal(validAccessToken(tokens.access_token, { ...config, resource: 'https://other.example/mcp' }), false)
  // 客户端密钥不是签名密钥；持有客户端凭据也不能绕过个人密码伪造访问令牌。
  const payload = tokens.access_token.split('.')[0]
  const forged = `${payload}.${createHmac('sha256', config.secret).update(payload).digest('base64url')}`
  assert.equal(validAccessToken(forged, config), false)
  const expiredPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), exp: 1 })).toString('base64url')
  assert.equal(validAccessToken(`${expiredPayload}.${createHmac('sha256', config.signingSecret).update(expiredPayload).digest('base64url')}`, config), false)
})

test('public MCP authenticates discovery and exposes only two read-only tools through the real SDK', async (t) => {
  env(t)
  const f = fixture()
  const unauthorized = await f.app.request(`${base}/mcp`, { method: 'POST', body: '{}' })
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/)
  assert.deepEqual(f.calls, [])
  const { tokens } = await authorize(f.grants)
  const client = new Client({ name: 'local-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }, fetch: (input, init) => f.app.request(new Request(input, init)) })
  await client.connect(transport)
  t.after(() => client.close())
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name), ['list_knowledge_bases', 'search_knowledge'])
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.equal(tool.annotations.destructiveHint, false)
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.ok(tool.outputSchema)
  }
  const listed = await client.callTool({ name: 'list_knowledge_bases', arguments: {} })
  assert.deepEqual(listed.structuredContent, { knowledgeBases: [{ id: 'kb', documentCount: 1 }] })
  const evidence = await client.callTool({ name: 'search_knowledge', arguments: { knowledgeBaseId: ' kb ', question: '如何检索？' } })
  assert.equal(evidence.structuredContent.status, 'found')
  assert.deepEqual(evidence.structuredContent.sources, f.result.sources)
  assert.equal(evidence.structuredContent.answer, undefined)
  assert.equal(f.calls[1].knowledgeBaseId, 'kb')
  assert.ok(f.calls[1].signal instanceof AbortSignal)
  const invalid = await client.callTool({ name: 'search_knowledge', arguments: { knowledgeBaseId: 'kb', question: '' } })
  assert.equal(invalid.isError, true)
  const unknown = await client.callTool({ name: 'delete_knowledge_base', arguments: { knowledgeBaseId: 'kb' } })
  assert.equal(unknown.isError, true)
  assert.equal(f.calls.length, 2)
  const headers = { authorization: `Bearer ${tokens.access_token}` }
  assert.equal((await f.app.request(`${base}/mcp`, { headers })).status, 405)
  assert.equal((await f.app.request(`${base}/mcp`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: '{}' })).status, 403)
  assert.equal((await f.app.request('https://attacker.example/mcp', { method: 'POST', headers, body: '{}' })).status, 403)
  for (const path of ['/api/logs', '/api/documents/ingest', '/api/workspace/options'])
    assert.equal((await f.app.request(`${base}${path}`)).status, 404)
})

test('MCP tools return safe failures, reject oversized complete evidence and keep an empty result explicit', async (t) => {
  env(t)
  const f = fixture()
  const { tokens } = await authorize(f.grants)
  const headers = { 'authorization': `Bearer ${tokens.access_token}`, 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }
  let id = 1
  const call = async () => (await f.app.request(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'search_knowledge', arguments: { knowledgeBaseId: 'kb', question: '问题' } } }) })).json()
  for (const error of [new Error('secret db URL and original model text'), new AppError('VECTOR_STORE_DATABASE_ERROR', 'secret db URL')]) {
    f.services.search = async () => {
      throw error
    }
    const result = await call()
    assert.equal(result.result.isError, true)
    assert.ok(!JSON.stringify(result).includes('secret'))
  }
  f.services.search = async () => ({ ...f.result, sources: [{ ...f.result.sources[0], text: 'x'.repeat(60001) }] })
  let result = await call()
  assert.equal(result.result.isError, true)
  assert.equal(JSON.parse(result.result.content[0].text).error.code, 'QUERY_CONTEXT_TOO_LARGE')
  f.services.search = async () => ({ ...f.result, status: 'no_results', sources: [], counts: { chunks: 0, wikiNodes: 0, merged: 0, duplicates: 0, selected: 0 } })
  result = await call()
  assert.equal(result.result.structuredContent.status, 'no_results')
  assert.deepEqual(result.result.structuredContent.sources, [])
  assert.equal((await f.app.request(`${base}/mcp`, { method: 'POST', headers, body: 'x'.repeat(33000) })).status, 413)
})

test('HTTP OAuth discovery, consent and Basic code exchange preserve resource, state and issuer', async (t) => {
  env(t)
  const f = fixture()
  const metadata = await (await f.app.request(`${base}/.well-known/oauth-authorization-server`)).json()
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  assert.equal(metadata.authorization_response_iss_parameter_supported, true)
  assert.ok(!metadata.registration_endpoint)
  const resource = await (await f.app.request(`${base}/.well-known/oauth-protected-resource/mcp`)).json()
  assert.equal(resource.resource, `${base}/mcp`)
  const page = await f.app.request(`${base}/oauth/authorize?${authorizationParams()}`)
  const html = await page.text()
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.ok(!html.includes(config.password))
  assert.ok(!html.includes(config.secret))
  const ticket = html.match(/name="ticket" value="([^"]+)"/)[1]
  const form = new URLSearchParams({ ticket, password: config.password })
  assert.equal((await f.app.request(`${base}/oauth/authorize`, { method: 'POST', body: form, headers: { origin: 'https://attacker.example' } })).status, 400)
  const wrong = await f.app.request(`${base}/oauth/authorize`, { method: 'POST', body: new URLSearchParams({ ticket, password: 'wrong' }), headers: { origin: base } })
  assert.equal(wrong.status, 403)
  assert.match(await wrong.text(), /访问密码不正确，请重试/)
  const redirect = await f.app.request(`${base}/oauth/authorize`, { method: 'POST', body: form, headers: { origin: base } })
  assert.equal(redirect.status, 303)
  const callback = new URL(redirect.headers.get('location'))
  assert.equal(callback.searchParams.get('state'), 'opaque state')
  assert.equal(callback.searchParams.get('iss'), base)
  const params = new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: config.redirects[0], resource: config.resource })
  const response = await f.app.request(`${base}/oauth/token`, { method: 'POST', body: params, headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}` } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(validAccessToken((await response.json()).access_token, config), true)
  const invalid = await f.app.request(`${base}/oauth/token`, { method: 'POST', body: params })
  assert.equal(invalid.status, 401)
  assert.deepEqual(await invalid.json(), { error: 'invalid_client' })
})

test('missing or weak OAuth configuration never opens anonymous MCP access', (t) => {
  env(t)
  assert.equal(mcpAuthConfig().issuer, base)
  for (const key of ['MCP_OAUTH_CLIENT_SECRET', 'MCP_TOKEN_SECRET', 'MCP_ACCESS_PASSWORD']) {
    const value = process.env[key]
    process.env[key] = 'short'
    assert.throws(() => mcpAuthConfig(), { code: 'MCP_AUTH_CONFIGURATION_ERROR' })
    process.env[key] = value
  }
  process.env.MCP_PUBLIC_URL = 'http://public.example'
  assert.throws(() => mcpAuthConfig(), { code: 'MCP_AUTH_CONFIGURATION_ERROR' })
})

test('OAuth grant DAO consumes and rotates on one connection, rolling back failed refresh persistence', async (t) => {
  const previous = process.env.VECTOR_DATABASE_URL
  process.env.VECTOR_DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/test'
  t.after(() => previous === undefined ? delete process.env.VECTOR_DATABASE_URL : process.env.VECTOR_DATABASE_URL = previous)
  const queries = []
  let available = true
  let failInsert = false
  let releases = 0
  let ends = 0
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (failInsert && sql.startsWith('INSERT'))
        throw new Error('private database URL and parameters')
      return { rowCount: sql.includes('RETURNING digest') ? Number(available) : 0, rows: [] }
    },
    release() { releases++ },
  }
  t.mock.method(Pool.prototype, 'connect', async () => client)
  t.mock.method(Pool.prototype, 'end', async () => {
    ends++
  })
  const dao = new McpAuthDao()
  await dao.save('code-digest', 123)
  assert.deepEqual(queries.find(item => item.sql.startsWith('INSERT')).values, ['code-digest', 123])
  queries.length = 0
  assert.equal(await dao.consume('old-digest', { digest: 'new-digest', expiresAt: 456 }), true)
  const consumeIndex = queries.findIndex(item => item.sql.includes('RETURNING digest'))
  const insertIndex = queries.findIndex(item => item.sql.startsWith('INSERT'))
  assert.ok(consumeIndex < insertIndex)
  assert.equal(queries[0].sql, 'BEGIN')
  assert.equal(queries.at(-1).sql, 'COMMIT')
  assert.deepEqual(queries[consumeIndex].values, ['old-digest'])
  assert.deepEqual(queries[insertIndex].values, ['new-digest', 456])
  available = false
  queries.length = 0
  assert.equal(await dao.consume('used-digest', { digest: 'unused-new', expiresAt: 789 }), false)
  assert.ok(!queries.some(item => item.sql.startsWith('INSERT')))
  available = true
  failInsert = true
  queries.length = 0
  await assert.rejects(dao.consume('retryable-old', { digest: 'failed-new', expiresAt: 789 }), { code: 'MCP_AUTH_DATABASE_ERROR' })
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
  assert.equal(releases, 4)
  assert.equal(ends, 4)
})

test('SDK tool calls over a real local Node connection keep the request active until evidence returns', async (t) => {
  env(t)
  const f = fixture()
  const server = createServer(getRequestListener(f.app.fetch))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const localBase = `http://127.0.0.1:${server.address().port}`
  process.env.MCP_PUBLIC_URL = localBase
  const settings = { ...config, issuer: localBase, resource: `${localBase}/mcp` }
  const authorization = authorizationParams()
  authorization.set('resource', settings.resource)
  const ticket = beginAuthorization(authorization, settings)
  const callback = new URL(await approveAuthorization(ticket, settings.password, settings, f.grants))
  const tokens = await exchangeToken(new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: settings.redirects[0], resource: settings.resource, client_id: settings.clientId, client_secret: settings.secret }), settings, f.grants)
  f.services.search = async (request) => {
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(request.signal.aborted, false)
    return f.result
  }
  const client = new Client({ name: 'node-test', version: '1.0.0' })
  t.after(async () => {
    await client.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await client.connect(new StreamableHTTPClientTransport(new URL(settings.resource), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }))
  const result = await client.callTool({ name: 'search_knowledge', arguments: { knowledgeBaseId: 'kb', question: '查询证据' } })
  assert.deepEqual(result.structuredContent.sources, f.result.sources)
})

test('Vercel Node entry restores only allowed rewritten routes without opening workspace APIs', async (t) => {
  env(t)
  for (const key of ['OTEL_TRACES_EXPORTER', 'OTEL_LOGS_EXPORTER']) {
    const previous = process.env[key]
    process.env[key] = 'none'
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous)
  }

  const { default: handler } = await import('../dist/vercel.js')
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

    const { shutdownTelemetry } = await import('../dist/telemetry/sdk.js')
    await shutdownTelemetry()
  })
  const localBase = `http://127.0.0.1:${server.address().port}`
  process.env.MCP_PUBLIC_URL = localBase
  const endpoint = `${localBase}/api/mcp`
  const discovery = await fetch(`${endpoint}?__mcp_route=/.well-known/oauth-authorization-server`)
  assert.equal(discovery.status, 200)
  assert.equal((await discovery.json()).issuer, localBase)
  const unauthorized = await fetch(`${endpoint}?__mcp_route=/mcp`, { method: 'POST', body: '{}' })
  assert.equal(unauthorized.status, 401)
  const params = authorizationParams()
  params.set('resource', `${localBase}/mcp`)
  const authPage = await fetch(`${endpoint}?__mcp_route=/oauth/authorize&${params}`)
  assert.equal(authPage.status, 200)
  assert.match(await authPage.text(), /个人访问密码/)
  for (const route of ['/api/logs', '/api/documents/ingest', '/api/workspace/options'])
    assert.equal((await fetch(`${endpoint}?__mcp_route=${encodeURIComponent(route)}`)).status, 404)
})
