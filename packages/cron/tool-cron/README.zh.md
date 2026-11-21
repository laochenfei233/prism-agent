---
description: "面向模型的定时任务工具，供使用者与维护者组织或调试 cron_create、cron_list、cron_update、cron_delete 与 cron_run。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cron

[English](README.md) | 中文

## 概述

`dsh-tool-cron` 在 `ctx.cron` 之上注册五个定时任务工具。一个任务声明它的 cron 表达式、IANA 时区、每次运行的落点，以及触发时投递的消息。创建任务或改写它的落点，就是授权未来无人值守开销的动作，因此两者都要求在活动根 agent 轮次中存在直接的人类消息；创建自身会话的落点还必须声明其运行所用的工作目录、agent 预设与权限预设。每一次管理失败都以闭集 `CronErrorCode` 中的一个码抵达模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应当自行管理定时任务时，把 `dsh-tool-cron` 挂载在 [`dsh-cron`](../cron/README.zh.md) 旁边。能力包拥有规则、存储、租约与运行；本包只拥有模型读到的 schema 与结果。

### 工具

| 工具 | 作用 |
|---|---|
| `cron_create(expression, time_zone, target, prompt, max_run_ms?, overlap_policy?, misfire_policy?)` | 在直接人类轮次中创建一个无人值守任务 |
| `cron_list()` | 列出每个任务的规则、落点、提示词、上限、启用状态、下次发生时刻与最近运行 |
| `cron_update(id, expression?, time_zone?, target?, prompt?, max_run_ms?, overlap_policy?, misfire_policy?, enabled?)` | 在直接人类轮次中替换某个任务声明的字段 |
| `cron_delete(id)` | 移除某个任务及其已记录运行 |
| `cron_run(id)` | 立即把某个任务运行一次，且不移动它的排期 |

`cron_create` 与 `cron_update` 以所存任务的 id、RFC 3339 UTC 的下次发生时刻以及启用状态作答，调用方无需重读自己刚写入的任务。其余结果就是该任务或该运行的规范 JSON。

`new-session` 落点声明 `workspace_path`、`agent_preset` 与 `permission_preset`：运行发生在无人值守时，因此任务本身必须声明它以什么身份运行。本包不会替未声明预设的任务填入默认值。`model_provider` 与 `model` 要么同时声明，要么都不声明，它们覆盖该任务运行所用的部署默认路由。

### 配置它

```yaml
- id: tool-cron
  name: '@deepseek-ai/dsh-tool-cron'
  config:
    defaultMaxRunMs: 600000
```

`defaultMaxRunMs` 是创建时未声明上限的任务所用的运行上限。它必须是正的安全整数。

### 权限规则

`cron_create` 与 `cron_update` 要求在活动根 agent 轮次中存在直接的人类消息，与面向模型的目标工具所要求的授权相同。自主模型轮次、子 agent、嵌套调用方，以及没有开启轮次的调用，都会在触及能力之前被拒绝，且拒绝文本会点出需要人类轮次的那个工具。`cron_list`、`cron_delete` 与 `cron_run` 是收回开销而非支出开销，因此它们需要活动的根 agent 轮次，但不需要人类消息。

### 错误

每个工具的失败分支都是 `{ ok: false, code, message }`，其中 `code` 是 `cron_invalid_expression`、`cron_invalid_time_zone`、`cron_not_found`、`cron_not_leader` 与 `cron_run_in_progress` 之一。`cron_not_found` 的确切含义是：存储在所声明的 id 之下没有任何任务。畸形的参数与来自能力之外的抛出都不是领域状态，因此它们以自身文本作为失败调用出现，而不会借用某个码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本节说明工具如何认证调用方并转换失败；可观察的契约见[使用本包](#use-this-package)。

### 设计

- **借来的权限读取。** `src/authority.ts` 复用 [`dsh-tool-goal`](../../goal/tool-goal/README.zh.md) 的 `goalToolExecution` 与 `requireDirectHuman`，而不是再拥有一份轮次边界的读取。这一依赖落在该包的库上，而不是它的插件上：该检查读取 `ctx.agents` 与 `ctx.sessionProjections`，因此组合这些工具并不要求挂载目标工具。
- **schema 负责校验，函数体不再校验。** `defineTool` 在 `execute` 之前校验参数，因此缺失字段或类型错误由注册表拒绝。函数体只检查 schema DSL 无法表达的跨字段规则，例如 `new-session` 落点漏掉其运行所用的预设，并以自身文本大声失败。
- **提供方的拒绝保留其码。** `CronServiceError` 按能力抛出的码变成 `{ ok: false, code, message }`。其他任何抛出都会被重新抛出，因此意料之外的基础设施故障仍是 `isError` 结果，而不会被洗成领域码。
- **每个工具一个 effect。** 每次注册都在自己的 `ctx.effect(...)` 内运行，因此释放插件 fiber 会注销全部五个工具。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、五个工具注册、结果渲染与失败转换 |
| [`src/authority.ts`](src/authority.ts) | 创建与更新工具所要求的无人值守权限检查 |
| — | 未发布运行时不变式伴随文件；这些工具不拥有独立状态，而它们依赖的关系（进程只在担任领袖时提供 `ctx.cron`）由 `dsh-cron` 内部强制。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Cron 能力](../cron/README.zh.md) — 工具所管理的规则、存储、租约与运行。
- [面向模型的目标工具](../../goal/tool-goal/README.zh.md) — 本包复用的权限检查。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cron) — 模型收到的确切 schema。
- [Cron 定时任务 Agent Note](../../../.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.zh.md) — 为什么创建就是授权动作。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与结果

#### 模型看到什么

生成的 [`cron_create`、`cron_list`、`cron_update`、`cron_delete` 与 `cron_run` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cron)。参数、结果与拒绝只提及表达式、时区、落点、提示词与运行上限；面板、传输、存储或领袖词汇都不会抵达模型。`cron_create` 与 `cron_update` 以任务 id、RFC 3339 UTC 的下次发生时刻与启用状态作答。

#### Token 影响

在这些工具可见的每个请求上有固定的 schema 开销，外加每次调用一个结果。`cron_list` 随已存任务数量以及每个任务保留的有界运行历史增长。

#### KV 缓存影响

只要定义与可见性不变，schema 就是前缀稳定的。调用与结果追加在可复用的请求前缀之后，不会使更早的条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了定时任务工具何时不合适或需要特别小心。它们是本包当前的约束，不是任务清单。

- **上限是挂钟界限，不是资源预算** — `max_run_ms` 会取消超时的运行；它不限制其中的 token 或工具调用。
- **没有无人值守的完全访问** — `new-session` 任务必须声明其权限预设，本包绝不会替未声明的任务填入宽松预设。
- **删除本身不带权限检查** — 取消任务是在收回权限，因此自主轮次可以删除任务；只有创建与改写需要人类轮次。
- **`cron_run` 不是一次触发** — 它记录一次运行，且不触碰所存排期与其下次发生时刻。
- **结果时刻是 UTC** — 模型把每个发生时刻读作 RFC 3339 UTC 时刻，报告当地时间时必须自行换算到任务声明的时区。
- **尚无快照固定渲染文本** — schema 与结果由本包的聚焦测试固定；Cron 触发运行的无密钥录制会话场景属于 T15。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
