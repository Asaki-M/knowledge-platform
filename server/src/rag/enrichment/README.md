# Knowledge Enrichment

按 `规则提取 → LLM 语义补充 → 校验 → 去重 → 复查` 处理一节。确定性数据与模型结果分开存储，不让模型重建标题、元数据、代码块或链接。

```text
NormalizedDocument → splitSections → DocumentSection
  → extractSectionData：title / headingPath / metadata / codeBlocks / links
  → LlmClient：summary / keywords / aliases / questions
              entities / concepts / relations / facts / knowledgeType
  → 校验结构、分类、引用和逐字证据
  → 去重并重映射实体/概念引用 → 复查上限和引用
  → EnrichedSection { extracted, enrichment, generation }
  → buildWiki（语义分支；buildChunks 独立消费 Section）
```

## 调用

```ts
import { LlmClient, OpenAIAdapter } from './llm/index.js'
import {
  extractSectionData,
  KnowledgeEnricher,
} from './rag/enrichment/index.js'
import {
  NextraMdxAdapter,
  NormalizationClient,
} from './rag/normalization/index.js'
import { splitSections } from './rag/sections/index.js'

const document = await new NormalizationClient([
  new NextraMdxAdapter(),
]).normalize({
  adapter: 'nextra-mdx',
  source: { id: 'kb/guide.mdx' },
  content:
    '---\nproduct: Atlas\nversion: [v2]\n---\n# 接入\n\n生产环境必须使用 HTTPS。',
})
const [section] = splitSections(document)

// 可以单独预览规则数据，不调用模型；enrich 内部也会自动执行此步骤。
const extracted = extractSectionData(section)
const enricher = new KnowledgeEnricher(new LlmClient([new OpenAIAdapter()]), {
  provider: 'openai',
  model: 'your-model-id',
  knowledgeTypes: { runbook: '值班操作手册，包含执行步骤与检查点' },
})
const result = await enricher.enrich(section)
console.log(extracted.title, result.enrichment.summary)
```

供应商和模型显式传入，接入复用现有 LLM Adapter。本模块不扫描目录、不提供 CLI、不自动批量调用、重试或修复输出。

## 规则数据：extracted

| 字段          | 来源与规则                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `title`       | 当前 section 的标题；前言为 null                                                                    |
| `headingPath` | Split 已确定的标题层级，保留 sectionId/title/depth                                                  |
| `metadata`    | Normalization 的 frontmatter 经 Split 独立复制传入；保留 JSON 原值和自定义字段，没有则为 `{}`       |
| `codeBlocks`  | 遍历 AST 的 code 节点，包括列表、引用等嵌套位置；保存 language/meta/code，缺少语言或 meta 时为 null |
| `links`       | AST 的链接、图片及引用式链接/图片；保存 kind/text/url/title，引用由定义解析，缺少 title 时为 null   |

代码文本保留缩进、换行、大小写；行内代码不作为 codeBlocks。相对 URL、锚点与查询参数原样保留，不访问链接，也不扫描代码中的网址。引用式链接采用 Markdown 首个同名定义，未使用的定义不当作链接；缺失引用定义的非法 AST 明确失败。Split 会补齐跨节使用的定义。

metadata 不从路径、标题或模型推测产品、版本、平台和语言；代码围栏的语言仅保存在 codeBlocks.language 中。后续若需标准过滤字段，应增加明确的映射规则。规则提取不修改输入，输出元数据和标题路径是独立副本；非法 JSON 元数据、循环引用或缺失 AST 会在模型调用前失败。

## 模型数据：enrichment

```ts
interface KnowledgeEnrichment {
  summary: string
  keywords: string[]
  aliases: string[]
  questions: string[]
  entities: Entity[]
  concepts: Concept[]
  relations: Relation[]
  facts: Fact[]
  knowledgeType: string
}
```

保留 concepts 与可扩展分类；移除了 constraints 和模型 metadata。模型多返回规则字段或旧字段也会被严格校验拒绝。

