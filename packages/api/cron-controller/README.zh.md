---
description: "Host 与 Client 的定时任务控制：修改已存任务并跟踪其完整投影。"
kind: "package-reference"
---
# Cron Controller

[English](README.md) | 中文

## Summary

`@deepseek-ai/dsh-api-cron-controller` 拥有 Host 的 `ctx.cronController` 服务与生成的 Client `ctx.remote.cron` 命名空间。它的 Remote 方法创建、编辑、删除已存任务并按需运行其中一个，`follow()` 流先给出完整基线，再按顺序给出增量。当 Client 需要修改或跟踪定时任务时，通过 API Gateway 使用它。

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Host 控制器在调用时读取 [`ctx.cron`](../../cron/cron/README.zh.md)，并把每个已声明的拒绝映射为稳定的 Remote 码，因此界面只需根据 `cron/invalid-expression`、`cron/invalid-time-zone`、`cron/not-found`、`cron/not-leader` 或 `cron/run-in-progress` 分支，而不必匹配消息文本。不持有调度器租约的进程对每个动词都回答 `cron/not-leader`，它的 follow 世代也以同一个拒绝开头，而不是一个空列表：面板上的空列表会被读作"该部署没有任务"，而这是跟随者无法支持的唯一结论。

`follow()` 每次订阅开启一个世代：先是完整基线，随后是 `cron` 域任务表每次提交写入对应的一帧。重连会开启另一个世代并替换基线，因此没有消费者依赖断连期间收到的每个增量。不是本控制器发出的写入同样会到达已开启的世代，因为 feed 跟踪的是域自身的提交事件，而不是产生这些事件的请求。

Client 入口提供 `ClientCronModel`、`CronJobs` 与 `createCronStateStream()`。模型拥有任务行、世代生命周期、一元变更回显，以及流与一元之间的竞态消解：最新的 `updatedAt` 胜出，被删除的标识绝不会被延迟数据复活。服务只暴露裸可观察状态与命令，把行、文案与格式化留给 UI 所有者。

运行历史通过存储记录自身的写入到达行，因此 `runNow` 不安装本地回显：面板若显示任务从未提交的运行，就等于报告了没有发生的工作。

| 方法 | 用途 |
| --- | --- |
| `create(request)` | 存储一个任务，并以其解码后的投影作答 |
| `update(request)` | 替换某个已存任务所声明的字段 |
| `delete({ jobId })` | 删除一个任务，并以它曾显示的行作答 |
| `runNow({ jobId })` | 不改动计划，立即运行一次 |
| `follow()` | 先流出完整基线，再按顺序流出已存任务增量 |

-----

<a id="model-experience"></a>
## Model Experience

无。本包是定时任务的浏览器与 Host 控制面，不注册任何提示、工具或会话事件。模型通过 [`dsh-tool-cron`](../../cron/tool-cron/README.zh.md) 触达同一能力；任务自身的运行才会到达模型请求，而那属于执行该运行的会话。

#### KV Cache effect

无直接影响；调度控制不改动模型请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换整个投影，没有持久游标或增量补齐协议。
- Client 模型在其自身生命周期内保留进程内的删除标记，因此延迟帧只能在该模型存活期间无法复活已删除任务。
- 以 `cron/not-leader` 开头的世代会保持打开且不再有后续帧；面板只能从之后的世代得知领导权已变化。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>供维护者的工作上下文 — 点击展开</summary>

无。

</details>

**Runtime invariant:** 不发布伴随项。`cron` 存储域拥有持久化，每个流世代都是完整投影。
