# Section Split 与 Chunk Build

`splitSections(document)` 是同步纯函数，消费 normalization 输出的 `NormalizedDocument`，返回按原文顺序排列的 `DocumentSection[]`。没有 Adapter、注册表、CLI、网络调用或模型调用。

本目录提供按标题的 Section Split 和按 Token 预算的 Chunk Build；中间的结构化知识补充由 [Knowledge Enrichment](../enrichment/README.md) 提供。embeddingText、过滤元数据与向量写入在后续阶段实现。

## 调用

```ts
import { splitSections } from './rag/chunking/index.js'
import {
  NextraMdxAdapter,
  NormalizationClient,
} from './rag/normalization/index.js'

const normalization = new NormalizationClient([new NextraMdxAdapter()])
const document = await normalization.normalize({
  adapter: 'nextra-mdx',
  source: { id: 'kb/guide.mdx' },
  content: '# 接入指南\n\n简介\n\n## 安装\n\n安装步骤\n\n### 配置\n\n配置说明',
})
const sections = splitSections(document)
```

这份输入得到三节，标题路径分别是：

```text
接入指南             → 正文：简介
接入指南 / 安装      → 正文：安装步骤
接入指南 / 安装 / 配置 → 正文：配置说明
```

第二节的主要字段如下（省略 AST、Markdown 和原文位置）：

```json
{
  "id": "kb/guide.mdx#section-1",
  "source": { "id": "kb/guide.mdx" },
  "documentTitle": "接入指南",
  "index": 1,
  "title": "安装",
  "depth": 2,
  "parentId": "kb/guide.mdx#section-0",
  "headingPath": [
    { "sectionId": "kb/guide.mdx#section-0", "title": "接入指南", "depth": 1 },
    { "sectionId": "kb/guide.mdx#section-1", "title": "安装", "depth": 2 }
  ],
  "blockRange": { "start": 2, "end": 4 },
  "text": "安装\n\n安装步骤"
}
```

## 切分规则

- 只在 AST 顶层 `heading` 处切分，支持 h1–h6。代码块中的 `#`、引用或列表里的标题不产生新 section。
- 当前标题到下一个顶层标题之前归当前节所有；父节只持有自己的正文，通过 `parentId` 与 `headingPath` 表达上下级关系。
- 首个标题之前的内容保留为无标题节，`title: null`、`depth: 0`、`headingPath: []`。无标题文档整体为一节；完全空的 AST 返回 `[]`。
- 连续标题会产生仅含标题的节，保留文档结构；重复标题各有独立 ID；标题跳级时直接关联最近的更浅标题，不补造层级。
- 每节的 `ast` 包含当前标题和正文，代码、表格、列表、引用等完整保留；Markdown 使用与 normalization 相同的序列化规则。
- 引用式链接、图片和脚注所需的跨节定义会补入该节 AST，递归收集脚注中的引用并防止循环。未定义的引用沿用原文，不猜测地址。
- `text` 仅来自本节原有块，不重复拼入从其他节补来的脚注正文。祖先标题单独保存在 `headingPath`，尚未拼成 embeddingText。
- `blockRange` 是输入 AST 顶层节点的 `[start, end)` 区间，各节拥有的区间连续且不重叠。为引用补入的定义属于依赖，可能出现在多节 AST 中，不属于这些区间。
- `position` 取本节第一个和最后一个原有块的位置，指向输入 MDX；补入定义不扩大范围。如果输入缺少任一端点位置则不生成该字段。
- ID 使用 `source.id + #section-序号`，同一文档顺序下可复现；插入或删除章节后 ID 可能变化，不承诺编辑前后稳定。
- 不修改输入，输出各节的 AST、来源和标题路径互相独立。原文 metadata 独立复制到每节供规则提取；normalization warnings 仍由调用方保留在 `document`。

## 阅读顺序

1. `types.ts`：输出字段与语义。
2. `section-split.ts`：按顶层标题划分范围，用标题栈确定父子关系。
3. `references.ts`：索引原文定义，为独立 section 补全引用。
4. `../markdown.ts`：Normalization 与 Split 共享的 Markdown / 纯文本投影。

非法输入抛出公共 [AppError](../../errors.ts)，错误码及中文含义统一放在 `../../error-codes.ts`。只校验本阶段需要的文档头部和标题约束，其余标准 AST 结构由 normalization 契约保证。

## Chunk Build

`buildChunks(section, enrichedSection, options?)` 是同步纯函数，消费同一个 section 及其已校验的 enrichment，输出 `ChunkBuildResult`。它不调用模型、不写数据库。section ID 与 source ID 不一致时直接报错，避免把其他文档的知识补充挂到当前 chunk 上。

```ts
import { buildChunks } from './rag/chunking/index.js'

const result = buildChunks(section, enrichedSection, {
  maxTokens: 800,
  overlapTokens: 80,
  oversized: 'keep',
})

const { chunks, sectionEnrichment } = result
```

输出分为两部分：

