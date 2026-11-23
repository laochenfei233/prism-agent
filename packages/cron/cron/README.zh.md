---
description: "日历调度能力：五段 cron 表达式语法、其日匹配规则、在显式 IANA 时区上的发生时刻解析、跨进程领袖租约背后的持久任务存储、`ctx.cron` 管理服务、触发到期任务的分段计时器，以及把一次触发投递进会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

[English](README.md) | 中文

## 概述

`dsh-cron` 拥有定时任务书写所用的日历词汇。`parseCronExpression` 把一条五段 crontab 表达式或 `@hourly` 家族宏读成升序且无重复的取值列表；`matchesCronDay` 取两个被限定日字段匹配的**并集**，即 Vixie 规则。本包同时就是 Cordis 插件：它取得内核领袖租约，只在持有时打开 `cron` 存储 domain，发布 `ctx.cron` 的 `list`、`get`、`create`、`update`、`remove` 与 `runNow`（在不是领袖的进程里每个都以 `cron_not_leader` 被拒），用一个分段计时器触发到期任务，并把每次触发投递进目标会话。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

解析一次，然后用调度方自己的日历去匹配解析结果：

```ts
import { CronExpressionError, matchesCronDay, parseCronExpression } from '@deepseek-ai/dsh-cron'

declare const dayOfMonth: number
declare const dayOfWeek: number

try {
  const expression = parseCronExpression('0 9 * * 1-5')
  if (matchesCronDay(expression, dayOfMonth, dayOfWeek)) {
    // this day fires
  }
} catch (error: unknown) {
  if (!(error instanceof CronExpressionError)) throw error
  // error.field names the field; error.code is 'invalid_expression'
}
```

解析器绝不查询时钟、时区或当前日期，因此同一段文本永远得到同一个值。把读数解析成瞬时经由[共享时间词汇](../../util/time/README.zh.md)完成——它报告某个时区跳过与重复的那些小时，而不是替调用方在两者之间选择；`nextCronOccurrence` 采用该词汇的调用方共有的选择：被跳过的读数直接越过，被重复的读数给出两个瞬时，取参考瞬时之后较早的那一个。

不发布运行时不变量伴生入口：调度器唯一那条跨进程关系——进程只在持有领袖租约时才持有存储——由 `CronOwnership` 内部强制执行，而不是从外部断言；runtime 的计时器、其策略、以及其有界历史由单元测试钉住。

### 两个日字段

被限定的「日」与被限定的「周」在其匹配的**并集**上触发，因此 `0 0 1 * 1` 既在每月 1 日运行，也在每个周一运行。只限定一个字段时另一个保持不受限；两个都不限定则每天都触发。对两者取交集的调用方会静默丢掉运维者写下的运行。

### 组合该插件

该插件要求 `leaderLockPath`，由部署声明调度器锁所在的位置；它刻意不给默认值，因为默认值可能指向部署存储根之外的地方，那样两个部署会各自以为自己是领袖却共用同一个 domain：

```yaml
- id: cron
  name: '@deepseek-ai/dsh-cron'
  config:
    leaderLockPath: /var/lib/dsh/storages/cron/leader.lock
    leaderRetryMs: 30000
    maxRunsPerJob: 20
    defaultMaxRunMs: 600000
```

管理操作读取的是本进程所领导的那个存储，因此跟随者回答 `cron_not_leader`，而不是给出它启动时读到的那批行：

```ts ignore-check
const job = await ctx.cron.create({
  expression: '0 9 * * 1-5',
  timeZone: 'Asia/Shanghai',
  target: { kind: 'session', sessionId: 'session-1' },
  prompt: 'summarize yesterday',
})
```

跟随进程按 `leaderRetryMs` 重试获取。由于租约是内核锁，崩溃的领袖随其进程结束而释放它，继任者重新打开 domain——这正是它无需 reload 就能看到领袖已提交任务的原因。同一次领袖权也装上计时器：存储到位时 runtime 启动，因此只有领袖会触发任务；存储消失时它停止。

一次触发经由 Agents 服务投递：`CronDelivery` 创建 `new-session` 目标所声明的会话，把消息排入 `session` 目标的存活 Agent，并且只在本地进程没有该会话的 Agent 时才恢复它。组合 `new-session` 目标还需要 agent preset 与 permission preset 服务，恢复冷 `session` 目标还需要会话持久化后端；组合方缺少其目标所需服务时，该次运行被记为 `failed`，而不是在缺少该服务的情况下投递。

## API