| 结构       | 字段                                        |
| ---------- | ------------------------------------------- |
| `Entity`   | id/name/type/aliases/description/evidence   |
| `Concept`  | id/name/aliases/description/evidence        |
| `Relation` | sourceId/targetId/type/description/evidence |
| `Fact`     | statement/nodeIds/evidence                  |

默认分类见 `knowledge-types.ts`，包括 concept、guide、api、example、faq、troubleshooting、security-rule、configuration、architecture、reference、specification、decision、changelog、incident、overview、other。`knowledgeTypes` 可增加或覆盖分类说明；运行时必须使用已注册 key，不允许模型自由扩展。security-rule 仍可作为文档分类，不代表恢复独立约束字段。

模型收到本节 Markdown、文档标题和规则结果；不发送内部来源 ID、sourcePath 或标题路径的 sectionId。原文中的标题、元数据、代码和链接都视作待分析数据。

## 校验与去重

1. 拒绝非法 JSON、围栏、缺字段、多余字段、类型错误、重复局部 ID、未注册分类及悬空实体/概念引用。
2. 实体、概念、关系、事实的每条 evidence 必须是本节 Markdown 的连续原文；文档标题、祖先标题及 frontmatter 不是替代证据。表格优先引用简短、连续且足以支撑陈述的片段。
3. 校验后去重，保留第一次出现的顺序。字符串先去首尾空白，再按精确值合并；代码和 URL 不改写。仅完全相同的 language/meta/code 或 kind/url/text/title 合并。
4. 实体在 name/type/description 完全一致时合并，保留第一个 ID，合并 aliases/evidence；同名不同描述、不同大小写的实体保持独立，不做模糊语义合并。
5. 概念按 name/description 完全一致合并；先重映射实体与概念 ID，再按 sourceId/targetId/type/description 合并关系。事实按 statement 和 nodeIds 集合合并，引用顺序不同不影响判重，不同证据保留。
6. 再次校验合并后的数据，确保引用完整、证据上限没有超出。每数组最多 100 项、每项证据最多 10 条、单字符串最多 4000 字符、模型 JSON 最多 200000 字符；超限失败，不截断。

去重不隐藏无效重复项，结构与逐字证据检查不等于事实语义核验。Wiki 通过调用方显式 canonical 映射跨节聚合实体与概念；未映射项保持独立，不自动按别名归并。

## 返回与边界

`EnrichedSection.schemaVersion` 为 **3**，包含 documentId、sectionId、sectionRevision、extracted、enrichment、generation。generation 保存实际供应商、模型、响应/请求 ID 和 usage（缺失为 null）。输入在模型调用前校验并复制，异步期间的外部修改不影响结果版本或证据。不提供旧格式兼容转换。

提取结果交给 [buildWiki](../wiki/README.md) 聚合跨节语义节点；`buildChunks(section, options?)` 独立运行，不接收 enrichment 或 Wiki。本阶段不构建 embeddingText、Metadata Build 或数据库记录。

`maxInputCharacters` 默认 60000，按完整 user 消息（包含规则提取结果）计数；超限直接失败，不静默截断。`maxOutputTokens` 默认 6000。拒答、截断、过滤和未知完成原因一律失败。`enrich(section, { signal })` 保持调用前后取消检查；上游 AppError 保留原语义，不叠加重试。

追踪复用 LlmClient，不记录正文、提示词、模型内容或凭据。模型调用完成不代表后续校验通过。错误码仍统一在 `../../error-codes.ts`。

## 阅读顺序

1. `types.ts`：规则数据、语义结果和 v3 外层契约。
2. `extraction.ts`：AST、引用定义与 metadata 的规则读取。
3. `enricher.ts`：规则提取、模型调用、校验与去重的编排。
4. `prompt.ts`、`knowledge-types.ts`：模型职责与分类字典。
5. `validation.ts`：结构、引用和原文证据检查。
6. `deduplication.ts`：重复项合并与实体 ID 重映射。

测试仅使用内存模型 stub，不启动模拟 API、不调用真实 SDK 或外部模型。
