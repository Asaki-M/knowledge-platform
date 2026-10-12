# ChatGPT 只读 MCP 与 Vercel 部署

本服务通过官方 MCP TypeScript SDK 提供无状态 Streamable HTTP，入口为 `/mcp`。每个 POST 使用独立 server / transport，返回 JSON，不保留进程内会话或长期 SSE 连接。公网入口只挂载 MCP 与 OAuth；入库、工作台、操作日志接口仍在本地服务中使用。

## 工具

| 工具                   | 输入                          | 返回                                                                                      |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `list_knowledge_bases` | `{}`                          | 实际知识库 ID 和文档数量，不读取操作日志或调用模型                                        |
| `search_knowledge`     | `knowledgeBaseId`、`question` | Chunk / Wiki 各 Top 30 → 合并去重 → SiliconFlow Rerank Top 5 的完整证据、来源、分数与版本 |

两个工具均标注只读，只允许 OAuth 的 `knowledge:read` 权限。问题最多 4000 字符，完整结果最多 60000 字符，超限明确失败。工具同时返回 JSON 文本和 `structuredContent`，不返回向量或凭据。取消、模型失败、版本与空间冲突保持原有错误语义。

检索复用 `rag/query.searchEvidence`，由 ChatGPT 组织答案；不再调用后端 DeepSeek / OpenAI 生成答案。Embedding 和 Rerank 仍会使用已配置的模型服务。证据中的指令视作不可信资料，Wiki 语义提取不等同于事实核验。来源对应索引证据，尚无全文读取工具或可打开的原文页面；不伪造原文链接。

## 个人 OAuth

