---
feature: session-autoarchive
status: in-progress
updated: 2026-11-01
branch: feat/session-autoarchive
commits: 724259145a..HEAD
---

# 自动归档闲置会话

[English](session-autoarchive.md) | 中文

## Report

## [S1] Problem

会话列表只会越积越长。归档在侧边栏里是逐个会话的手动操作，因此聊过几百个会话的用户在看到列表之前不会动手清理，也没人真会清理。想要的行为是一次定期扫描：超过 30 天（默认值）没有对话的顶层会话自动加入已有的归档集，阈值可以在设置里调整。

有两个事实约束了设计。归档集已经存在——`workspaceRegistry.archiveSession()` 会把会话从所有分组视图里隐藏、保留它在工作区里的位置，客户端通过 Workspace 跟随帧得知这次写入。会话读模型没有暴露「最后活动时间」：`SessionHeader` 只有 `createdAt`，而会话列表用来算 `lastPromptAt` 的 `sessionListMetadata` 投影只对投影缓存已 checkpoint 过的会话存在。

## [S2] Design

**grill 阶段确认的决定（2026-11-01）：**

| 维度 | 决定 |
|---|---|
| 功能落点 | 新 Prism 插件 `plugins/prism-session-autoarchive`，不改核心包 |
| 「归档」的含义 | 已有的持久归档集（`workspaceRegistry.archiveSession`），用户可随时取消归档 |
| 基线分支 | 从当前检出尖端新建分支 |

**D1 —— 最后活动时间的事实来源。** `SessionPersistenceSnapshot` 新增可选字段 `updatedAt`（epoch 毫秒），由 JSONL 后端用 `stat()`/`list()` 里已经为 `sizeBytes` 读到的文件 `mtime` 填充。这是对所有会话都成立的最小来源：header 回答不了，投影缓存只对 checkpoint 过的会话有效，而为了找最后一个事件去读事件日志会在每轮扫描时解压整个会话仓库。`mtime` 是保守上界——写只会让它前进——因此扫描最多归档得晚一些，绝不会归档窗口内用过的会话。这个字段是读模型事实而非持久化的会话数据，因此不涉及会话格式版本。

**D2 —— 扫描触碰哪些会话。** 只处理顶层用户对话：跳过已归档的、已 pin 的（归档会静默丢掉 pin）、带 `origin: 'subagent'` 或 `parentSession` 的（归档一个仍可恢复的子会话会让已归档会话门禁拒绝它之后的步骤），以及未超过截止时间的。唯一时钟是 `max(header.createdAt, snapshot.updatedAt ?? 0)`。

**D3 —— 归档运行中的会话。** 扫描调用 `archiveSession(id)` 时不传 `stopActivity`。注册表自己的 `workspace/session-activity` 瀑布随后会拒绝仍有工作的会话（`WorkspaceActiveSessionError`），扫描以 debug 级别记录并继续下一个会话。自动归档绝不能取消用户正在跑的回合，因此这次拒绝是预期结果而不是要绕开的问题。

**D4 —— 调度。** `ctx.interval`（注入的 `timer` 服务）每 `sweepIntervalMinutes` 跑一轮扫描，并在加载 60 秒后先跑一轮，使重启不会把首次扫描推迟一整个周期；这 60 秒是启动保护，不是部署选项。同一时刻只跑一轮：上一轮未结束时到达的 tick 立即返回，慢速列举不会堆叠。失败的一轮只记 warning，下一个 tick 照常；同一轮内不做重试。

**D5 —— 配置。** 三个字段全部 `.volatile()`，使由 schema 生成的设置页可以实时编辑：`enabled`（默认 `true`）、`idleDays`（默认 `30`，1–3650）、`sweepIntervalMinutes`（默认 `1440`，5–10080）。取值写在 `cordis.patch.yml` 里作为出厂默认，`resolveConfig` 显式写出每个默认值，而不是依赖 Loader 应用。

**D6 —— 依赖的服务。** `inject = ['workspaceRegistry', 'sessionPersistence', 'timer']`。缺任何一个的组合都无法正确扫描，因此插件在加载时失败，而不是降级成静默空转。

## [S3] Scope

- 范围内：`SessionPersistenceSnapshot` 的 `updatedAt` 读模型字段及其 JSONL 后端填充；新插件包（配置、扫描、选择、`cordis.patch.yml`、README 双语对）;选择与归档的单元测试；把构建好的插件装进本地 `~/.prism` profile，使运行中的应用暴露设置开关。
- 范围外：自动生成的设置页之外的客户端 UI；归档集含义或侧边栏渲染已归档会话的任何改动；删除会话数据；归档空会话（从未收到用户消息的会话）；手动「立即归档」命令；没有 Workspace 注册表的 headless profile。

## Tasks

- [x] T1: 给 `SessionPersistenceSnapshot` 加 `updatedAt`，在 JSONL 后端的 `stat`/`list` 填充，并补一条 spec 断言（depends: none）
- [x] T2: 搭 `plugins/prism-session-autoarchive` 骨架（package.json、tsconfig、tsdown、vitest、cordis.patch.yml、.gitignore）（depends: none）
- [x] T3: 在 `src/` 实现配置解析与扫描选择/归档（depends: T1, T2）
- [x] T4: 选择与归档的单元测试，以及证明运行中会话被拒绝的组合测试（depends: T3）
- [x] T5: README 双语对与配对记录（depends: T3）
- [x] T6: 构建插件并装进本地 profile，验证设置项出现（depends: T4, T5）

## [S4] Acceptance

- 最后活动早于 `idleDays` 的顶层会话在一轮扫描后被加入归档集；窗口内的会话不会。
- 已归档、已 pin、子代理、分叉会话永远不会被扫描归档。
- 有运行中工作的会话被注册表拒绝，扫描继续处理其余会话。
- `idleDays` 与 `enabled` 可以在设置页编辑，下一轮扫描使用新值。
- JSONL 后端的 `sessionPersistence.list()` 对已存会话报告 `updatedAt`，且该字段的约定记录在快照类型上。

## Delivery notes

- 插件以 profile 依赖的形式装进 `~/.prism/profiles/web`（`prism plugin --profile web add file:…`），`prism --profile web --dump-config` 能组合出该条目与出厂配置。运行中的应用要等到下次启动才会激活：桌面 shell 在启动时重写 profile 的 bundle 列表，会丢掉手写的条目，而 profile 的插件只在应用拉起服务进程时挂载。
- `gen-cordis-catalog` 在这次改动之前就已经在该检出上失败（24 处与本次无关的服务，如 `speechToText`，存在签名类型链接违规），因此生成式 API 目录无法刷新；改为更新 `docs/subsystems/persistence.md` 里手工维护的 `SessionPersistenceSnapshot` 副本。
