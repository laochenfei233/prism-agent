---
feature: folder-to-project
status: delivered
updated: 2026-11-24
branch: feat/folder-to-project
commits: 26b7c472a5..dd14a7ee93
---

# 文件夹拉取为项目

[English](folder-to-project.md) | 中文

## Report

**交付内容** —— 现在把文件夹拖到桌面端应用里，会询问是否将其注册为独立项目。附件层的文档级拖放处理器通过 entry API 识别目录成员（桌面端经 `__DSH_HOST_PATHS__` / WebView2 `File.path` 解析路径），不再默默生成引用附件，而是为第一个拖入的文件夹弹出确认对话框：创建项目、仅作为引用（旧的引用附件行为）或取消。选择创建时，先调用 `workspaces.create({ path })`，再调用 `uiWorkspace.openWorkspace(workspaceId)`——服务在拖放时经最小结构类型转换惰性解析，因此新项目指向文件夹的原始路径，并带着一个已连接的会话打开。待决定期间或创建进行中到达的后续拖放会走旧接收逻辑，任何一批拖放都不会丢失；浏览器里没有宿主路径的拖放维持仅桌面提示；仅文件的拖放完全不变。

确认对话框、待决定状态与注入的 `createProjectFromDirectory` 能力位于 `ui-attachment` 的 `ComposerAttachments`；拦截回调穿过 `drop-events.ts` 接入。宿主路径桥助手按包私有存放（`ui-conversation/src/client/host-path.ts` 在输入框接收逻辑旁，`ui-attachment/src/client/host-path.ts` 在对话框旁），因为 client feature 包不允许跨插件值导入（`verify-client-packages`）。新增的 `attachment.folderProject.*` 键覆盖全部八种 conversation 语言；ui-attachment 的 README 以双语记录了该流程。

**验证** —— `pnpm run build`（build:artifacts + build:check）：最终代码上 9/9 门禁通过，含 client 编译器、Client bundle 纯净性、Web 构建与两个聚合类型检查。`pnpm exec vitest run packages/client/ui-attachment/tests packages/client/ui-conversation/tests`：940 + 59 个测试通过，其中含 7 个新的 folder-to-project 用例（创建/引用/取消/Web 回退/不可接收/待决竞态/失败）。`pnpm exec tsc -b packages/client/ui-attachment`：退出码 0。`pnpm run verify-client-packages`：通过。两包定向 oxlint：改动文件 0 错误（`InputBar.tsx` 存在 6 个既有错误）。`verify-translation-pairing`、`verify-md-wrap`、`verify-export-jsdoc`、`verify-concrete-terms`：改动文件零命中（其余失败均为 master 基线已知红灯——speech/experimental/webserver/subagent 的 JSDoc 与 model-experience、meeting-*/http-asr/hachimodock 配对记录、根 README 的内存审计行、ui-conversation README 摘要超长、ui-file-actions/prism-meeting 死链、cordis catalog、持久化清单——全部位于本 diff 之外的文件）。

**Journey log** —— 最初实现通过 `ui-conversation` 的 client 入口再导出宿主路径助手，并在 `dsh.client.external` 中声明该子路径；tsdown 打包纯净性门禁放行了它，但独立审查发现 `verify-client-packages` 会拒绝 client feature 包的跨插件运行时导入——现在助手改为各包私有副本，待出现第三个使用方再并入共享包。第二个审查发现是丢失更新竞态：确认对话框待决时再拖入文件夹会覆盖第一个待决项；现在待决/进行中的拖放回落到旧接收逻辑，并配有回归测试。

## [S1] 问题

把文件夹拖到应用里目前只会向输入框草稿插入一条 `@path/` 引用附件。没有任何链路能把拖入的文件夹变成独立项目（workspace），用户想建项目时只能在侧栏目录选择器里重新选一遍文件夹。

## [S2] 设计

### S2.1 目录拖放拦截

`installDocumentDropEvents` 新增可选的 `onDirectories(files, directories, addAsReferences)` 回调。当一次拖放包含至少一个目录且当前视图接受拖放（`canAcceptDrop`）时，该回调取代直接的 `onAddFiles` 调用；`addAsReferences()` 会按原逻辑重新走一遍附件接收，保留旧的引用附件行为。当文件夹的决定还待处理或创建正在进行时，新到的拖放同样走 `addAsReferences()`，任何一批拖放都不会丢失或被覆盖。仅文件的拖放完全不变。只有桌面外壳能解析拖入目录的绝对路径（`__DSH_HOST_PATHS__` / WebView2 `File.path`）；浏览器里解析不到路径的目录拖放会落回现有接收逻辑，由它报告 `attachment.directoryDesktopOnly`。

### S2.2 创建项目确认框

`ComposerAttachments` 为第一个拖入的目录持有确认对话框（primitives 的 `Modal` + `Button`）：标题、文件夹名，以及三个动作——创建项目（主按钮）、仅作为引用（旧行为）、取消。创建成功即关闭对话框；失败则保留对话框并显示错误文本。对话框只在有待处理的文件夹拖入时渲染。

### S2.3 工作区接线

附件插件的注入面新增可选的 `createProjectFromDirectory(path)`：先 `ctx.get('workspaces').create({ path })`，再 `ctx.get('uiWorkspace').openWorkspace(workspaceId)`——registry 注册项目，`openWorkspace` 在其中连接一个会话。服务在拖放时才惰性读取，使用最小结构类型转换；不新增包依赖。创建的项目指向原始目录（引用语义——不复制文件，与 workspace registry 一致）。

### S2.4 搬迁与文案

新增 `attachment.folderProject.*` 键加入 `conversation` 命名空间的八种语言词典（zh、en、ja、es、fr、de、ru、pt）。拖放文件夹的宿主路径助手保持包内私有：`ui-conversation` 留在输入框接收逻辑旁，`ui-attachment` 持有一份私有副本——因为 client feature 包不允许跨插件值导入（`verify-client-packages`）；若出现第三个使用方，再并入共享的非 row 包。

## Scope

- 范围内：文档级目录拖放拦截、确认对话框、工作区创建并打开的接线、八语言文案、单元测试、README 说明。
- 范围外：把文件夹内容复制进应用自有目录、Git URL 拉取、Web 端文件夹拉取、改动输入框对普通文件（非目录）的拖放行为、改已存在会话的 cwd。

## Tasks

- [x] T1：抽取 `host-path.ts` 助手并再导出（依赖：无）
- [x] T2：在 `drop-events.ts` 加入 `onDirectories` 拦截（依赖：无）
- [x] T3：`ui-attachment` 的对话框与注入 `createProjectFromDirectory`（依赖：T1、T2）
- [x] T4：八语言文案键（依赖：T3）
- [x] T5：创建 / 引用 / 取消 / Web 回退的单元测试（依赖：T3）
- [x] T6：README 更新（依赖：T3）

## [S4] 验收

- [x] 桌面端拖入文件夹会询问是否创建独立项目；确认后按文件夹原始路径注册工作区，并打开一个已连接的会话。
- [x] 选择"仅作为引用"完全复现现有引用附件行为；取消则不产生任何变化。
- [x] 浏览器（无宿主路径桥）的目录拖放仍报告仅桌面支持的提示，不创建任何东西。
- [x] 仅文件的拖放行为逐字节保持不变。
- [x] 八种 conversation 语言都带有新键；typecheck 与该包的 client 测试通过。