此版本面向单人自用，使用预配置 OAuth 客户端，不开放动态客户端注册或多用户权限。ChatGPT 支持填写静态客户端凭据，见 [OpenAI Docs 的自定义 MCP 接入说明](https://developers.openai.com/api/docs/guides/custom-mcp-server)。鉴权遵循授权码 + PKCE S256，校验资源、客户端与逐字匹配的回调 URI，并在回调返回 `iss`。首次授权时输入个人访问密码，授权结果仅允许读取知识库。

服务端环境变量：

| 变量                      | 配置                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `MCP_PUBLIC_URL`          | 固定公网根地址，如 `https://your-project.vercel.app`，不含 `/mcp`，不使用每次变化的 Preview 域名 |
| `MCP_OAUTH_CLIENT_ID`     | 默认 `knowledge-platform`，填入 ChatGPT 客户端 ID                                                |
| `MCP_OAUTH_CLIENT_SECRET` | 至少 32 字符的随机客户端密钥，填入 ChatGPT 客户端 Secret                                         |
| `MCP_TOKEN_SECRET`        | 独立的至少 32 字符随机令牌签名密钥，仅保存在服务端                                               |
| `MCP_ACCESS_PASSWORD`     | 独立的至少 32 字符随机访问密码，仅在授权页面输入                                                 |
| `MCP_OAUTH_REDIRECT_URIS` | 默认 `https://chatgpt.com/connector_platform_oauth_redirect`；多个实际回调用逗号分隔             |

三项密钥必须不同，不能用客户端 Secret 签发令牌。可以使用密码管理器分别生成三个随机值，避免将密钥写进源码、命令参数或聊天。缺少配置时 MCP 返回 503，不开放匿名访问，基础服务启动及健康检查保持可用。更换签名密钥使旧令牌失效。

授权码有效期 5 分钟，访问令牌 1 小时，刷新授权最长 30 天。授权码和刷新令牌只存 SHA-256 摘要及过期时间，在 Neon 的 `mcp_oauth_grants` 表中原子消费；刷新时轮换令牌，重放失败。授权记录在实际授权操作时惰性建表，不依赖 Vercel 实例生命周期。访问令牌每次验证签名、用途、issuer、audience、客户端、权限与过期时间。刷新失败或 30 天到期需重新授权。

OAuth 发现地址：

- `/.well-known/oauth-protected-resource/mcp`（同时支持不带 `/mcp` 的发现地址）
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`：浏览器授权页面，校验提交来源，不缓存页面；使用 `same-origin` 保留同站表单的 Origin，跨域跳转不发送 Referer。CSP 的 `form-action` 仅允许本站和已配置回调的来源，保证授权后能返回 ChatGPT
- `/oauth/token`：支持 `client_secret_post` 和 `client_secret_basic`

MCP 每次请求都校验 Bearer token；缺少或无效令牌返回 401 和 `WWW-Authenticate` 发现地址。工具列表也需要授权。Host / Origin 校验避免其他域名调用；不接收任意回调地址，不获取客户端提供的远程 URL。协议请求体上限 32 KiB；GET / DELETE 返回 405，不持有常驻连接。[OpenAI Docs 的 OAuth 要求](https://developers.openai.com/plugins/build/auth)

## 部署到 Vercel

1. 在 Vercel 导入此仓库，**Root Directory 选仓库根目录，Framework Preset 选 Other**。工作区仍为 `@knowledge/server`，无需将 `server/` 改名。
2. 根目录 `vercel.json` 已指定服务端构建、300 秒函数时限及新加坡 `sin1` 区域，匹配当前 Neon 区域。静态输出目录为 `server/public`，仅含 `robots.txt`，满足 Vercel 的非空输出要求，也避免 Other 预设默认公开仓库根目录。Build Command / Output Directory 由配置文件控制；若页面已手动覆盖，分别改为 `pnpm --filter @knowledge/server build` / `server/public`。`api/mcp.mjs` 使用原生 ESM 转发已编译的 `server/dist/vercel.js`，避免 TypeScript 入口被平台编译为 CommonJS 后触发 `ERR_REQUIRE_ESM`；不监听端口、不发布前端工作台。数据库与模型凭据只放在 Vercel 服务端环境变量中。
3. 配置 Production 环境变量：`VECTOR_DATABASE_URL`、上表 MCP 配置、实际知识库所用 Embedding 的 `GOOGLE_*` 或 `EMBEDDING_*`，以及 SiliconFlow Rerank 的 `RERANK_*`（可沿用 `EMBEDDING_*`）。添加 `ENABLE_EXPERIMENTAL_COREPACK=1`，让 Vercel 使用根目录 `packageManager` 指定的 pnpm 版本。只读 MCP 不需要 `DEEPSEEK_*` / `OPENAI_*`。配置 `OTEL_TRACES_EXPORTER=none` 和 `OTEL_LOGS_EXPORTER=none` 可关闭控制台导出；需要 Collector 时再显式配置 OTLP。
4. 首次部署获得固定项目域名后，将它设置为 `MCP_PUBLIC_URL` 并重新部署。该配置必须与 ChatGPT 填写的 MCP 地址属于同一域名。正式域名的 Vercel Deployment Protection 需允许 ChatGPT 访问；应用自身仍通过 OAuth 保护资料。
5. 打开 `https://项目域名/.well-known/oauth-authorization-server` 验证发现文档。随后完成 ChatGPT 授权并查看工具列表；首次实际授权会初始化授权记录表。

新建 Neon 项目不会自动拥有本地历史数据。入库继续通过本地工作台写入同一个 Neon 数据库；无需把长时间入库任务搬到 Vercel。生产部署前未做真实模型调用验证，仓库测试仅使用本地 stub。

## 在 ChatGPT 连接

在 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加自定义 MCP：

1. Server URL 填 `https://项目域名/mcp`，认证选 **OAuth**。
2. 填静态 Client ID（默认 `knowledge-platform`）及 `MCP_OAUTH_CLIENT_SECRET`。此服务不支持留空后自动 DCR / CIMD 注册。
3. 按 ChatGPT 显示的实际 Redirect URI 检查 `MCP_OAUTH_REDIRECT_URIS`。本服务返回 issuer，默认支持官方稳定回调；若管理页显示其他回调，逐字添加并重新部署。[官方回调说明](https://developers.openai.com/plugins/build/auth#redirect-url)
4. 在知序授权页面输入 `MCP_ACCESS_PASSWORD`，授权只读访问，然后安装到个人插件。
5. 在聊天中通过 `@` 选择该插件，例如“先列出知识库，再查一下其中关于双路检索的说明，附上来源”。

连接配置通过网页版进行，账号和工作区权限决定是否能添加自定义 MCP；手机端以该账号实际可用入口为准。没有通过用户账号完成线上连接前，不宣称 ChatGPT 已接入。

## 验证

`server/test/mcp.test.mjs` 使用真实 SDK HTTP 客户端验证初始化、工具发现、输入与输出 schema、完整来源、空结果、脱敏失败、请求体限制与鉴权；OAuth 测试覆盖 PKCE、resource、回调、签名、过期、授权码重放、刷新轮换和跨客户端密钥伪造。数据库与模型均注入 stub，不连接用户的 Neon 或调用真实模型。

`server/test/query.test.mjs` 同时覆盖检索证据入口和原有 HTTP 问答行为，确保拆分后 Top 5 与来源保持一致，检索入口不调用回答模型。