- `sectionEnrichment`：原 `EnrichedSection` v2（含 extracted 与 enrichment）的独立副本，只保存一份，作用域仍是 section。后续 Metadata Build 决定哪些信息适用于每个 chunk。
- `chunks`：有序 `DocumentChunk[]`，包含 `id`、`sectionId`、`index`、`source`、`documentTitle`、`headingPath`、`parts`、`ast`、`markdown`、`text`、`tokenCount` 与 `oversized`。

结果还带 `schemaVersion: 1`、`tokenizer`、`maxTokens` 和 `overlapTokens`，便于检查本次构建所用的预算规则。ID 使用 `${section.id}#chunk-${index}`，同样输入与配置可复现，修改正文、章节顺序或切分配置后不保证 ID 稳定。当前身份校验不含文档修订哈希，调用方仍需保证 section 和 enrichment 来自同一版内容。

### Token 预算

默认 `maxTokens: 800`、`overlapTokens: 0`、`oversized: 'keep'`。默认计数由 [js-tiktoken](https://github.com/dqbd/tiktoken/blob/main/js/README.md) 的 `cl100k_base` 编码完成，只加载对应词表并延迟构建编码器。`countChunkTokens(text)` 从公共入口导出，便于检查结果。

计数对象是**完整 chunk Markdown**，包含重复的本节标题、代码围栏、重复表头、链接地址与脚注定义。祖先标题路径保存在 `headingPath`，不会在此阶段自动拼入正文。这里尚未生成 embeddingText，不能将当前 tokenCount 当作未来包含摘要等额外信息的 embedding 请求 Token 数。

可以通过 `countTokens(text)` 传入目标 Embedding 模型的计数函数；此时结果的 `tokenizer` 标为 `custom`。计数函数必须同步、确定、无副作用，返回非负安全整数。默认编码是明确的计数基线，不代表所有模型都使用它。

### 结构化拆分规则

| 内容                                   | 拆分方式                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| 能放入预算的相邻块                     | 按顺序合并，section 之间不合并                                           |
| 本节标题                               | 作为上下文重复到每个 chunk；祖先路径单独保留                             |
| 长段落                                 | 保留行内结构拆分文本，优先在可容纳前缀的后半部寻找句界或空白；字素不拆开 |
| 粗体、斜体、删除线                     | 递归拆内容，每段保留格式包装                                             |
| 代码块                                 | 按完整行拆分，每段保留语言和 meta；单个超长行不截断                      |
| 表格                                   | 按数据行拆分，每段重复表头；单个超长行不截断                             |
| 列表                                   | 按完整列表项拆分，有序列表修正起始序号；不破坏单个列表项                 |
| 引用块、图片、链接、行内代码等原子内容 | 保留完整语义；无法容纳时按超限策略处理                                   |
| 链接/图片/脚注定义                     | 按各 chunk 实际引用补入，不单独构建无正文的 chunk                        |

`oversized: 'keep'` 会单独保留无法继续拆分的内容，并设置 `oversized: true`；不得忽略标记后直接发送给有硬性上限的模型。`oversized: 'error'` 则抛出 `CHUNK_BUILD_OVERSIZED_CONTENT`，整次调用不返回部分结果。如果固定标题及其引用已经超过预算，继续拆正文也无法满足限制，此时按同一策略整体保留或报错。

正文完全为空且没有标题时返回空 chunks；只有标题时保留一个标题 chunk。不静默丢弃超长内容、不将代码或表格转成无结构的字符串片段。

### Overlap 与来源

Overlap 按上一 chunk 末尾的完整片段选择，包含必要的引用定义；不从原子片段中硬截一段字节。`overlapTokens` 是重叠正文的预算上限，不含重复标题。新内容优先，放不下时减少 overlap，因此实际重叠量可能小于配置或为零。每个有正文的 chunk 都包含至少一个新片段，超长片段不会重复带入下一节。

`parts` 记录正文来源：

- `blockIndex`：输入 `section.ast.children` 的索引，区别于 Section Split 的文档全局 `blockRange`。
- `partIndex / partCount`：同一原始块拆出的片段序号和总数。
- `overlap`：是否从上一 chunk 重复带入；忽略 overlap 项可逐个统计正文覆盖范围。
- `range`：半开区间 `[start, end)`。`text` 使用原段落纯文本的 UTF-16 偏移；`lines` 是代码行；`rows` 是不含表头的数据行；`items` 是列表项，均从 0 开始。原块未拆分时不附此字段。
- `position`：原始完整块在源文档中的位置，不是细分片段的精确行列。细分后的 AST 节点移除旧位置，避免把整块位置误报为精确引用位置。

标题、重复表头与补入的引用定义是上下文，不计入正文的重复/新片段索引。各 chunk 的 AST、来源、标题路径和 enrichment 副本互相隔离，不修改输入。

新增实现建议按 `types.ts → chunk-build.ts → fragments.ts → tokens.ts` 阅读。错误继续使用公共 `AppError` 与统一错误码。后续阶段为 Metadata Build / embeddingText 组装、Embedding、Vector Record 和入库。
