# Section：事实来源

`rag/sections/index.ts` 导出同步纯函数 `splitSections(document)`、`sectionRevision(section)` 和 `assertSection(section)`。Section 独立于 Chunk、Enrichment 和 Wiki，不调用模型或数据库。

## 分节与身份

- 只按标准 AST 顶层 H1–H3 分节；H4–H6 留在当前节正文。代码、引用、列表内部的标题不成为边界。
- 保留无标题前言、跳级标题、父子关系；父节正文不重复包含子节正文。空文档不生成 Section。
- `documentId` 来自调用方稳定的 `source.id`；`sourcePath` 来自 `source.path`，缺失时为 `null`。移动文件时调用方应保持文档 ID。
- Section ID 对文档 ID、祖先路径身份、标题深度、标题文本和同父级重名序号计算哈希。前言使用固定身份；普通章节插入不影响其他标题身份。
- 改名或换父级视为删除加新增。同父级重名组内插入可能改变后续重名节及其子节 ID；不做模糊匹配。

## 内容与来源

Section 保存标准 `ast`、`markdown`、`text`，以及原文 frontmatter、文档标题、`headingPath`、`parentId`、`blockRange` 和可用的位置。

`sourceFragments` 与本节拥有的标准顶层块对应，直接截取 Normalization 的 `originalContent`，不是从 Markdown 重新生成的 MDX。每条包含 `text`、可选 `position` 和 `exact`；合成容器只有子节点的包围范围时 `exact=false`，位置不可用时 `text=null`。被标准化剔除的页面程序仍保留在文档原文中，不当作标准知识正文。

独立解释链接、图片、脚注所需的跨节定义补入 AST，并在 `referenceSources` 中单独记录 Section AST 块索引、文档块索引及源片段，不扩大本节拥有的原文范围。嵌套定义记录所属文档顶层块索引，源片段仍定位到定义本身。

`revision` 包含文档身份、标题上下文、元数据、标准正文、本节原始片段和补入定义内容；不包含路径、绝对行列、章节顺序。正文或引用内容变化使版本失效；纯位置变化不需要重新提取知识。文档标题或 frontmatter 改变会影响所有消费该上下文的节。

`assertSection` 复查 AST/Markdown、内容版本与当前标题路径的一致性；下游拒绝直接修改正文却沿用旧 revision 的对象。`sectionRevision` 用于确定性计算，不替代输入校验。

## 下游

两条分支独立执行：`buildChunks(section, options?)` 构建检索片段，`KnowledgeEnricher.enrich(section)` 提取语义贡献。标题层级属于 Section，不作为语义图的实体关系。

本模块的错误使用 `AppError` 和 `SECTION_SPLIT_ERROR_CODES`。测试为 `server/test/section-split.test.mjs`，不启动服务。
