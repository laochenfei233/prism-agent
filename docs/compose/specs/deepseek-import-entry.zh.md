---
feature: deepseek-import-entry
status: designed
updated: 2026-11-24
branch: feat/deepseek-import-entry
commits: 待交付时回填
---

# DeepSeek 导出导入入口迁入"导入对话"页并置首

English | [中文](deepseek-import-entry.md)

## Report

待实施后回填。

## [S1] Problem

上游 `packages/experimental/deepseek-chat-import`（导入 chat.deepseek.com 的 `deepseek_data-*.zip` 导出）目前把自己的入口挂在侧边栏：`src/client/mount.ts` 向 `sidebar.session.action` 槽注入一个按钮，位于 "New session" 旁。而 fork 已有统一的"导入对话"页——`packages/session-query/session-import` 以 `settings.data.page` 槽（id `cross-agent`）挂在数据设置区，页内按 `IMPORT_SOURCE_IDS` 顺序展示十一个来源（claude、codex、grok、dsh、mimocode、opencode、openclaw、hermes、pi、gemini、zcode）。同一件事两个入口：侧边栏一个、导入页十一个，入口分裂。决策：取消上游原有侧边栏入口，把 DeepSeek 导出作为导入页的第一个来源卡。

## [S2] Design

### S2.1 移除侧边栏入口

`packages/experimental/deepseek-chat-import/src/client/mount.ts` 的 `registerUi` 删除 `ctx.slots.inject('sidebar.session.action', ...)` 整段；Remote mount、`limits()` 预检、`uploadArchive` 上传与进度/结果对话框机制全部保留（它们是引擎，不随入口退役）。侧边栏不再出现 DeepSeek 导入按钮。

### S2.2 session-import 新增有序来源扩展槽

`packages/session-query/session-import` 的 client 增加槽位 `settings.sessionImport.source`（SlotMap，带 `order`），渲染在内置十来源列表**之前**；无贡献时不渲染容器。导入页的展示顺序变为：扩展来源卡（按 order）→ `IMPORT_SOURCE_IDS` 十来源。session-import 不感知任何具体扩展。

### S2.3 deepseek 贡献首卡

deepseek-chat-import 的 client 在启用时向 `settings.sessionImport.source` 贡献一张来源卡：

- id `deepseek-export`，`order` 置于最前（渲染第一）。
- 文案："DeepSeek 网页版导出（ZIP）"——导入 chat.deepseek.com 导出的 `deepseek_data-*.zip`，保留原题/时间/推理/搜索卡，可继续对话（复用包内现有 8 语言 locale）。
- 动作：点击打开现有的 `ImportSessions` 对话框（文件选择 + Workspace 选择 + 上传/导入进度 + 结果），完整复用既有流程，不改协议与路由。
- bundle 未启用时该 client 不挂载，导入页自然无此卡——可选语义由槽位贡献天然满足。

### S2.4 依赖方向与门禁

`verify-client-packages` 禁止 feature 包跨插件运行时导入，因此 session-import **不 import** deepseek-chat-import；卡片组件由 deepseek-chat-import 自己经槽位注册（与 sidebar HOC、settings 扩展同一机制）。两个包各自的 locale 命名空间不变（`settings.sessionImport` 仍归 session-import，deepseek 卡用自己包的 NS）。

### S2.5 测试与文档

- `packages/experimental/deepseek-chat-import/tests/mount.client.spec.ts`：侧边栏注入断言改为"贡献 `settings.sessionImport.source` 首卡 + 不再注入 sidebar.session.action"。
- `packages/session-query/session-import/tests/section.client.spec.tsx`：新增扩展卡渲染顺序用例（有贡献时排在内置来源前；无贡献时不渲染容器）。
- 两个包 README 的入口描述同步改写（含 `.zh.md` 与 `i18n.yaml` 配对重录）。

## [S3] Scope

- In scope：deepseek-chat-import 的 mount 改造、session-import 的扩展槽与渲染顺序、双方测试、README 配对。
- Out of scope：导入引擎/上传协议/NDJSON 进度（`src/{archive,importer,upload,conversation}.ts` 与 Host 路由）零改动；session-import 十来源的扫描逻辑；其他可选 bundle。

## Tasks

- [ ] T1: session-import 增加 `settings.sessionImport.source` 有序槽与前置渲染 (depends: none)
- [ ] T2: deepseek-chat-import mount 改造——删侧边栏注入、加槽位贡献卡（order 置首） (depends: T1)
- [ ] T3: 双方测试更新（mount 断言、section 顺序用例） (depends: T2)
- [ ] T4: README/升级指南入口描述更新 + pairing 重录 (depends: T2)

## [S4] Acceptance

- [ ] 侧边栏 "New session" 旁不再有 DeepSeek 导入按钮（`sidebar.session.action` 无 deepseek-chat-import 贡献）。
- [ ] 启用该 bundle 后，"导入对话"页第一张来源卡是 DeepSeek 网页版导出（ZIP），点击打开原导入对话框并能完成一次真实上传导入。
- [ ] 未启用 bundle 时导入页与现状一致（十来源、无空容器）。
- [ ] session-import 源码无对 deepseek-chat-import 的 import；verify-client-packages 通过。
- [ ] 两个包的 typecheck、测试与 doc-sync（含 pairing）通过。
