---
description: "面向需要在组合中把子 Agent 委派纳入后台任务控制的用户与维护者的作业注册表桥接。"
kind: "package-reference"
---

# @prism/prism-subagent-jobs

[English](README.md) | 中文

## Summary

`@prism/prism-subagent-jobs` 把子 Agent 委派镜像进后台任务注册表：每个面向父会话投递的激活周期都会注册一个 `subagent` 类型的 job，归属委派发起会话，于是 `job_list`、`job_kill` 和作业名册可以像管理 shell、workflow 后台工作一样管理委派。job 不携带子 Agent 的回答 —— 子 Agent 结算通知已经把它报告给父会话 —— 而且 `dsh-tool-jobs` 对这一类型不发送完成通知。停止 job 的效果与 `interrupt_agent` 完全一致。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在需要通过 job 工具控制委派的组合中挂载本桥接。它要求所属组合中存在 subagent 服务、job 注册表以及 job controller（`dsh-tool-jobs`）；缺少 controller 时，每次委派的注册都会失败并留下一条被接住的警告，委派本身不受影响。

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-jobs'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@prism/prism-subagent-jobs'
```

本包不接受任何配置。

### What one job covers

一个 job 恰好对应一个激活周期 —— 从 `subagent/start` 到配对 `subagent/end` 的驻留期。可续聊的子 Agent 之后接受追加消息会开启新周期，因此产生新 job。已结算的记录像已结算的 `bash` job 一样保留在列表中。caller 投递的激活 —— workflow 引擎的内部管道，其结果从不到达父会话 —— 不产生 job。

### Job outcomes

| 停止原因 | Job 状态 |
|---|---|
| `completed` | `completed` |
| `aborted` | `killed` |
| `max-tokens`、`error`、`refusal`、后端新增变体 | `failed` |

停止原因作为终态 detail 传递。`job_kill` 提供的终止原因由注册表合并进去，job 在中断落地后结算为 `killed`。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

对 subagent 生命周期总线事件（`subagent/start`、`subagent/end`）与 `ctx.jobs.start` 的薄适配。这里不做任何生命周期路由：驻留、结算、中断授权属于 subagent 服务；身份、终态和输出环属于注册表。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 生命周期监听、类型声明合并、结果映射、kill 委托 |

### Kill path

`job_kill` 到达 `JobHandle.cancel`，后者调用 `ctx.subagents.interrupt(childId, { kind: 'user', parentSessionId })`。job 归属围栏已经证明调用者是委派发起会话，中断授权再校验同一条父链路，两道围栏一致。本地子 Agent 保留停靠的收件箱，与 `interrupt_agent` 一致；外部执行则永久停止。

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 通过 job 控制委派

#### What the model sees

`job_list` 新增 `subagent` 类型行（`<id> [subagent] <status> — <provider> subagent <childId>`）。对它调用 `job_output` 不会有输出环内容，只有状态行。委派结算不产生 `tool-jobs` 通知；父会话的结算通知是唯一的完成报告。

#### Token effect

每个存活周期一行 `job_list` 记录；结算成本除既有的结算通知外没有新增。

#### KV Cache effect

Append-only；新可见内容跟随可复用的请求前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了桥接何时不适用；它们是当前的包约束。

- **输出环没有子 Agent 进度** —— 输出环保持为空；运行中子 Agent 的动态只能通过它自己的会话和宿主 UI 看到。在出现真实消费者之前，不把子 Agent 转录活动流进输出环。
- **label 标识 provider 与子 id，而不是任务** —— 生命周期 payload 不携带委派任务文本；label 用于标识周期，子 Agent 的上下文仍由 `list_agents` 提供。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
