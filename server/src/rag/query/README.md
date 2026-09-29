# 双路检索与回答

`searchAndAnswer(request, dependencies, options)` 不依赖 HTTP，组合现有 Embedding、向量库、独立 Rerank 与 LLM。HTTP 服务通过 `POST /api/search` 调用相同流程。

```text
问题 → 沿用知识库模型生成一个查询向量
     → Chunk embeddingText Top 30 ┐
     → Wiki node Top 30           ┴→ 合并去重 → Rerank Top 5 → DeepSeek → 答案 + 来源
```

## 数据与约束

1. 先读取知识库快照，再生成问题向量。两路查询在同一个 repeatable-read 只读事务中执行，校验快照版本、供应商、实际模型和维度。每路最多 30 条；不足时返回实际数量。
2. Chunk 查询的是入库时「原文 + 关联 Wiki 信息」的 embeddingText；Wiki 查询的是节点自身知识文本的向量。数据库目前执行精确余弦查询，不使用 HNSW。
3. 同 ID 或逐字相同文本只保留一个候选，同时保留合并后的来源和向量分数。同节不同 Chunk、同名不同节点不视为重复。ID 对应不同文本会失败。
4. 全部去重候选传给 SiliconFlow `BAAI/bge-reranker-v2-m3`，通过 `/rerank` 的 `top_n` 获取最多 5 个结果。严格校验返回数量、索引唯一性、范围与有限分数，按重排分数排序。参考 [SiliconFlow 官方 Rerank API](https://docs.siliconflow.cn/docs/api/rerank-post)。
5. 只有入选的 5 条完整文本交给 DeepSeek，少于 5 条时全部使用。资料作为引用数据处理，提示模型仅依据资料回答、标注 `[S1]` 等来源；资料不足时明确说明。不会把余弦分数当作重排分数，也不补造候选。
6. 问题最多 4000 字符；发送给 LLM 的完整 JSON 证据包默认最多 60000 字符，输出预算默认 8000 Token。超限明确失败，不截断证据。字符预算并非模型精确 Token 预算，可通过能力调用参数调整。
7. 返回 `answer`、`sources`、`snapshotRevision`、`counts` 和三个模型阶段的元数据 / 用量。每个 source 含完整文本、来源、向量分数、重排分数；不返回向量数组。缺失用量保持 `null`。
8. 无快照或空库返回 `status: no_results`，不调用模型；模型异常、取消、快照冲突、拒答、截断、空答案或非法来源编号都返回失败。引用检查只检查编号存在性，不代表事实蕴含核验。

## HTTP 与配置

请求：

```json
{
  "knowledgeBaseId": "dual-index-demo",
  "question": "哪种索引用于定位概念和实体？"
}
```

`RERANK_MODEL` 默认 `BAAI/bge-reranker-v2-m3`。Rerank 密钥 / 地址优先读取 `RERANK_API_KEY` / `RERANK_BASE_URL`，未设置时复用现有 SiliconFlow `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL`。DeepSeek 读取现有 `DEEPSEEK_*`，模型默认 `deepseek-flash`。启动与健康检查不触发模型调用。

问题 Embedding 模型从数据库快照读取。当前 HTTP 支持现有 SiliconFlow / Google 适配器的默认向量维度；如知识库使用自定义降维，需要在能力调用时显式传入 `embeddingDimensions`，HTTP 暂不暴露该选项。

输入无效或上下文过大返回 400，快照冲突返回 409，配置缺失返回 503，其余能力失败返回 502；响应保留统一错误码及 requestId，不透出上游错误正文或凭据。HTTP 请求体上限 32 KiB。当前供本地开发使用，尚无前端问答接入、Graph Expand、来源全文回查或生产鉴权。

## 验证

- `server/test/query.test.mjs`：双路各 30 条、去重与来源保留、真实重排顺序传递、Top 5 上下文、空库及错误语义、HTTP 输入校验。
- `server/test/rerank.test.mjs`：OpenAI SDK 对本地模拟 `/rerank`，验证请求、响应映射、错误转换、取消和超时，不请求远程模型。
- `server/test/vector-store.test.mjs`：显式配置 `VECTOR_STORE_TEST_DATABASE_URL` 时使用独立临时数据库，验证双路 Top 30、隔离、模型空间和快照冲突。
- 真实短文问答结果见 [10-answer.json](../../../test/reports/dual-index/10-answer.json) 与 [完整报告](../../../test/reports/dual-index/report.md)。
