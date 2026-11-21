# Agent Note: 基于进程级调度器的 cron 定时任务

Status: proposed

[English](2026-09-26-cron-scheduled-tasks.md) | 中文

## 问题

harness 只能在已经活着的会话中开始工作。[`@deepseek-ai/dsh-schedule`](../../../../packages/schedule/schedule/README.zh.md) 拥有会话本地的提醒，其规则并集是 `after`、`at` 和最短 300 秒的固定间隔 `every`；它的协议没有日历或 cron 表达式，而冷会话不执行任何工作、也不发送任何外部通知，直到它重新变活（Web 持久化 schedule）。harness 层 loop 决策 有意把基于时间的执行留作未建，并记录它「属于调度器，而不属于任一 goal 家族」。

因此，已交付的东西无法回答「每个工作日 09:00 运行这个任务」：无人值守、基于日历、带显式时区、且不需要人先打开一个会话。今天想这么做的人只能保持一个会话打开并使用间隔提醒，这改变了规则形状、要求对话一直活着，且不留下这次运行是否发生的记录。

零件齐备，但没有接起来。非会话持久状态由 `ctx.storageDomain` 拥有；跨进程互斥由 `session-persistence-jsonl` 内部的内核锁租约实现；冷会话激活是 `ctx.agents.create` / `ctx.agents.resume`；面向模型的表面是 `ctx.tools` 与 `packages/api/*-controller` 的 Remote 形态。把它们接起来做基于时间的触发是一项调度器决策，而不是提醒协议的扩展，因为提醒的持久记录是它所属会话的对话状态，而 cron 任务的持久记录根本不属于任何会话。

## 提案

新增一个 `packages/cron/` 产品角色包组，外加两个共享原语。cron 拥有**定时触发的时间、权限与持久性**。它不拥有任何迭代策略：触发后的任务只投递一条既定消息来开始普通工作，其后的 goal、Ralph、subagent 与 workflow 策略不受影响。

### 插件拓扑与职责动词

| 包 | 角色 | 拥有的结构与动词 |
|---|---|---|
| `@deepseek-ai/dsh-cron` | Host 能力，`packages/cron/cron/` | `ctx.cron` 的服务定义、纯表达式与日历域、`cron` storage domain、leader 租约、分段计时器 runtime，以及冷会话激活。拥有 `CronJobId`、`CronJob`、`CronRunRecord`、闭集 `CronError` 联合，以及 `list`、`create`、`update`、`delete`、`runNow`、`follow`。 |
| `@deepseek-ai/dsh-tool-cron` | 面向模型的消费者，`packages/cron/tool-cron/` | 注册 `cron_create`、`cron_list`、`cron_update`、`cron_delete`、`cron_run`。 |
| `@deepseek-ai/dsh-api-cron-controller` | Remote 控制器，`packages/api/cron-controller/` | 拥有 Host 侧 `ctx.cronController` 与生成的 Client 侧 `ctx.remote.cron` 命名空间：一个基线加增量的订阅，以及变更与 `runNow` 一元调用，形态遵循 [`workspace-controller`](../../../../packages/api/workspace-controller/README.zh.md)。 |
| `@deepseek-ai/dsh-client-ui-cron` | Web 消费者，`packages/client/ui-cron/` | 定时任务面板：每行显示表达式、时区、下次触发与启用状态；创建、编辑、删除、立即运行，以及最近结果。 |
| `@deepseek-ai/dsh-util-path-lock` | 共享原语，`packages/util/path-lock/` | 跨进程独占路径锁：POSIX 侧经原生 flock 入口取内核锁，Win32 侧持具名内核信号量，持有进程结束时由内核释放。 |
| `@deepseek-ai/dsh-util-time` | 共享原语，`packages/util/time/` | 新增导出日历时间解析：把某个 IANA 时区中的本地日历时间映射为瞬时，并采用本仓库的缺口与重叠策略。 |

`ctx.cron` 与它随附的 provider 保持为一个包，现在不拆出 `cron-local` provider。provider 接缝由第二个 provider 来证明其必要性，而目前没有第二个；[`packages/util/README.md`](../../../../packages/util/README.zh.md) 也要求每个抽象都有当前消费者。当出现第二个存储后端并需要独立成包时，再接缝拆分。

