# 文档标准化接入层

业务通过 `NormalizationClient` 选择适配器；每种文档格式自己解析和转换，统一输出 `NormalizedDocument`。当前提供针对 `nextra-docs` 的 `NextraMdxAdapter`，不依赖 Nextra 运行时，不读取模型 Key。

```text
NormalizationClient.normalize({ adapter, source, content })
  → adapters/nextra-mdx：MDX → 原始 mdast（含 JSX / ESTree）
  → normalizeTree：组件与表达式 → 标准 Markdown / GFM mdast
  → NormalizedDocument：ast + markdown + text + metadata + warnings
  → Section Split（已实现）→ Knowledge Enrichment → Chunk Build
  → Metadata Build → Embedding → Vector Record → Vector DB（后续逐步实现）
```

## 目录与阅读顺序

```text
normalization/
├── index.ts                # 公共出口
├── types.ts                # 输入、统一文档和 Adapter 契约
├── client.ts               # 注册、分发、校验、取消和追踪
└── adapters/
    └── nextra-mdx/
        ├── index.ts        # 适配器出口
        ├── adapter.ts      # 串起解析、转换与输出
        ├── parser.ts       # remark 解析配置，保留原文位置
        ├── transform.ts    # 元数据、MDX 和组件规则
        ├── static-value.ts # 只读取 ESTree 静态值，不执行代码
        ├── table.ts        # ExpandableTable 字段展开
        └── tree.ts         # 块/行内结构整理
```

建议依次读：**types.ts → client.ts → adapter.ts → parser.ts → transform.ts → static-value.ts / table.ts / tree.ts**。错误分类及中文含义见 [error-codes.ts](../../error-codes.ts)。

## 调用

```ts
import {
  NextraMdxAdapter,
  NormalizationClient,
} from './rag/normalization/index.js'

const normalization = new NormalizationClient([new NextraMdxAdapter()])
const document = await normalization.normalize({
  adapter: 'nextra-mdx',
  source: { id: 'guide/intro.mdx', path: 'guide/intro.mdx' },
  content: '# 接入指南\n\n正文内容',
})

// Wiki 阶段可读取 Markdown；切分阶段可沿 AST 的 heading/code/table 等结构处理。
const { ast, markdown, text, warnings } = document
```

`source.id` 由调用方提供，跨知识库使用时应加知识库前缀。适配器不绑定本地路径、上传、数据库或 HTTP，加载内容由上层负责。调用不会启动 Section Split、知识补充、Embedding 或 LLM。

## 输出约定

- `schemaVersion: 1`：输出版本；新增格式仍返回相同契约。
- `source`：原样保留调用方提供的来源，用于回溯。
- `title`：优先 YAML `title`，其次第一个一级标题，无标题为 `null`。
- `metadata`：YAML frontmatter 的 JSON 元数据，不混入正文。
- `ast`：标准 [mdast](https://github.com/syntax-tree/mdast)，含 [GFM](https://github.com/remarkjs/remark-gfm) 表格、任务列表等，不含 MDX、ESM 或原始 HTML 节点。它是统一文档结构，不是 React AST。
- `markdown` / `text`：从同一份标准化 AST 派生；代码块的语言与原始内容保留，纯文本保留表格边界及图片 alt，链接地址保存在 AST 和 Markdown 中。
- `warnings`：无法提取的动态内容、未知组件或被移除的脚本等处理提示；调用方应检查后再决定是否入库。空文档允许返回，不等于有可检索内容。

AST 的 `position` 和 warning 位置指向**输入 MDX**，行列从 1 开始；合成的表格子节点未必有独立位置，可回溯所属组件的位置。没有对内容做 OCR、网页抓取、链接补全或事实改写。Markdown 是知识处理产物，如要渲染仍需应用自己的渲染策略。

## 当前 Nextra 规则

| 输入                                                     | 标准化结果                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| 标题、段落、列表、引用、代码、GFM 表格、链接及引用式链接 | 保留结构与内容                                                          |
| YAML frontmatter                                         | 移入 metadata                                                           |
| import / export、MDX 注释                                | 移除，不加载依赖、不执行代码                                            |
| `ZoomImage` / `img`                                      | 图片节点，保留静态 src、alt                                             |
| `Download` / `a`                                         | 链接节点，保留静态 href 和子内容                                        |
| `Callout`                                                | 引用块，保留 title 和正文                                               |
| `ExpandableTable`                                        | 完整表格，嵌套字段展开成 `data.user.id`，保留自定义列及 Markdown 单元格 |
| `table` / `thead` / `tbody` / `tr` / `th` / `td`         | 标准表格，保留行列边界                                                  |
| `h1`–`h6`、`p`、`br`、粗体与斜体 HTML                    | 对应标准节点                                                            |
| `div` / `span` / `details` / fragment                    | 去除布局包装，保留子内容                                                |
| 静态字符串或数字表达式                                   | 可见文本                                                                |
| 其他表达式、未知组件                                     | 不执行；尽可能保留子内容，并返回 warning                                |
| `script` / `style`                                       | 移除并返回 warning                                                      |

表格属性支持字符串、数字、布尔、null、数组、对象、无插值模板字符串，以及说明文字中的静态 JSX fragment / 排版标签。变量、函数调用、展开、计算属性等不会被求值；遇到不支持的表格数据会产生 warning，不会假装提取成功。不读取 `_meta.json`，不把导出的 JavaScript 常量当作运行时数据。

MDX 语法或 YAML 错误会抛出公共 [AppError](../../errors.ts)，保留错误分类和可用的行列位置，不向日志透出原始解析错误中的文档片段。同步解析期间不能中途抢占，取消信号在调用前后检查。

## 当前流程边界

本阶段只实现 `Normalized Document`：调用方传入来源和正文，得到统一文档。没有 CLI、目录导入、HTTP 接口或自动扫描路径。`nextra-docs` 用于验证适配规则，不会硬编码到运行时。

标准化后可调用 [splitSections](../chunking/README.md) 完成 Section Split。Section Split 后可调用 [KnowledgeEnricher](../enrichment/README.md) 补充结构化知识。之后可调用 [buildChunks](../chunking/README.md#chunk-build) 构建 chunk。后续按 `Metadata Build → Embedding → Vector Record → Vector DB` 逐步接入。按标题切分、summary / keywords / wiki node / links 补充、embeddingText 拼装和 pgvector 写入都不属于当前 normalization 的职责。这里的 `metadata` 只保留原文 frontmatter，后续 Metadata Build 再构建检索所需的元数据。

## 接入下一种格式

1. 在 `adapters/<格式>/` 下实现 `NormalizationAdapter`，提供唯一 `name` 和 `normalize(input)`。
2. 使用该格式自己的解析器建立 AST，再映射为统一的 Markdown / GFM mdast 与 `NormalizedDocument`。
3. 将可预期异常转为 `AppError`；新分类只添加到公共 `error-codes.ts` 并说明含义。
4. 通过构造参数或 `client.register(adapter)` 注册，由调用方显式选择适配器。
5. 添加格式样例和契约测试，不在 `client.ts` 中添加格式分支。

无需为未来厂商或格式预建空文件。通用请求分发与 OpenTelemetry 由客户端负责，日志只包含适配器标识、状态、耗时和 warning 数，不记录来源路径或文档正文。
