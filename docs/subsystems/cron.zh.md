# 日历定时任务

[English](cron.md) | 中文

Cron 拥有定时触发的时机、授权与持久化：一个任务声明五字段 cron 规则与 IANA 时区，一次触发把一条作者编写的消息投递进一个在触发到达时可能处于冷态的 Session。[`@deepseek-ai/dsh-cron`](../../packages/cron/cron/README.zh.md) 以 `ctx.cron` Service Definition 及其随产品发布的 provider 承载该能力；[cron 定时任务 Agent Note](../../.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.zh.md) 负责该决策及其被否决的备选方案。本页记录持久化与面向模型的词汇；[包 README](../../packages/cron/cron/README.zh.md) 负责组装，[工具包 README](../../packages/cron/tool-cron/README.zh.md) 负责确切的工具 schema。

角色划分：

| 包 | 拥有 | 服务 |
|---|---|---|
| [`dsh-cron`](../../packages/cron/cron/README.zh.md) | 表达式语法与日期匹配、occurrence 解析、持久化的 `cron` domain、leader lease、分段计时器与投递 | `ctx.cron` |
| [`dsh-tool-cron`](../../packages/cron/tool-cron/README.zh.md) | 五个面向模型的管理工具及其无人值守授权检查 | — |
| [`dsh-api-cron-controller`](../../packages/api/cron-controller/README.zh.md) | Host Remote 控制器与生成的 Client `ctx.remote.cron` 命名空间 | `ctx.cronController` |
| [`dsh-client-ui-cron`](../../packages/client/ui-cron/README.zh.md) | 可选的 Web Session 头部面板 | — |

## 表达式

一条规则由空格分隔的五个字段组成——分钟、小时、日、月、星期——支持 `*`、`a-b` 范围、带步长的范围（`*/n`、`a-b/n`）、逗号列表、三字母月份与星期名称，以及 `@hourly`、`@daily`、`@midnight`、`@weekly`、`@monthly`、`@yearly` 宏。规则没有秒字段，因此一分钟是一条规则能表达的最细粒度，也不存在 Quartz 的 `?`、`L`、`W`、`#` 记号。带步长的单值会走到该字段末尾，即 Vixie 读法：`5/15` 表示 `5,20,35,50`。

当两个日期字段都被限定时，某一天在二者匹配的**并集**上触发，这是 POSIX crontab 规则：`0 0 1 * 1` 在每月一号以及每个周一运行。限定其中一个字段会让另一个保持不限，两个都不限定则每天触发。

`parseCronExpression` 把一条规则读成升序、去重的取值列表，且从不查询时钟、时区或当前日期，因此同一段文本总是得到同一个值。`matchesCronDay` 判断某一天是否满足日期字段，并应用并集规则。拒绝解析会抛出携带出错 `field` 与稳定 `invalid_expression` 码的 `CronExpressionError`。

## Occurrence 解析

`nextCronOccurrence(expression, timeZone, afterEpoch)` 是纯函数，不读取环境时钟：生产代码采样墙上时钟并把采样值传入，测试则给出显式采样。它返回在所声明的 IANA 时区中严格晚于参考时刻的第一个触发时刻。搜索以 `MAX_SEARCH_DAYS` 天为界——宽于被跳过的世纪闰年所造成的八年间隔——超出后返回 `undefined`，而不是无限搜索。

时区投影来自 [`dsh-util-time`](../../packages/util/time/README.zh.md)：它报告某个本地读数的候选时刻，以及该时区是跳过还是重复了它。对该报告采取的策略与 [Schedule](schedule.zh.md) 共享，使 harness 只有一套夏令时语义而非两套：被时区跳过的本地读数直接略过，被时区重复的读数给出两个时刻，其中晚于参考时刻的最早一个胜出。

每个任务声明自己的时区，该能力从不读取浏览器时区、进程时区、Session 头部或模型时间上下文。因此回放永不依赖环境的时区状态。

## 持久化记录

`CronJobId` 是由拥有它的存储铸造且永不复用的品牌化身份：domain 的 `nextJobNumber` 分配器只前进，因此已删除任务的身份不会回来。一个任务是一条带版本的记录：