有两个已发布的包会改动，因为各自的行为都出现了第二个消费者，而 `packages/util/` 的存在意义正是让能力包共享机械原语、而不是重复实现：

- `session-persistence-jsonl` 目前拥有唯一的内核锁实现。其锁与 Win32 辅助代码迁入 `dsh-util-path-lock`，会话写租约改为消费该包。
- `dsh-schedule` 目前拥有唯一的本地日历解析。`resolveLocalInstant` 与 `localProjection` 作为导出迁入 `dsh-util-time`，schedule 的域改为消费它们。

组合以一份示例 overlay 交付，即 `apps/cli/config/examples/cron/cordis.yml`，形态对齐 [schedule overlay](../../../../apps/cli/config/examples/cron/cordis.yml)：为三个 Host 包 `insert` 行，并将 Web 组合包中以 `disabled` 交付的 `ui-cron` 行改为 `disabled: false`。

### cron 表达式与日历语义

任务携带五段表达式（`分`、`时`、`日`、`月`、`周`），支持 `*`、`a-b`、`*/n`、`a-b/n`、逗号列表与三字母名称，以及 `@hourly`、`@daily`、`@midnight`、`@weekly`、`@monthly`、`@yearly` 宏。没有秒字段，没有 Quartz 的 `?`、`L`、`W`、`#`，因此最小粒度是一分钟。

当「日」与「周」都被限定时，两者的匹配取并集，这是 POSIX crontab 规则；取交集的实现会静默丢掉运维者预期的运行。

每个任务声明一个 IANA 时区，插件绝不读取浏览器时区、进程时区、会话头或模型 time-context。这让[显式的 schedule 时区边界](../../implemented/simplification/2026-08-09-explicit-schedule-time-zone.zh.md)在两个时间特性上保持一致，也让重放不依赖环境状态。不存在的本地时刻（春季缺口）被跳过，重复的本地时刻（秋季重叠）在较早的那个瞬时运行一次，与 `dsh-schedule` 已为其 `at` 规则交付的策略一致，从而使 harness 只有一套夏令时语义而不是两套。

`nextOccurrence(parsed, timeZone, afterEpoch)` 是纯函数，不读取环境时钟。生产采样墙钟；测试提供显式样本。

### 持久化存储与单实例所有权

一个 `cron` storage domain 保存任务及其有界的运行历史：

```
CronJob = { id, expression, timeZone, enabled,
            target: { kind: 'new-session', workspacePath, agentPreset, permissionPreset, model? }
                  | { kind: 'session', sessionId },
            prompt, overlapPolicy: 'skip' | 'queue-one', misfirePolicy: 'skip' | 'run-once-late',
            maxRunMs, createdAt, updatedAt, nextDueAt, recentRuns }
```

存储**不是**会话日志。cron 任务比它可能触及的任何对话都活得久，因此把它记录在会话里会重建这个特性本就要消除的限制。

`cron` domain 只由**持有 leader 租约的那个进程**打开，租约在插件加载时对部署在 `leaderLockPath` 中写明的锁文件取得。该路径是**必填配置**而非带默认值的路径：默认值可能落在与已配置存储根不同的地方，于是两个部署各自以为自己是 leader，却共用同一个 domain。`ctx.storageDomain` 在打开之后以内存为权威、只以进程内方式发出 `domain/changed`，且不提供 reload，因此第二个打开同一 domain 的进程会永远读到陈旧任务。没有拿到租约的进程因此什么都不打开：它的工具与 Remote 回答稳定的 `cron_not_leader` 错误，面板报告调度器由另一个进程持有，而不是展示过期行。非 leader 按可配置的 `leaderRetryMs` 重试获取；进程死亡时的内核释放让继任者拿锁并全新打开 domain，这正是让交接在不依赖 reload API 的情况下可读的原因。

一次成功的管理写入在 domain 的后端写入完成时即为持久，因为 domain 先落后端、后改内存。cron 没有会话 flush 屏障，在这里照抄 schedule 的屏障纪律，等于加一次不可能成功的等待。

### 触发、投递与无人值守权限

