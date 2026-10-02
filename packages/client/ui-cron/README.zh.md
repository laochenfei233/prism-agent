---
description: "Web 定时任务面板：包含规则、时区、下次触发与状态的任务行，以及新建、编辑、删除、立即运行与最近结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cron

[English](README.md) | 中文

## Summary

`dsh-client-ui-cron` 在一个会话头部控件中显示本部署的定时任务。每行给出 Cron 规则、其 IANA 时区、该时区下的下次触发时间以及是否启用；一行可以被编辑、启用或停用、在二次确认后删除、立即运行一次，其最近运行结果就地展开。该面板是可选组件——Web bundle 以停用状态发布它，Cron overlay 与 Host 能力一同启用它。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

通过 Cron overlay 加载该插件；发布的 Web 依赖图能解析这个包，但把它的行保持停用，因此普通部署不会为一个未运行的能力长出控件。

### 一行显示什么

一行给出规则的原文、它所声明的时区、在该时区下渲染的下次触发时间，以及启用状态。用任务自身时区而非浏览器时区渲染下次触发，正是这一行的意义：以 `Europe/Berlin` 声明的任务在柏林时间 09:00 触发，无论查看者身处哪个时区。最近运行就地展开，显示结果、结束时间与耗时。

### 一行提供什么

编辑打开与新建相同的表单，并用已存任务预填。运行位置可以在"每次运行新建会话"（工作目录加上代理与权限预设）与"继续某个指定会话"之间切换。单次运行上限留空即不声明任何值，因此能力自身的默认值继续生效，而不是让一个捏造的数字成为已存上限。删除需要二次确认；立即运行只需一次，失败的运行会把原因留在原地。

### 面板无法服务时

不持有调度器租约的进程会报告"另一个进程是调度器"，而不是显示它无法确认的行——空列表会告诉操作者没有任务。失去承载时，流重连期间保留最后一批行；终止性的流失败会给出其原因。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部 — 点击展开</summary>

头部动作带中的一个插槽条目（位于静态会话标识与后台任务列表之后）渲染触发器及其面板。所有数据经 `ctx.cronJobs` 到达，它拥有整个 Client 唯一的 follow 世代；第二个挂载的头部共享同一批行，而不会开启第二个订阅。面板只持有自己的草稿、提示与待确认删除状态。

| 文件 | 作用 |
|---|---|
| [`src/client/CronPanel.tsx`](src/client/CronPanel.tsx) | 面板：行、表单、立即运行与最近结果 |
| [`src/client/logic.ts`](src/client/logic.ts) | 纯草稿、时间与耗时推导 |
| [`src/client/index.ts`](src/client/index.ts) | 插槽注册、命令面与字典 |
| [`src/client/locales.ts`](src/client/locales.ts) | `cron.panel` 命名空间文案（以中文为准） |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-api-cron-controller`](../../api/cron-controller/README.zh.md) —— 每一行背后的调度 Remote 命名空间与 follow 流。
- [`dsh-cron`](../../cron/cron/README.zh.md) —— 拥有表达式域、存储与领导租约的能力。
- [`dsh-tool-cron`](../../cron/tool-cron/README.zh.md) —— 模型触达同一批任务的路径。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 各行使用的 `StateDot` 标记。

-----

<a id="model-experience"></a>
## Model Experience

无。本包为人类渲染定时任务投影，不接触任何提示、消息、schema、流或工具结果。模型触达同一批任务的路径留在 [`dsh-tool-cron`](../../cron/tool-cron/README.zh.md)。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制定义当前的包约束，而不是待办清单。

- **模型选择不可编辑。** 已声明 provider 与 model 的任务会保留它们，表单只表达部署默认值；无法从面板把任务指向另一个模型。
- **没有分页或过滤。** 所有已存任务渲染在一个列表中，这对靠手工排布的部署规模足够，对更大规模则不够。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>供维护者的工作上下文 — 点击展开</summary>

无。

</details>

**Runtime invariant:** 不发布伴随项。本包把 `cron` Remote 命名空间读并命令式地投影到一个头部插槽条目上；follow 世代属于 `dsh-api-cron-controller`，插件自身的插槽注册通过 HMR 安全 spec 证明可释放。
