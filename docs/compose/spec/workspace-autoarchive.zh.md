---
feature: workspace-autoarchive
status: in-progress
updated: 2026-11-21
branch: feat/workspace-autoarchive
commits: f9433f3732..HEAD
---

# 自动归档闲置项目

[English](workspace-autoarchive.md) | 中文

## Report

## [S1] Problem

项目永远不会离开侧栏。会话自动归档扫描已经把闲置 `idleDays` 的对话全部隐藏，于是一个项目最终只剩一个空分组 —— 而用户几个月前就放弃的项目仍然永远占着列表。期望的行为搭同一趟扫描的车：当一个项目里不再有任何可见对话、且其最新活动早于项目窗口（本部署为对话闲置 7 天再加 7 天，共 14 天）时，项目本身加入归档集合，从侧栏、项目选择器和搜索里消失。之后再添加同一文件夹必须带回原项目 —— 同一身份、标题、顺序和会话账目，绝不是第二条注册；设置页另加「已归档项目」一节，列出被隐藏的项目并提供逐行恢复。

## [S2] Design

**Grill 已确认的决策（2026-11-21）：**

| 轴 | 决策 |
|---|---|
| 行为挂在哪里 | 现有 `prism-session-autoarchive` 插件：同一趟扫描在归档对话之后评估项目 |
| 「归档项目」的含义 | 新的注册表级归档集合，仅显示层：记录、顺序、标题、置顶和会话账目全部不动 |
| 恢复入口 | 重新添加文件夹（注册表 `create`）即恢复；设置页「已归档项目」一节列出隐藏项目并支持逐行恢复 |
| 项目窗口 | `projectIdleDays`，默认 14，从最新活动起算的绝对值 —— 配合部署的 `idleDays: 7` 正好是 7+7 |

**D1 — 项目归档集合。** `workspaceDomainState` 增加 `archivedWorkspaceIds: z.array(workspaceId).default([])`，沿用 `archivedSessionIds` 引入时的 defaulted 字段模式；早于该字段的存量 global 原样解析，domain 版本保持 2。与会话归档集合一样，这个集合只是显示层状态：归档或恢复项目时 `WorkspaceRecord`、`workspaceIds` 顺序、成员账目和置顶都不变，恢复后与归档前逐字节相同。集合不参与启动时对 `workspaces` 表的校验 —— 崩溃窗口删除后的陈旧 id 无害（每个消费方都容忍未知 id），会话集合也是同样的宽松先例。

**D2 — 注册表 API。** `WorkspaceRegistry` 增加 `archivedWorkspaceIds`、`archiveWorkspace(id)`、`unarchiveWorkspace(id)`，两者都走队列串行、幂等、容忍未知 id，与会话侧对应方法一致。`deleteKnown` 在其持久写入中把 id 从集合里去掉。`createCanonical` 既有的 canonical-path 复用分支就地解除隐藏（在排队操作内部，绝不经由公开方法 —— 队列会等自己）：重新添加文件夹恢复原注册。`validateStoredState` 不变。

**D3 — 每条 create 路径都恢复。** `WorkspaceCommands.create` 现在在 `resolveByPath` 命中时提前返回；改为总是调用 `registry.create(path)` —— 复用时解除隐藏 —— 并用预先解析的结果计算 `created`，于是 controller、导入引擎和其他内部调用方都恢复而非重新注册。canonical-path 唯一性本来就不可能产生重复记录，「项目 (2)」从构造上不存在。

**D4 — 线路与客户端模型。** `WorkspaceBaseline` 增加 `archivedWorkspaceIds`，一条新的增量帧 `{ type: 'archived-workspaces', archivedWorkspaceIds }` 加入既有 `archived`/`pinned` 集合帧；feed 与会话集合一样从解析后的 domain 状态做差量。客户端模型把集合装进快照，service 解码该帧，`UiWorkspaceService` 增加 `unarchiveWorkspace(workspaceId)`，以与会话变更相同的 echo 纪律调用新的 Remote 方法。

**D5 — 新 Remote 方法。** `workspace.archiveWorkspace` 与 `workspace.unarchiveWorkspace` 接受 `workspaceId` 并返回完整更新后的集合；未知 id 幂等解析（移除不会引入未知 id，归档未知 id 是无操作而非失败，与 `unarchiveSession` 一致）。