到期任务重新读取自己的记录并从规则重新推导 `nextDueAt`，而不是信任缓存目标；随后应用 `misfirePolicy`，按 `overlapPolicy` 占用运行槽（默认 `skip`：同一任务同时只跑一次），解析目标，投递，记录这次运行，推进下次触发，最后释放槽。

目标解析收敛到一个可交付物：一个能接受 follow-up 的 agent。`new-session` 任务以生成的 id、声明的 workspace 作为 `meta.cwd`、以及声明的各项预设调用 `ctx.agents.create`，形态对齐 [`createWebhookSession`](../../../../packages/experimental/webhook/src/session.ts)。`session` 任务若其会话已有活着的 agent，就直接用 `followup` 投递；只有冷会话才用 `ctx.agents.resume`，因为 resume 一个本进程已拥有的会话会被拒绝。两条路径都不在启动时扫描会话：绑定任务直接写明了它的会话 id，因此记录在全局调度器名下的「启动扫描」成本在这里并不适用。

触发后的任务不会唤醒任何被 harness 当作人类输入的东西。投递携带一个由 cron 声明的消息来源，这是 `MessageSourceMap` 要求的，因为它没有通用的 `plugin` 种类；框架格式沿用 schedule 的约定，即对动态字段做 JSON 转义，并显式说明既定提示词是不可信内容、而不是新的用户指令。

无人值守执行是能在无人看管下花掉真实资源的部分，因此权限是显式的：

- 创建任务即是授权未来的无人值守花费。Web 面板与 Remote 是直接的人类权限。模型工具要求当前活 root-agent 轮次中有一条直接的人类消息，形态对齐模型 goal 工具权限规则，因此模型无法在自己的自主轮次里排入无人值守工作。
- 任务声明一个 `permissionPreset`，部署默认值是保守的那一个。在随附的 `ask` 审批策略下，一次需要人类决定的无人值守工具调用本来会挂住，因此在 `maxRunMs` 到期时以 `blocked` 结束；既不会静默自动批准，也不会静默跳过。
- 每次运行都受 `maxRunMs` 约束；到期会取消 agent 并记录 `timeout`。
- 没有「无人值守全权限」便利开关。要取得全权限，必须写出一个在配置中可见的全权限预设。
- 为一次运行创建的 agent 由插件 fiber 拥有并随其释放；teardown 绝不把一次运行报告为完成。

### 人类与模型的管理面

模型获得五个 CRUD 形态的工具，配有闭集错误联合：`cron_invalid_expression`、`cron_invalid_time_zone`、`cron_not_found`、`cron_not_leader`、`cron_run_in_progress`、`cron_persistence_uncertain`。工具 schema 与结果都从模型视角书写，绝不提及面板、传输或存储。

Web 面板是一个基于 `ctx.remote.cron` 的独立可选插件。禁用它，工具与 runtime 依然完好，这让可选表面不承担能力的任何一部分。

运行历史有界且持久，因为一个不留下任何痕迹的调度器，在第二天早上是不可用的。每个任务保留其最近 `maxRunsPerJob` 条记录，包含结果、开始与结束。

### 与既有 owner 的边界

| 既有 owner | 边界 |
|---|---|
| `dsh-schedule` | 不变。cron 绝不读写 `schedule/change`，不接管它的记录，也不重定义它的规则并集。schedule 仍是在对话内的提醒；cron 是日历调度器。两者唯一共享的动作——向会话投递一条消息——在创建入口、持久 owner 与触发条件上都不同。 |
| goal 与 Ralph | cron 只拥有工作*何时*开始。触发的任务播种一条消息；goal 轮次、Ralph 轮次及其预算与激活规则继续约束其后的全部行为，包括「恢复会话是观察、而不是花费权限」这条规则。 |
| `ctx.jobs` | cron 不把 job 注册表当作存储或运行身份。job 是进程内、内存中的，而一次 cron 运行必须被持久记录并跨越重启。 |
| Webhook ingress | `WebhookRuntime.dispatch` 与 HTTP 无关，cron 复用的是它的*形态*，但 `WebhookSessionRequest` 只能新建会话；因此带 `session` 目标的任务自行执行 resume，而 webhook 路径无法表达这一点。 |

### 实施计划

