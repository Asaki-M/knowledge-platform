# 文档入库与问答接口

服务默认地址 `http://127.0.0.1:3000`，请求与响应使用 JSON。模型密钥和服务地址只读服务端 `.env`，客户端仅选择供应商、模型和可选向量维度。导入和问答为同步请求，大文档需要等待多次模型调用完成。

## 统一模型选择

| 参数                   | 支持值 / 行为                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `llm.provider`         | `deepseek`（也接受 `ds`）或 `openai`                                                                                        |
| `llm.model`            | 可选；DeepSeek 默认读取 `DEEPSEEK_MODEL`，未配置时使用 `deepseek-flash`；OpenAI 默认读取 `OPENAI_MODEL`，未配置必须显式传入 |
| `embedding.provider`   | `gemini`（也接受 `google`）或 `siliconflow`；响应使用内部标识 `google` / `siliconflow`                                      |
| `embedding.model`      | 入库未传时读取 `GOOGLE_EMBEDDING_MODEL` 或 `EMBEDDING_MODEL`；问答未传时沿用知识库模型                                      |
| `embedding.dimensions` | 可选正整数，供应商和模型必须支持；Gemini、SiliconFlow Qwen3 可传，BGE 入库不传                                              |

省略整个 `llm` 时使用 DeepSeek；入库省略整个 `embedding` 时使用 SiliconFlow。问答省略整个 `embedding` 时自动沿用入库的供应商、模型和维度。Gemini 和支持自定义维度的 Qwen3 在更新文档或问答时可继承库内维度。

同一知识库只能使用同一个 Embedding 向量空间。入库或问答显式选择不匹配的供应商、模型或维度时返回 409；更换 Embedding 模型应使用新的知识库，或由完整快照流程重建全库。LLM 可按请求切换，不影响向量空间。

OpenAI 继续使用现有 **Responses API** 适配器，`OPENAI_BASE_URL` 必须支持该协议。DeepSeek 使用 Chat Completions。Rerank 保持 SiliconFlow，与所选 LLM / Embedding 无关：使用 `RERANK_MODEL`，凭据 / 地址优先 `RERANK_*`，未设置时复用 `EMBEDDING_*`。选择 Gemini 后，问答仍需配置 SiliconFlow Rerank。

## POST /api/documents/ingest

```json
{
  "knowledgeBaseId": "notes-demo",
  "document": {
    "id": "atlas-intro",
    "format": "nextra-mdx",
    "sourcePath": "atlas-intro.mdx",
    "content": "# Atlas\n\n生产环境必须使用 HTTPS。"
  },
  "llm": { "provider": "ds" },
  "embedding": { "provider": "siliconflow" }
}
```

- `knowledgeBaseId`、`document.id` 为稳定标识，均最多 256 字符。同库同文档 ID 表示更新，不同文档 ID 表示新增。
- `document.content` 直接传正文，最多 200000 字符；请求体最多 1 MiB。`format` 可省略，目前仅支持 `nextra-mdx`，普通 Markdown 内容也可由该适配器处理；不支持 PDF / Word 或 multipart 文件上传。
- `sourcePath` 可省略，仅保存来源标记，最多 2048 字符，不读取服务器文件或远程 URL。
- 执行 Normalize → Section Split → Chunk Build → LLM Knowledge Enrichment → Wiki → 双索引 embeddingText → Embedding → pgvector。每篇最多 100 个章节，各阶段仍执行既有文本与 Token 预算校验。
- 第一笔入库会幂等初始化表结构。所有模型调用完成后，单个数据库事务替换该文档的双索引，删除该文档失效的旧记录，保留其他文档。失败不提交部分索引；并发快照冲突返回 409，不自动重跑模型。
- 当前节点按文档 / 章节的独立身份构建，不做自动同名合并。若更新目标涉及已有跨文档共享 Wiki 节点，返回 409，需使用完整 Wiki / 知识库重建流程。

成功返回 `status: stored`，包含：

- `knowledgeBaseId`、`documentId`。
- `normalization`：标题、标准化警告、纯文本字符数。
- `counts`：本次文档的 Section、Chunk、Wiki 节点 / 边、向量数量。
- `enrichment`：逐节 LLM 供应商、实际模型、请求 ID 和用量。
- `embedding`：供应商、请求 / 实际模型、维度和用量。
- `stored`：写入后的**整个知识库**版本、向量空间及 Chunk / Wiki 数量。

持久化内容是双索引向量、embeddingText、来源和版本；原始上传文件、完整 NormalizedDocument / Section / Wiki 对象尚未独立存档。更新文档需要重新传入完整正文，当前不按变更节缓存和复用模型结果。

## POST /api/search

```json
{
  "knowledgeBaseId": "notes-demo",
  "question": "生产环境需要使用什么协议？",
  "llm": { "provider": "openai" },
  "embedding": { "provider": "siliconflow" }
}
```

上述示例需要配置 `OPENAI_MODEL`。使用 Gemini 建库时，将两个接口的 `embedding.provider` 都设为 `gemini`；问答也可以直接省略 `embedding`。`llm` 同样可以改为 `ds`。

问题最多 4000 字符，请求体最多 32 KiB。链路保持：问题向量化一次 → Chunk Top 30 + Wiki Top 30 → 合并去重 → Rerank Top 5 → 所选 LLM 生成带来源引用的答案。返回 `answer`、`sources`、阶段 `counts`、快照版本及模型用量；空库返回 `status: no_results`，不调用模型。详细规则见 [Query](../rag/query/README.md)。

## 错误与验证

400：参数或 MDX 语法无效、文档 / 上下文超限；413：请求体过大；409：向量空间不匹配、快照冲突或跨文档共享节点；503：模型 / 数据库配置缺失；502：模型或数据库操作失败。错误响应包含 `error.code`、可控文案及 `requestId`，不返回凭据或上游原始错误正文。

`server/test/document-api.test.mjs` 使用真实 SDK 和本地模拟上游验证四种 LLM / Embedding 组合，从实际 HTTP 路由走完整入库和问答。`vector-store.test.mjs` 的显式数据库测试验证单文档保留邻居数据、过期记录清理、重复写入、向量空间检查、共享节点保护和回滚；测试使用独立临时数据库。
