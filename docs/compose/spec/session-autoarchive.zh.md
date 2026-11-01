---
feature: session-autoarchive
status: delivered
updated: 2026-11-01
branch: feat/session-autoarchive
commits: 724259145a..HEAD
---

# 自动归档闲置会话

[English](session-autoarchive.md) | 中文

## Report

**做了什么** —— `prism-session-autoarchive` 把超过可配置天数（默认 30 天）无人触碰的对话归档进 Workspace 归档集。它每 `sweepIntervalMinutes`（默认一天）读取一次所有可见会话，跳过已归档、已 pin、子代理与分叉会话，其余按 `max(createdAt, updatedAt)` 计算活动时间，遇到仍有工作运行的会话就交给归档集自身拒绝。三个字段都是 volatile 配置项，插件自动生成的设置页可以直接改它们。

唯一的底层改动是 `SessionPersistenceSnapshot` 上的 `updatedAt`，由 JSONL 后端用它为 `sizeBytes` 已经在读的产物 `mtime` 填充。会话读模型里没有别的字段能回答「这个会话最后什么时候活跃过」：header 只有 `createdAt`，而投影缓存只对它 checkpoint 过的会话保存最后提示时间。

**验证** —— `jsonl.spec.ts` 189/189 通过（含新增的 `updatedAt` 用例）；插件套件 11/11 通过（选择、拒绝处理、逐字段经插件自身 schema 的配置解析、窗口边界）；插件 `tsc --noEmit` 退出码 0；`pnpm run build:artifacts` 6/6、`pnpm run build:check` 2/2；`pnpm run test:docs` 20 项通过，仅剩既有的 `verify-repository-references` 失败；`verify-translation-pairing` 1055 对一致；提交钩子（lint、空白、配对、vendor guard）通过。在已安装的 profile 上，`prism --profile web --dump-config` 组合出该条目与出厂配置，导入已安装包后 `resolveConfig(Config({ idleDays: 7 }))` 得到 `{"enabled":true,"idleDays":7,"sweepIntervalMinutes":1440}`，类型为普通 `boolean`/`number`。

**Journey log** ——

- 第一版把配置字段当普通值读。三个字段都是 `.volatile()`，Loader 交给插件的是 `{ get() }` 引用：闲置截止时间变成 NaN（归档一切）、`enabled: false` 永远为真、`ctx.interval(fn, NaN)` 被夹到 1 毫秒循环。评审发现后，`resolveConfig` 改为经 `isVolatile` 读取、每轮扫描重新解析，并在 `loader/volatile-update` 上重建定时器。
- 在已安装 profile 里手写的 bundle 条目在下次启动时消失，插件因此从未挂载。受支持的路径是 `prism plugin --profile web add <spec>`，它把包登记为 profile 依赖；随后用 `--dump-config` 确认条目已组合进去。
- 桌面 shell 在启动时重写 `dsh.profile.bundles`，而 profile 的插件只在应用拉起服务进程时挂载，所以第一次真实扫描要等下次启动。尝试直接观察运行实例时只看到「闲置未归档的会话全是子代理会话」（说明排除规则生效），无法证明正向归档；而且运行中的服务正是执行这次改动的 agent 会话所在，因此没有重启它。
- `gen-cordis-catalog` 在该检出上本来就失败（无关的类型链接违规），生成式 API 目录无法刷新，改为手工更新 subsystems 文档副本。
- 新工作树没有 `node_modules` 也没有构建出的 `lib/types`；要跑插件类型检查与 spec，需要先 `pnpm install --offline` 与 `pnpm run build:artifacts`，而 vitest 需要更宽的沙箱，因为 vite 会通过子进程探测 `net use`。

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

- 范围内：`SessionPersistenceSnapshot` 的 `updatedAt` 读模型字段及其 JSONL 后端填充；新插件包（配置、扫描、选择、`cordis.patch.yml`、README 双语对）;选择、配置解析与归档的单元测试；把构建好的插件装进本地 `~/.prism` profile，使运行中的应用暴露设置开关。
- 范围外：自动生成的设置页之外的客户端 UI；归档集含义或侧边栏渲染已归档会话的任何改动；删除会话数据；手动「立即归档」命令；没有 Workspace 注册表的 headless profile。

从未收到用户消息的空会话与其它闲置会话一样被归档：扫描没有对话内容判据，而没人再打开的空会话正是这套扫描要清理的同类堆积。

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