**D6 — 客户端投影过滤。** 快照保持权威 —— 隐藏项目仍在 `items` 里 —— 每个投影按集合过滤：侧栏树分组、对话首行的项目选择器、会话搜索。隐藏项目的会话无处渲染，与已归档会话完全一致。

**D7 — 扫描评估。** 对话趟之后是一趟项目评估，遍历 `registry.list()`：可见指实体账目里存在顶层未归档会话（`origin` 非 `subagent`、无 `parentSession`，置顶也算可见）；活动取全部账目会话（含已归档与子代理）的 `max(header.createdAt, snapshot.updatedAt)` —— 保守锚点 —— 无账目会话的项目取 `Date.parse(record.createdAt)`。项目没有可见会话且活动至少 `projectIdleDays` 旧时隐藏；隐藏项目一旦出现可见会话当场恢复，这样计划任务、导入或 webhook 往隐藏项目里挂会话时，项目在一次扫描内自己回来，而不是把会话困在不可见的分组里。写入走注册表方法，每次写入都经 follow 帧到达客户端。

**D8 — 配置。** `projectIdleDays`（自然数，1–3650，默认 14，volatile）加入 `enabled`/`idleDays`/`sweepIntervalMinutes`；`resolveConfig` 显式陈述。没有每次扫描的配额：该趟幂等且以注册表大小为界。

**D9 — 设置节。** 插件浏览器半边（`prism-about` 打包配方：`dsh.client`、`./client` 导出、`window.__ModuleLoader__` CJS banner、壳 seat 结构化声明）注册 `settings.section` id `archived-projects`、order 45。它读取客户端 Workspace 快照，列出每个隐藏项目（标题、路径、最新活动距今），并经 `ctx.uiWorkspace.unarchiveWorkspace` 逐行恢复。不做全部恢复：全恢复等于推翻这一节存在的卫生意义。本地化：zh 与 en 词典。

**D10 — 不受影响的消费方。** `registry.list()`、transfer/backup 导出和所有其他注册表读取方继续看到隐藏项目；只有点名的投影过滤。不碰会话数据、不删项目、扫描绝不取消运行中的工作（会话趟的拒绝语义原样保留）。

## [S3] Scope

- In scope：domain 字段与注册表 API；controller 方法、feed 帧、客户端 model/service 管线；侧栏/选择器/搜索过滤；扫描的项目趟与 `projectIdleDays`；插件浏览器半边与设置节；各自的单元测试；插件 README 对；本规格三件套；变更记录条目。
- Out of scope：删除项目记录或会话数据；客户端手动「归档项目」手势；恢复已归档对话（对话节自己负责）；从 `feat/prism-session-autoarchive` 合并已归档对话客户端半边；现有测试装置之外的 recorded-session 快照支持；Workspace 帧的 Python SDK 投影。

## Tasks

- [ ] T1：domain 字段 + 注册表集合/读取/归档/恢复，create 复用恢复，delete 清理（covers: D1, D2, D3）
- [ ] T2：controller 方法 + feed baseline/帧 + 客户端 model/service/UiWorkspace（covers: D4, D5）
- [ ] T3：客户端在树、选择器、搜索中过滤（covers: D6）
- [ ] T4：扫描项目趟 + `projectIdleDays` 配置（covers: D7, D8）
- [ ] T5：插件浏览器半边、设置节、词典、打包（covers: D9）
- [ ] T6：README 对、变更记录、规格三件套 pairing 记录（covers: S3）

## [S4] Acceptance

- [ ] 无可见顶层会话且最新活动至少 `projectIdleDays` 旧的项目在扫描后进入 `archivedWorkspaceIds`；其记录、顺序、标题和 `sessionIds` 不变。
- [ ] 有可见顶层未归档会话的项目绝不隐藏；隐藏项目一旦出现一个，下一趟扫描解除隐藏。
- [ ] 对隐藏项目的 canonical path 调 `registry.create(path)` 解除隐藏并返回既有实体；controller 报告 `created: false`；不存在第二条记录。
- [ ] baseline 携带 `archivedWorkspaceIds`；一次变更发布新帧；侧栏、选择器、搜索排除隐藏项目，设置节列出它们且逐行恢复可用。
- [ ] 删除项目时从集合移除；集合里的未知 id 不破坏任何东西。
- [ ] 缺新字段的存量 global 在 domain 版本 2 下原样打开。