| 导出 | 职责 |
|---|---|
| `parseCronExpression(source)` | 一条解析后的表达式，或 `CronExpressionError`。 |
| `matchesCronDay(expression, dayOfMonth, dayOfWeek)` | 该日历日是否触发。 |
| `nextCronOccurrence(expression, timeZone, afterEpoch)` | 参考瞬时之后该规则触发的第一个瞬时；在搜索上界内不触发时回答 `undefined`。 |
| `MAX_SEARCH_DAYS` | 该搜索在回答 `undefined` 之前走过的天数。 |
| `CronExpressionError` | 解析拒绝，携带 `field` 与稳定的 `invalid_expression` 码。 |
| `decodeStoredCronJob(value)` | 严格解码一条已存储任务；其形状、表达式、时区或运行历史不可用时抛 `CronRecordError`。 |
| `cronJobSchema` | 严格的存储 schema，供在打开时校验每个取值的存储方使用。 |
| `CRON_RECORD_VERSION` | 该解码器唯一接受的持久记录版本。 |
| `CronRecordError` | 存储记录拒绝，携带稳定的 `corrupt_cron_record` 码。 |
| `cronDomainSpec` | 调度器打开的持久布局：一张按任务 id 索引的 `jobs` 表，加上永不重用的 id 分配器。 |
| `cronDomainState` | 该 domain 的全局 schema，供推进分配器的存储方使用。 |
| `CronLeadership` | 针对一个锁文件的领袖租约：`take` 回答已持有的领袖权、另一个活进程持有时回答 `undefined`、非争用失败则抛出。 |
| `CronStore` | 读写某个已打开 domain 持有的任务，含永不重用的身份分配器；每次写入在 resolve 时即已持久。 |
| `LEADER_LOCK_FILENAME` | 锁文件在调度器目录内的基础名。 |
| `CronOwnership` | 仅在本进程为领袖时打开存储，并按配置的延迟重试获取。 |
| `CronService` | `ctx.cron` 的 Service Definition：每个消费方都可以请求的那些动词。 |
| `Config` | 插件配置 schema，Loader 用它校验部署给出的配置。 |
| `resolveCronConfig(config)` | 把该配置的每个默认值显式写出来，供直接构造配置的调用方使用。 |
| `CronConfig` | 插件实际使用的、已解析的配置。 |
| `CronServiceError` | 被拒绝的管理调用，携带封闭 `CronErrorCode` 联合中的一个码。 |
| `CronProvider` | 随包发布的 `ctx.cron` 提供方：在本进程所领导的存储上实现全部动词。 |
| `CronProviderOptions` | 提供方需要组合方给出什么：存储来源、runner、时钟，以及单次运行上限默认值。 |
| `CronRunner` | 每个任务同时只跑一次，受该任务上限约束，并把运行历史追加进存储。 |
| `CronRunnerOptions` | 一次运行需要其所有者给出什么：存储来源、运行体、历史条数上界，以及时钟。 |
| `CronRunBody` | 组合方为一次触发提供的投递步骤：一次运行做什么，以及它如何结束。 |
| `CronRuntime` | 用单个分段计时器按错过补偿与重叠策略触发到期任务。 |
| `CronRuntimeOptions` | runtime 需要组合方给出什么：存储来源、runner、时钟，以及失败上报出口。 |
| `MAX_TIMER_DELAY_MS` | Node 计时器在不被截断的前提下能表示的最大延迟。 |
| `CronDelivery` | 一次触发的投递：它排入的框架文本与它到达的目标——新建的会话、存活会话的 Agent，或被恢复的冷会话。 |
| `CronDeliveryOptions` | 一次投递需要组合方给出什么：存活 Agent 查找、会话创建、会话恢复，以及失败上报出口。 |
| `CronDeliveredAgent` | 投递到达但不拥有其所有权的 Agent：它接受的后续消息。 |
| `CronLoadedAgent` | 由一次投递创建或恢复的 Agent；投递失败时回滚它。 |
| `CronNewSessionRequest` | `new-session` 目标为投递所创建的会话声明的内容。 |
| `renderCronTaskFraming(job)` | 投递排入的稳定 `[CRON TASK]` 块，其动态字段经 JSON 转义。 |
| `apply(ctx, config)` | 插件本体；`name` 与 `inject` 向 Loader 声明它。 |

<a id="model-experience"></a>
## 模型体验

间接影响，经由注册模型可见调度工具的工具消费方，以及触发后的任务排入会话时所用的投递框架。管理服务与运行体本身不面向模型。

#### KV Cache 影响

自身没有。添加工具 schema 与会话消息的那些消费方，对相应请求的缓存行为负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **五段，一分钟**——没有秒字段，因此任何规则都不会比每分钟一次更频繁，也没有 Quartz 的 `?`、`L`、`W`、`#`。
- **单值带步长会跑到字段末端**——`5/15` 意为 `5,20,35,50`，即 Vixie 的读法，而不是单值 `5`。
- **投递记录的是消息已接纳，而不是工作本身**——`completed` 表示框架文本已被其会话接纳；随后 Agent 的回合按会话自身的生命周期运行，因此运行记录不报告该回合如何结束。
- **被恢复的目标使用组合方的路由**——冷 `session` 目标会被恢复，其 Agent 由部署组合而成，因此该会话自己记录在日志里的模型路由不会被重新装上；恢复需要组合方声明一个默认路由。
- **一次唤醒是合并而非补播**——在一次唤醒之前已经过去的多个发生时刻只产生一次运行，并把已存发生时刻推过墙上时钟。只有完全没有任何调度器在跑时错过的发生时刻才由 `misfirePolicy` 决定。
- **dispose 不等待在飞的运行**——它取消计时器并等待当次驱动；已经开始的运行通过自己的记录结束，因此卸载从不为某个任务剩余的上限而等待。
- **`runNow` 在有运行在飞时拒绝**——调用方要的是此刻，因此提供方回答 `cron_run_in_progress`，而不是排到正在进行的那次之后。
- **搜索是有界的**——`nextCronOccurrence` 走 `MAX_SEARCH_DAYS` 天，该窗口大于被跳过的世纪闰年所造成的八年间隔；窗口内没有发生时回答 `undefined`，而不是无限搜索。
- **发生时刻按需计算**——没有索引也没有缓存，反复解析同一表达式的调用方每次都付这个代价。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