`TDD Route`：mode 为 `auto`，decision 为 `strict`。依据是本仓库强制的测试契约（[testing.md](../../../../docs/testing.zh.md)），以及 auto 规则在契约、持久化、权限与生产者/消费者上的信号；不存在用户显式的 TDD 要求。姿态：行为类任务从 `packages/*/*/tests/` 下一个失败的聚焦测试开始。组合类与呈现类任务只在机制上是例外——它们可获得的最严信号是仓库强制的真实 Loader 组合、录制会话快照与 Web 端到端证据，而不是单元 RED 步骤。

`Requirement Ready Check`：来源是本 note 的提案与验收标准；范围、场景与验收证据齐备，没有仍待决定的事项。

`Change Necessity`：没有任何既有 owner 实现日历调度，且仅靠文档或配置无法交付，因为该行为需要持久存储、跨进程租约与 runtime。最小代码边界即上述六个包与一份 overlay。

`Ripple Signal Triage`：命中的信号有公共 API（`ctx.cron`、`ctx.remote.cron`）、持久化（一个带版本的 storage domain）、权限（无人值守执行权限）、共享原语（两个 `util` 包）、生产者/消费者配对，以及退役（两处私有实现被替换）。规范 owner：`dsh-cron` 拥有 cron 状态与定时，`dsh-util-path-lock` 拥有跨进程路径锁，`dsh-util-time` 拥有 IANA 时区投影。必须重新验证其行为的消费方是 `dsh-schedule`、`session-persistence-jsonl`、Web 组合花名册与各生成目录。

**文件地图**

| 区域 | 文件 |
|---|---|
| 共享锁 | `packages/util/path-lock/` — `package.json`、`tsconfig.json`、`src/index.ts`、`tests/`、`README.md`、`README.zh.md`、`README.i18n.yaml` |
| 会话租约消费方 | `packages/session/session-persistence-jsonl/src/lease.ts` 保留 session 自己的策略（锁文件名、目录模式、争用映射），`src/win32.ts` 只保留持久化命名空间发布；两者都消费新包 |
| 共享时间 | `packages/util/time/src/index.ts`、`packages/util/time/tests/`、其 README 三件套 |
| schedule 消费方 | `packages/schedule/schedule/src/domain.ts` |
| cron 宿主 | `packages/cron/cron/src/` — `index.ts`、`types.ts`、`domain.ts`、`store.ts`、`lease.ts`、`runtime.ts`、`delivery.ts`、`authority.ts`，外加 `tests/` 与 README 三件套 |
| cron 工具 | `packages/cron/tool-cron/src/index.ts`、`tests/`、README 三件套 |
| Remote | `packages/api/cron-controller/src/`、`tests/`、README 三件套 |
| Web 面板 | `packages/client/ui-cron/src/client/`、`tests/`、README 三件套 |
| 组合 | `apps/cli/config/examples/cron/cordis.yml`；`packages/bundle/web-app/cordis.patch.yml` 中 `disabled` 的 `ui-cron` 行及其在 `packages/bundle/web-app/package.json` 中的依赖；overlay 解析器清单所在的 `apps/cli/package.json` |
| 注册表 | `tsconfig.host.json`、`tsconfig.client.json`、重新生成的 `tsconfig.base.json` paths、`packages/cron/README` 三件套、`packages/client/README` 成员行、`docs/subsystems/cron.md` 及其网站路由 |
| 生成器 | `scripts/gen-tool-catalog.ts` 的 `sources` 条目，以及下文列出的每一个重新生成的目录或图 |

**任务**