| 字段 | 含义 |
|---|---|
| `version` | 持久化记录版本；解码器只接受 `CRON_RECORD_VERSION` 声明的那个值 |
| `id` | 品牌化的 `CronJobId` |
| `expression`、`timeZone` | 按原文保留的规则，以及读取它所用的 IANA 时区 |
| `enabled` | 调度器是否可以触发它 |
| `target` | `new-session` 及其工作区与 agent、permission preset，或 `session` 及其延续的 Session |
| `prompt` | 一次触发所投递的消息 |
| `overlapPolicy`、`misfirePolicy` | `skip` 或 `queue-one`，以及 `skip` 或 `run-once-late` |
| `maxRunMs` | 单次运行的正数上限，单位为毫秒 |
| `createdAt`、`updatedAt`、`nextDueAt` | 创建时刻、最后修改时刻，以及最早尚未派发的 occurrence |
| `recentRuns` | 最近完成的运行，由旧到新，受 `maxRunsPerJob` 限制 |

一次完成的运行是一条 `CronRunRecord`：它的 `startedAt` 与 `finishedAt` 时刻，以及结果之一——`completed`、`failed`、`timeout`、`blocked` 或 `interrupted`。`completed` 记录的是带框架的消息已被其 Session 接纳，而不是由此产生的轮次如何结束。

`decodeStoredCronJob` 严格解码一个已存储的值，并以携带稳定 `corrupt_cron_record` 码的 `CronRecordError` 拒绝未知版本、多余字段、不可用的表达式、不可用的时区或不可用的运行历史。

存储是 `version: 1` 的 `cron` storage domain——一张以任务 id 为键的 `jobs` 表加上 id 分配器——并且刻意不是 Session 日志：任务比它可能触及的每个对话都活得久，把它记录进 Session 会重新制造该能力本就为消除而存在的局限。domain 约定见 [storage](storage.zh.md)。

## 存储与 leader lease

`cron` domain 只由持有 leader lease 的进程打开，该 lease 在插件加载时基于部署在 `leaderLockPath` 中声明的锁文件获取。该字段是必填项且刻意不设默认值：默认值可能指向部署所配置存储根之外的位置，于是两个部署就会各自认为自己领导，却共享同一个 domain。

不持有 lease 的进程不打开任何东西，并对每个管理动词都回答 `cron_not_leader`；因为 storage domain 打开后以内存为准且不提供重载，一个打开过它的 follower 会永远提供它在打开时读到的任务。follower 每隔 `leaderRetryMs` 重试获取。该锁是内核锁，因此崩溃的 leader 随其进程结束而释放它，继任者获取它并全新打开 domain，这正是交接无需重载 API 也可读的原因。同一份领导权也安装运行时：计时器只在存在存储时存在，因此只有 leader 触发任务。

管理写入在 domain 的后端写入完成时即持久化，因为 domain 先持久化再改动内存。这里没有需要等待的 Session flush 屏障。

## 运行生命周期

到期任务会重新读取自己的记录、根据已存储规则重新推导下一个 occurrence、应用 `misfirePolicy`、按 `overlapPolicy` 认领运行槽位、解析目标、投递、记录运行、推进 occurrence，最后释放槽位。`queue-one` 在飞行中的那一次之后最多接纳一次等待中的运行，并丢弃后续到达者；默认的 `skip` 则一次都不接纳。`misfirePolicy` 只裁决完全没有调度器运行期间错过的 occurrence：在错过若干 occurrence 后才到达的一次唤醒只产生一次运行，并把已存储的 occurrence 推进到墙上时钟之后，而不是重放每一个错过的时刻。

一个运行时用单个分段计时器服务所有已存储任务，并在每次唤醒后重新采样墙上时钟，因此时钟跳变或机器挂起都不会让它提前触发。每次运行都受 `maxRunMs` 限制；超时会取消 Agent 并记录 `timeout`。在无人值守时到达交互式审批的运行会在同一上限处以 `blocked` 结束，而不是继续或挂起。释放会先停止调度、再中止飞行中的投递、然后关闭存储，顺序如上；已经开始的运行通过自己的记录结算，因此卸载永不会等待任务剩余的运行上限。当该任务的某次运行仍在飞行中时，`runNow` 以 `cron_run_in_progress` 拒绝。

## 投递

目标解析收敛到一个可交付物：能接受后续消息的 Agent。`new-session` 任务用生成的 Session id、声明的工作区作为 Session 目录、以及声明的 preset 调用 `ctx.agents.create`，使运行在任务自身声明的授权下发生；组装它需要 agent preset 与 permission preset 服务。`session` 任务的 Session 若已有活跃 Agent，则直接投递后续消息，只有冷态 Session 才会被 resume，因为 resume 本进程已拥有的 Session 会被拒绝；该路径需要 session persistence 后端。组装中缺少目标所需服务的运行会被记录为 `failed`，而不是在缺少该服务的情况下投递。一次运行创建的 Agent 由插件 fiber 拥有并随其释放，拆除时绝不把某次运行报告为完成。

