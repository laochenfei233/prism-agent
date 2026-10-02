---
description: "cron 分组地图：按显式时区中的五字段规则在无人值守状态下触发的日历定时任务，供浏览该分组的用户与维护者阅读。"
kind: "package-group"
---

# cron/ — 日历定时任务

[English](README.md) | 中文

## 摘要

cron 分组让操作者调度无论对话是否打开都会运行的工作。任务声明五字段 cron 规则、读取该规则的 IANA 时区、每次运行发生的位置，以及一次触发所投递的消息；运行不依附任何打开的 Session，因此创建任务或重设其目标就是授权无人值守开销的行为。该分组拥有日历词汇、受跨进程 leader lease 保护的持久任务存储、触发到期任务的计时器，以及把一次触发投递进 Session 的行为。面向模型与面向浏览器的两个独立包在同一能力之上管理任务；浏览器面板为可选项，且不承载运行时任何部分。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发说明](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`cron/`](cron/README.zh.md) | `ctx.cron` 能力：表达式解析与日期匹配、occurrence 解析、位于 leader lease 之后的 `cron` storage domain、分段计时器，以及向 Session 的投递 | `ctx.cron` |
| [`tool-cron/`](tool-cron/README.zh.md) | 五个面向模型的定时任务工具及其无人值守授权检查 | —（仅工具） |

-----

<a id="related-documentation"></a>
## 相关文档

- [日历定时任务子系统](../../docs/subsystems/cron.zh.md) — 表达式语义、持久记录、领导权、运行生命周期与管理表面。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cron) — 模型获得的 `cron_create`／`cron_list`／`cron_update`／`cron_delete`／`cron_run` schema。
- [cron 定时任务 Agent Note](../../.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.zh.md) — 该决策、其授权模型与被否决的备选方案。
- [仅限会话内的 Schedule](../schedule/README.zh.md) — 它刻意与之区分开的会话内提醒。
- [定时任务面板](../client/ui-cron/README.zh.md) 与 [Remote 控制器](../api/cron-controller/README.zh.md) — 同一能力之上的浏览器与 Host 管理表面。

-----

<a id="dev-note"></a>
## 开发说明

<details>
<summary>维护者工作背景 — 点击展开</summary>

该能力以单包加其 provider 的形式发布，而非拆分 service/provider：provider seam 由第二个 provider 证明其必要性，而目前并不存在。lease 是唯一的跨进程关系，且在 `CronOwnership` 内部强制执行，而不是由 runtime invariant 断言。

</details>
