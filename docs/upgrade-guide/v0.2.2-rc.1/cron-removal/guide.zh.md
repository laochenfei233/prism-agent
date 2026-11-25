---
kind: upgrade-guide
description: "Cron 调度的一整套包、模型工具、Remote 命名空间与面板已移除；请把这些任务重建为 Schedule 任务。"
---

# Cron 调度退役，统一到 Schedule

[English](guide.md) | 中文

## 变更

本仓库曾并存两套调度系统。Schedule 拥有「自动化任务」页背后的 Host 任务存储；Cron 则是一套独立的可选栈：`@deepseek-ai/dsh-cron`、`@deepseek-ai/dsh-tool-cron`、`@deepseek-ai/dsh-api-cron-controller`、`@deepseek-ai/dsh-client-ui-cron` 面板，以及 `apps/cli/config/examples/cron/cordis.yml` overlay。这套栈已被删除。

- 模型工具 `cron_create`、`cron_list`、`cron_update`、`cron_delete`、`cron_run` 不再存在。继续调用它们的提示词、skill 与脚本会遇到未知工具而失败。
- `ctx.cron` 能力、`ctx.cronController` Host 服务、`ctx.remote.cron` Client 命名空间一并消失，随之消失的还有拒绝码 `cron/invalid-expression`、`cron/invalid-time-zone`、`cron/not-found`、`cron/not-leader`、`cron/run-in-progress`。
- Cron overlay 已删除。任何把这些包列为 Loader 条目的 profile 或配置，该行将无法解析。
- 存储中的 `cron` domain 记录原样保留在磁盘上，但不再被读取。没有迁移会转换它们：Cron 每个任务的 agent 预设、权限预设、模型、重叠策略与 misfire 策略在 Schedule 中没有对应字段，转换会静默丢掉这些信息。
- 不再产生 `{ kind: "cron", jobId }` 消息来源。记录了该来源的会话仍可读取，因为消费方会跳过未知的来源 kind。

这次移除丢掉的能力 Schedule 已经覆盖：「自动化任务」页与 `schedule_*` 工具都接受带显式 IANA 时区的五字段 Cron 定时、以 RRULE 表达的重复，以及同样的三种投递目标（既有会话、建一个复用、每次新建）。

## 迁移

1. 在「自动化任务」页把每个 Cron 任务重建为 Schedule 任务，然后在旧的 overlay 部署里停用它。原先用 Cron 表达式的任务，在 Schedule 的「自定义」定时里沿用同一表达式与同一 IANA 时区。
2. 在提示词、skill 与脚本中，把 `cron_*` 调用换成 `schedule_create`、`schedule_list`、`schedule_view`、`schedule_edit`、`schedule_delete`，写法见[Schedule 工具指南](../../v0.2.2-alpha.2/schedule-agent-tools/guide.zh.md)；被委派的 subagent 不能管理任务。
3. 从自定义 `cordis.yml` 组合与 profile overlay 中删除所有被移除的包，并且不再读取 `ctx.cron`；剩余的唯一调度能力是 `schedule` 服务。
4. 如果某个 Client 读取 `cron` Remote 命名空间，改用 schedule 的 Remote 表面。没有任何东西替代每任务的运行历史：Schedule 记录任务自身的视图，一次运行的结果从该任务读取。
5. 打开「自动化任务」页列出重建后的任务，再手动运行其中一次，以确认结果。