| # | 任务 | 最小改动 | 验证 |
|---|---|---|---|
| T1 | 提取跨进程路径锁 | 新增 `dsh-util-path-lock`，拥有 POSIX 内核锁与 Win32 具名内核信号量，暴露已持有锁的获取与一个争用错误。它自己的聚焦 spec 覆盖互斥、释放后准入、锁文件残留、inode 校验，以及经桩化 kernel32 绑定的 Win32 信号量分支。 | 该包的聚焦测试；`test:coverage` |
| T2 | 让会话写租约消费它 | `session-persistence-jsonl` 把内核加锁迁入新包，只把 `src/lease.ts` 留作其外围的 session 自有策略、`src/win32.ts` 留作纯持久化命名空间发布，并把争用映射到既有的 `SessionAlreadyOwnedError`。存储格式不变，且不做 re-export。其后端级的租约 spec 留在后端；Win32 锁测试迁入新包。 | 聚焦的 session-persistence 测试；`test:snapshot` |
| T3 | 从 `dsh-util-time` 导出时区投影 | 新增机械原语：枚举某 IANA 时区中某个本地日历时间的候选瞬时，并报告该时区是跳过还是重复它。缺口与重叠的*策略*留在各消费方，因此该包仍是一个不注册任何东西的库。投影拿读数的 UTC 形状取值作比对，因此 `localCalendarEpoch` 与它一同导出，而不是在 schedule 域里重复一份；该包已文档化的身份从「只做规范化」扩为「规范化 + 投影」：其描述、README 概述与限制在同一步骤内变更，且仍不抛出任何域码。 | 该包的聚焦测试 |
| T4 | 让 schedule 域消费它 | `dsh-schedule` 删除其私有 `localProjection` 与 `resolveLocalInstant`，改消费该导出，并保留其已交付策略：缺口拒绝，重叠取较早瞬时。它自己的 `CalendarParts` 声明改为共享读数类型的别名，其 `calendarEpoch` 把共享的 `RangeError` 映射回既有的 `invalid_rule` 消息。 | 聚焦的 schedule 测试，其中既有的「解析显式本地时间、拒绝 DST 缺口、重叠取较早瞬时」用例直接走这条路径；该包的 `test:coverage`。录制会话语料中没有任何 schedule 场景，因此没有 `test:snapshot` 过滤器能选中它；schedule 的端到端车道是 `apps/web/tests/schedule-after.e2e.ts`。 |
| T5 | cron 表达式引擎 | 五字段、宏与名称的纯解析、校验与发生时刻解析，包含日与周的并集。导出的解析器名为 `nextCronOccurrence`，其行走以 `MAX_SEARCH_DAYS` 天为上界——宽于被跳过的世纪闰年所造成的八年间隔——超出即回答 `undefined`；它采用共享策略：越过被时区跳过的读数，并在被重复的读数中取较早的瞬时。 | 覆盖并集、`*/n` 边界、名称、缺口、重叠、被跳过的世纪闰年，以及永不触发的规则的聚焦测试 |
| T6 | cron 记录与闭集错误联合 | `CronJob`、`CronRunRecord`，以及拒绝未知版本与多余字段的严格存储记录解码。 | 聚焦测试，含非法输入拒绝 |
| T7 | cron 存储与 leader 租约 | `ctx.cron` 服务定义、`version: 1` 的 `cron` domain、架在该 domain 两个句柄之上的 store、经 `dsh-util-path-lock` 获取领袖权、仅在持有期间打开 domain、否则回答 `cron_not_leader`，并按 `leaderRetryMs` 重试。重试计时器由插件自己的 fiber 提供而不是由领袖权创建，因此释放时能真正取消；领袖权不假设取消器已经生效，所以仍然触发的尝试什么也不打开；store 打不开时会释放领袖权，因为"持着领袖权却没有 store"会让其他任何进程都无法再成为调度器。 | 获取、拒绝与交接的单元测试；断言恰好一次触发的两进程测试 |
| T8 | 计时器 runtime 与运行状态机 | 分段单计时器调度、每次唤醒后重采墙钟、misfire 策略、overlap 策略、`maxRunMs` 取消，以及有界运行记录。 | 使用显式时钟样本的聚焦测试 |
| T9 | 目标解析与投递 | 新会话用 `create`，活着的绑定会话直接 `followup`，仅冷会话用 `resume`，cron 声明的消息来源，以及转义后的框架。 | 聚焦测试，外加一次真实 Loader 组合测试 |
| T10 | 无人值守权限 | 模型路径要求当前活 root-agent 轮次中存在直接人类消息，应用保守的默认 `permissionPreset`，并让进入交互式审批的运行在 `maxRunMs` 时以 `blocked` 结束。 | 经工具执行器的拒绝测试；blocked 运行测试 |
| T11 | 模型工具 | `tool-cron` 在 `ctx.effect` 内注册五个工具，并返回闭集错误码。 | 聚焦工具测试；生成的工具目录包含新 schema |
| T12 | Remote 控制器 | Host 侧 `ctx.cronController` 与生成的 Client 命名空间，含一个基线加增量的订阅，以及变更与立即运行的一元调用。 | 聚焦控制器测试；注销命名空间的释放测试 |
| T13 | Web 面板与组合 | 带类型化语言字典的 `ui-cron` 面板、Web 组合包中的 `disabled` 行，以及示例 overlay。 | `test:web`；`verify-cordis-config`；客户端 UI 文案门禁 |
| T14 | 插件生命周期 | 每个注册都经 `ctx.effect`，释放时移除工具、Remote、domain 句柄、租约与计时器。 | 每个贡献项都需通过仓库强制的 HMR 安全性释放测试 |
| T15 | 录制证据 | 一个针对 cron 触发运行的无密钥录制会话场景，以及一个针对该面板的 Web 期望。 | `test:snapshot`；`test:web` |
| T16 | 文档与生成器 | 包组 README、含 Model Experience 与 Known Limitations 的各包 README 三件套、子系统页，以及每个重新生成的目录与图。 | `doc-sync` |
| T17 | 全量变更门禁 | 对完整变更运行仓库门禁。 | `typecheck`、`lint`、`test:coverage`、`build`、`hygiene`、`duplication`、`doc-sync` 与 `test:snapshot` |

