# Wiki：跨 Section 的语义聚合

Wiki 节点表示 Entity 或 Concept，页面是这些语义节点的确定性投影。Section 保持事实来源和标题层级；Chunk 保持独立的检索职责。Wiki 构建不调用模型、不访问链接、不写数据库。

## 公共接口

- `buildWiki(inputs, options)`：输入 `{ section, enrichedSection }[]`，生成 `WikiBuildResult` v2。
- `updateWiki(previous, update, options)`：撤销和替换指定 Section 的贡献，复用未变化的节点页面。
- `getWikiNodesForSection(wiki, sectionId, sectionRevision)`：返回当前 Section 关联的多个节点；版本不匹配时报错，尚无有效贡献时返回空数组。

`options` 必须显式提供 `knowledgeBaseId`、`canonicalNodes` 和 `mappings`。调用方负责知识库边界，同次构建不能混入其他知识库文档。

```ts
const options = {
  knowledgeBaseId: 'docs',
  canonicalNodes: [{ id: 'atlas', kind: 'entity', title: 'Atlas' }],
  mappings: [
    {
      sectionId: section.id,
      sectionRevision: section.revision,
      localNodeId: 'e1',
      canonicalId: 'atlas',
    },
  ],
}
```

canonical ID 在知识库内稳定且唯一。映射绑定 Section revision 和提取后的局部 ID；无映射对象使用知识库、Section ID、revision、局部 ID 隔离身份。同名、别名和关键词相似都不自动合并。重复、失效、缺少目标或 entity/concept 类型不匹配的映射明确失败。

## 图与证据

结果包含 `nodes`、`edges`、`sectionLinks`、`contributions`、`pendingSections`。

- `nodes` 的 `kind` 为 `entity` 或 `concept`，一个节点可关联多个 Section。标题父子关系不作为语义边。
- `edges` 来自本节已验证关系的端点重映射，不凭共现推断；实体、概念均可作为端点。
- 节点描述、事实及关系逐项保留 `citations`：文档、路径、Section ID/revision、标题路径、逐字证据与生成信息。
- 完全相同的主张合并来源；不同描述、条件或矛盾陈述分别保留。没有节点引用的事实仍保留在 Section contribution，不随意分配给所有节点。
- Markdown 使用标准 AST 转义模型文本，汇编相关描述、事实、关系及逐条引用，不复制整节摘要，不额外生成综合文章。
- `contributions` 保留各 Section 的实体、概念、关系、事实及来源，支持独立撤销；不复制完整原文。原文需要回查 Section。

构建前校验 Section revision、规则提取投影、语义结构及逐字证据。证据存在不等于已完成事实语义核验。

## 增量更新

`update` 接收 `inputs`、`removedSectionIds`，以及可选的 `pendingSections`、`sourceUpdates`。这些操作中的 Section ID 必须互斥。

- 新提取结果替换同节旧贡献；删除撤销其全部贡献。共享节点保留其他节证据，没有来源的节点和关系删除。
- 变更原文尚未提取时传 `pendingSections`，先撤销旧知识并记录待重建版本，之后通过 `inputs` 提交新结果。
- 路径或位置变化且内容版本相同，传 `sourceUpdates` 刷新引用，不需要再次调用模型。
- 每次传入当前有效的**完整**身份映射。删除或 pending 的节必须移除其旧映射，新 revision 必须重新确认映射；过期映射不自动修复。
- 映射改变可直接更新图，无需重切 Chunk 或再次提取。旧、新目标节点及关联关系会更新。
- 节点与关系均比较贡献 revision，未改变的关系跳过证据聚合，未改变的节点跳过知识聚合及页面渲染；所有输出与输入对象隔离，输入顺序不影响图结果。

[影响计算](../ingestion/README.md) 决定哪些 Section 需要重建；这里不提供任务队列、原子数据库发布或完整 ingestion 编排。源路径更新会刷新页面及节点版本，但不会改变 Section 内容版本。

错误使用 `AppError` 和 `WIKI_ERROR_CODES`。`server/test/wiki.test.mjs` 使用内存数据验证全量/增量一致性、来源撤销、身份映射、转义及不可变性，不启动服务。
