# Embedding

独立文本向量化能力，公共入口为 `index.ts`。`EmbeddingClient` 负责注册、输入/输出校验及追踪；供应商 SDK 位于各自的 `providers/` 下，不依赖 `llm` 或 HTTP 层。

## 模型与配置

截至 2026-09-28，推荐使用以下模型：

| 供应商      | 模型                 | 默认维度 | 单条输入上限 | 免费范围                                                     |
| ----------- | -------------------- | -------- | ------------ | ------------------------------------------------------------ |
| SiliconFlow | `BAAI/bge-m3`        | 1024     | 8192 Token   | 官方价格为免费，受平台限流约束；`Pro/BAAI/bge-m3` 为收费版本 |
| Google      | `gemini-embedding-2` | 3072     | 8192 Token   | 标准接口在 Free Tier 下免费；付费项目按其计费层级收费        |

来源：[SiliconFlow 价格](https://siliconflow.cn/pricing)、[SiliconFlow API](https://api-docs.siliconflow.cn/docs/api/embeddings-post)、[BGE-M3 模型说明](https://huggingface.co/BAAI/bge-m3)、[Google Embeddings](https://ai.google.dev/gemini-api/docs/embeddings?hl=zh-cn)、[Google 价格](https://ai.google.dev/gemini-api/docs/pricing)。免费额度与账号权限以平台控制台为准；模型 ID 本身不会强制项目使用免费计费层。

配置写在 `server/.env`，示例见 `server/.env.example`：

- SiliconFlow 使用 `EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`，兼容项目现有命名。默认地址为 `https://api.siliconflow.cn/v1`。
- Google 使用 `GOOGLE_API_KEY`、`GOOGLE_EMBEDDING_MODEL`。默认使用官方 Gemini Developer API；构造参数 `baseURL` 可覆盖服务根地址，不包含 `/v1beta`。
- 构造参数 `apiKey` 优先于环境变量。模型始终由每次调用显式传入，客户端不会自动读取模型环境变量。
- 只构造需要使用的适配器；不在模块导入或 HTTP 启动时创建实例或请求模型，缺少 Key 不影响健康检查。

## 调用

以下示例放在 `server/src` 下的调用方，运行环境需已加载 `server/.env`。仅构造客户端不调用上游。

```ts
import process from 'node:process'
import {
  EmbeddingClient,
  GoogleEmbeddingAdapter,
  SiliconFlowEmbeddingAdapter,
} from './rag/embedding/index.js'

const siliconflow = new EmbeddingClient([new SiliconFlowEmbeddingAdapter()])
const documentVectors = await siliconflow.embed({
  provider: 'siliconflow',
  model: process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3',
  input: ['第一段待嵌入文本', '第二段待嵌入文本'],
})

const google = new EmbeddingClient([new GoogleEmbeddingAdapter()])
const googleVectors = await google.embed({
  provider: 'google',
  model: process.env.GOOGLE_EMBEDDING_MODEL ?? 'gemini-embedding-2',
  input: ['第一段待嵌入文本', '第二段待嵌入文本'],
  dimensions: 768,
})

// 仅展示响应元数据，不把输入或向量写入日志。
console.log(documentVectors.dimensions, googleVectors.dimensions)
```

`input` 始终为非空字符串数组，返回 `embeddings[i]` 对应 `input[i]`。空白文本、无效维度会在调用前失败；内容不会被 trim、切分或截断。两家都支持 `signal` 取消，适配器的 `timeoutMs` 默认 60000；SDK 和客户端均不自动重试，不自动切换模型或供应商。错误中的 `retryable` 只提供给上层判断。

当前适配器限制每次 SiliconFlow 最多 32 条、Google 最多 100 条；超过时明确失败，调用方负责分批。模型 Token 上限由上游校验，不使用 Chunk Build 的 cl100k_base 计数冒充目标模型的真实 Token 数。Token 计数与 embeddingText 组装仍由后续入库流程处理。

## 响应与供应商差异

- 统一响应包含 `provider`、`model`、`embeddings`、`dimensions`、`usage`、可选 `requestId`。检查向量数量、非空数组、有限数值、维度一致性及请求指定的维度。
- SiliconFlow 使用已有 OpenAI SDK 的 Embeddings API，显式发送 `encoding_format: float`；按响应 `index` 还原顺序，拒绝重复或缺失索引，保留 `x-siliconcloud-trace-id`。用量转换为 `inputTokens` / `totalTokens`，缺失时返回 `null`。
- `BAAI/bge-m3` 不支持自定义维度，传入 `dimensions` 会明确失败。SiliconFlow 的 Qwen3 系列可传该参数，允许维度由目标模型的 API 校验。
- Google 使用官方 `@google/genai` SDK，每条文本独立包装为 `Content`，避免 Embedding 2 合并裸字符串列表。使用同步 `batchEmbedContents`，没有创建收费的异步 Batch 作业。
- Google 当前 SDK 不暴露 Token 用量，返回 `usage: null`；模型字段保留请求模型，不伪造上游统计。
- Gemini Embedding 2 支持 128–3072 维，官方建议 768、1536 或 3072，并自动归一化缩短后的向量。适配器不再次归一化、截取或补零；若显式选择旧版 `gemini-embedding-001`，使用缩短维度时需由调用方按官方说明归一化。
- 不同模型的向量空间不能混用，即使维度相同也不能放在同一检索索引中直接比较。更换模型、维度或文本处理方式时，后续入库流程需要重新生成对应向量。

当前仅实现传入文本到向量的 SDK 接入，不自动加入 Google 检索任务前缀，也不传 `taskType`；未来构建检索输入时应按目标模型的官方规则同时处理文档与查询。Metadata Build、embeddingText、Vector Record、向量数据库写入、入库编排和 HTTP 接口尚未实现。

## 错误与验证

统一抛出 `AppError`，错误码定义在 `server/src/error-codes.ts` 的 `EMBEDDING_ERROR_CODES`。保留鉴权、限流、超时、主动取消、连接失败和上游失败的区别，不透出 SDK 原始错误正文。

阅读顺序：`types.ts → client.ts → validation.ts → providers/<供应商>/adapter.ts → mapping.ts → normalize-error.ts`。公共 span 为 `embedding.embed`；日志只记录供应商、模型、数量、维度、用量、请求 ID、耗时与错误码。

`server/test/embedding.test.mjs` 使用真实 SDK 访问本地模拟 HTTP 服务，覆盖请求映射、批量顺序、异常响应、取消、超时、错误转换和扩展契约，不需要真实 Key。运行 `pnpm test` 会先构建服务端再执行全部集成测试。