**退役。** `session-persistence-jsonl` 内部的内核锁实现（POSIX 描述符处理与 Win32 信号量绑定）以及 `packages/schedule/schedule/src/domain.ts` 中的私有日历辅助函数，由引入其共享替代物的那个任务删除。各消费方保留的只是它围绕共享原语的自身策略：会话保留锁文件名、目录开辟模式与错误身份；schedule 域保留其「缺口拒绝、重叠取较早」规则。两者都不保留 re-export，也不保留第二份实现。

**源码树要求的包接线。** 名字与目录不一致的新包无法被生成的别名块覆盖，因此 `dsh-util-path-lock` 需要在 `tsconfig.base.json` 中 `dsh-util-time` 旁边手写一条 `paths` 条目；两个消费方还需要对它的 TypeScript project reference，而新包需要对它所导入的原生系统入口的 reference。

**执行约束。** 上述每一条门禁与测试命令都通过 tsx 或 esbuild 运行 TypeScript，而它们会派生一个带管道的子进程。在默认会话沙箱下该派生物被拒为 `EPERM`，因此实施会话需要足够宽的文件沙箱权限来放行这些子进程；否则本计划中没有任何任务能靠执行来验证。

## 考虑过的替代方案

- **扩展现有 `dsh-schedule`，加入一种 cron 规则，而不是新增包组。** 否决：schedule 记录是会话拥有的对话状态，采用会话本地投递并带 flush 屏障；而 cron 任务不属于任何会话，必须在所有对话都冷着时运行，并且需要跨进程所有权。加一种规则会迫使会话日志变成全局任务数据库，并破坏 schedule 已依赖的 fork 与重放语义。
- **复用 `ctx.jobs` 作为存储与运行身份。** 否决：按其自身契约，job 注册表是进程内、内存中的，并且在没有任何 controller 服务其 owner 时拒绝工作。cron 任务需要持久身份、重启安全的下次触发，以及比进程活得更久的可寻址运行记录。
- **把 cron 任务作为新的事件流存进会话日志。** 否决，理由同上；此外它还会把一个模型可见的调度器塞进运维者从未打开过的对话的重放与 fork 路径。
- **用专门常驻的调度 profile 取代租约。** 作为*机制*否决：当用户同时运行 `dsh web` 时，它仍然允许第二个进程触发同一个任务，因此只是推迟了互斥问题而非解决它。租约让任何 profile 都能承载调度器，同时保持只有一个触发者。
- **依赖既有的 cron 库**，例如零依赖且支持时区的 `croner`（[croner](https://croner.56k.guru/index.html)、[时区与夏令时说明](https://www.nodecron.com/timezones-and-dst.md)）。否决：日历解析无论如何都必须与 `dsh-schedule` 共享，以保持 harness 只有一套夏令时语义，于是留给库去删除的只剩字段解析与发生时刻算术；为这点代码引入第二套时区引擎和第二个外部依赖、以及与之并存的第二套夏令时策略，不划算。
- **在 cron 包内复制内核锁与日历解析。** 否决：`packages/util/` 的存在正是为了防止这种重复；而「跨进程独占锁住一个路径」若有两个 owner，就会在最难测试的平台特定路径上漂移。
- **只跑 shell、不涉及模型的任务类型。** 首版范围否决：促成这项工作的运维意图就是无人值守的 agent 工作，而加入第二条执行路径会在第一条路径尚不存在时，把失败、取消与并发语义翻倍。它以后仍可作为独立任务类型，配自己的权限模型。
- **面向模型的通用 `loop` 工具 + 通用 loop 服务。** 已被 harness 层 loop 决策否决，理由是它会制造投机表面并重复会话、workflow、subagent 与 job 机制。cron 正是那次决策在等的具体调度器消费者，它不新增任何迭代抽象。
- **会话恢复时自动续行。** 同一决策已否决，这里予以保留：打开会话是观察，而不是花费权限。cron 的权限来自任务的创建，而不是来自某个会话变活。

## 验收标准

- 用 `0 9 * * 1-5` 加显式时区创建的任务，在工作日当地 09:00 运行，且其记录的下次触发在春季缺口与秋季重叠上都是正确的。
- 两个 harness 进程同时运行且都加载插件时，恰好一个进程触发到期任务；另一个对管理操作回答 `cron_not_leader`，且不展示陈旧行。杀掉 leader 后，存活者接管并能看到 leader 已提交的任务。
- `new-session` 任务以声明的 workspace 与预设创建一个会话并投递其提示词；`session` 任务对活着的会话直接投递而不 resume，对冷会话则 resume。
- 在没有当前 root-agent 轮次的直接人类消息时，通过模型工具创建任务被拒绝；通过面板创建则成功。
- 一次运行中若有工具调用需要人类批准，会在 `maxRunMs` 时以 `blocked` 结束，而不是挂住或继续执行。
- 任务及其有界运行历史在进程重启后仍在，且重启不会重复触发一次已完成的运行。
- 释放插件 fiber 会移除它注册的每一个工具、Remote、面板、domain 句柄与计时器。
- 模型可见的工具 schema、结果与投递框架由无密钥的录制会话快照钉住，且生成的工具目录与配置目录包含这些新表面。

## 风险

- **一个 harness 里有两个调度器。** cron 与 `dsh-schedule` 都会向会话投递消息，用户可能分不清某条消息来自哪个特性。缓解之处在于只有 cron 能在会话冷着时运行；余下的风险是呈现上的混淆，面板的独立入口与 cron 声明的消息来源会削弱它，但不会消除它。
- **卡住的 leader 会阻塞全部触发。** 内核锁有意不设过期，因此活着但停滞的 leader 会一直占着调度器直到其进程退出，而崩溃的持有者会立即释放。这是用可用性换取「两个进程绝不写同一个存储」的保证。
- **无人值守的资源花费。** 一个写错的任务配上宽松预设，会在无人看管下花费 token 并调用工具。边界是 `maxRunMs`、`overlapPolicy` 与保守的默认预设；该特性无法识别一个单纯不明智的任务。
- **一个狭窄的重复窗口。** 在投递之后、运行记录持久化之前崩溃，会在下次启动时重复一次运行。cron 是至少一次语义，不声称 exactly-once 效果。
- **存储格式承诺。** 一旦创建任务，`cron` domain 的 `version: 1` 布局就成为持久状态，而 domain 层在版本不匹配时拒绝而不是迁移，因此任何后续布局变更都需要自己的迁移决策。
- **为共享原语重构了两个已发布包。** `session-persistence-jsonl` 与 `dsh-schedule` 的内部控制发生变化，因此它们既有的锁与日历测试必须随代码迁走。风险是已交付路径上的行为漂移，缓解之处在于两处重构都是机械搬迁，且由本已钉住它们的测试覆盖。
- **夏令时与 crontab 语义由自己拥有，而非借用。** 拒绝库意味着边界情形（`*/n` 范围、月与周名称、日与周取并集、缺口与重叠）都由本仓库负责测试，而错误的并集规则会静默丢掉预期的运行。