被投递的消息携带 Cron 声明的消息来源与稳定的 `[CRON TASK]` 框架文本，其动态字段经过 JSON 转义，并声明作者编写的 prompt 是不可信内容而非新的用户指令。

## 管理表面

`ctx.cron` 是每个消费者读取的 Service Definition：`list`、`get`、`create`、`update`、`remove`、`runNow`。随产品发布的 provider 从本进程领导的存储作答，因此无法服务的操作通过 `CronServiceError` 报告 `cron_not_leader`，而不是给出过期答案。封闭的 `CronErrorCode` 并集为 `cron_invalid_expression`、`cron_invalid_time_zone`、`cron_not_found`、`cron_not_leader`、`cron_run_in_progress`。

创建任务或重设其目标是授权未来无人值守开销的行为，因此面向模型的工具对 `cron_create` 与 `cron_update` 要求实时根 Agent 轮次中的直接人类消息，与面向模型的目标工具一致；`cron_list`、`cron_delete`、`cron_run` 收回授权而非花费授权，因此它们需要实时根轮次但不需要人类消息。生成的[工具目录](../tool-catalog.zh.md#deepseek-aidsh-tool-cron)负责参数与结果 schema。

Host Remote 控制器在调用时读取 `ctx.cron`，并把每次拒绝映射为稳定的 Remote 码——`cron/invalid-expression`、`cron/invalid-time-zone`、`cron/not-found`、`cron/not-leader` 或 `cron/run-in-progress`——其 `follow()` 流以一份完整任务基线开启每一代，随后是 domain 任务表每次提交写入对应的一帧。重连会开启带替换基线的新一代，而不持有 lease 的进程会以 `cron/not-leader` 开启其代，而不是给出空列表。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcron--cronservice-abstract-seam"></a>

### `ctx.cron` — `CronService` (abstract seam)

Calendar scheduling, as every consumer sees it.

Implementations answer from durable state, so a caller never has to know whether this process is the scheduler: an operation that cannot be served here reports `cron_not_leader` through the provider's own failure surface rather than returning a stale answer.

```ts cordis-catalog
/**
 * Every stored job, in the store's own order.
 * @returns the jobs the provider holds.
 */
abstract list(): readonly CronJob[]

/**
 * Read one job.
 * @param id - the job's identity.
 * @returns the job, or `undefined` when none is stored under that id.
 */
abstract get(id: CronJobId): CronJob | undefined

/**
 * Create a job.
 * @param request - the caller's stated rule, target, and message.
 * @returns the stored job, including its minted identity and next occurrence.
 */
abstract create(request: CronJobRequest): Promise<CronJob>

/**
 * Change a stored job.
 * @param id - the job's identity.
 * @param update - the fields to replace.
 * @returns the stored job after the change.
 */
abstract update(id: CronJobId, update: CronJobUpdate): Promise<CronJob>

/**
 * Remove a job.
 * @param id - the job's identity.
 * @returns whether a job was stored under that id.
 */
abstract remove(id: CronJobId): Promise<boolean>

/**
 * Run a job once, now, without changing its schedule.
 * @param id - the job's identity.
 * @returns the finished run's record.
 */
abstract runNow(id: CronJobId): Promise<CronRunRecord>
```

Source: [`packages/cron/cron/src/service.ts`](../../packages/cron/cron/src/service.ts)

<a id="ctxcroncontroller--croncontroller"></a>

### `ctx.cronController` — `CronController`

Host service backing the generated `ctx.remote.cron` namespace.

```ts cordis-catalog
/**
 * Store one new task.
 * @param request - the stated rule, destination, and message.
 * @returns the stored task, including its minted identity and next occurrence.
 */
@Remote('create') create(request: CronViewCreateRequest): Promise<CronViewValue>

/**
 * Replace the stated fields of one stored task.
 * @param request - the target identity and the fields to replace.
 * @returns the stored task after the change.
 */
@Remote('update') update(request: CronViewUpdateRequest): Promise<CronViewValue>

/**
 * Remove one stored task.
 * @param request - the target identity.
 * @returns the removed task's projection.
 */
@Remote('delete') delete(request: CronViewJobRequest): Promise<CronViewValue>

/**
 * Run one stored task once, now, without changing its schedule.
 * @param request - the target identity.
 * @returns the finished run's bounded record.
 */
@Remote('runNow') runNow(request: CronViewJobRequest): Promise<CronViewRunNowValue>

/**
 * Stream a complete task baseline followed by ordered stored-task increments.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the baseline, then one frame per committed task write.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<CronFollowFrame>
```

Source: [`packages/api/cron-controller/src/index.ts`](../../packages/api/cron-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
