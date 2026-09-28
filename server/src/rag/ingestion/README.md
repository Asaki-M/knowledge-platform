# 增量影响计算

`planSectionChanges(previous, next)` 是同步纯函数，输入为同一比较范围内的前后完整 Section 快照。缺席表示删除；不能把局部变更列表作为完整快照传入。

返回：

- `added`、`modified`、`removed`：新增、内容版本变化和删除的 Section ID。
- `sourceOnly`、`unchanged`：仅来源/顺序变化和完全未变。
- `rebuildChunkSectionIds`、`rebuildEnrichmentSectionIds`：新增或修改的节。
- `invalidateWikiSectionIds`：已修改或删除的旧节贡献。

调用方先更新 Section，再按计划处理：删除旧 Chunk，替换变更节的 Chunk 集合；修改节尚未完成提取时调用 `updateWiki` 的 `pendingSections` 撤销旧贡献，完成后提交新的 `inputs`。新节也可标记 pending。`sourceOnly` 只刷新 Section 和图来源；引用展示回查当前 Section，旧 Chunk 的绝对位置只是构建快照。

纯路径或行号移动不会安排模型调用和 Chunk 重建；改名或换父级表现为删除加新增。文档标题、元数据和跨节引用定义变化可能影响多个 Section。身份归并映射改变单独调用 `updateWiki`，不影响 Chunk。

本模块不执行任务、不持久化、不调用模型，不构建 embeddingText 或向量记录。函数只计算原文变化；切分配置、提示词或模型升级需要调用方显式安排受影响范围的重建。

错误使用统一 `AppError` 与 `INGESTION_ERROR_CODES`。单测位于 `server/test/ingestion.test.mjs`。
