---
description: "Prism 部署的免模型上下文微压缩：在摘要压缩触发前清理过期的工具结果，并追踪压缩启动阈值。"
kind: "package-reference"
---

# @prism-ai/prism-microcompact

[English](README.md) | 中文

## 概述

`prism-microcompact` 用一轮免模型的 microcompact 把会话压在 `dsh-compaction-basic` 的摘要阈值之下。当估计压力跨过更低的启动阈值时，它把过期的工具结果——除最近几条之外的全部——替换为一段点名工具的短存根，让近期细节得以保留，摘要压缩因此延后甚至不再发生。每次替换都遵循共享的 shadow-price 协议，完整原文保留在会话日志中以供精确重放。服务还暴露当前压力与启动阈值的对比，供上报方消费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当会话累积大量工具结果时，把本包挂在 `dsh-compaction-basic` 之前：廉价清理会先于摘要压缩发生，省下一次为压缩历史而花的模型调用。

### 最小可用组合

按此顺序挂载 token 计量、本包与压缩后端：

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@prism-ai/prism-microcompact'
- name: '@deepseek-ai/dsh-compaction-basic'
```

有了这三行，步骤之间会自动清理过期的工具结果。可以通过检查后续请求是否出现存根来验证；完整原文保留在会话日志中。

### 什么会被清理

每条比最近 `keepRecentResults` 条更早的工具结果都会被替换为一段文本存根：`[Earlier <tool> result cleared by microcompact to free context; re-run the tool if you still need it.]`。替换保留工具调用、步骤、错误与元数据——只有内容变化。文本长度已不超过存根的结果保持原样，因此重复执行会收敛。表面上缺少配对（没有携带其 callId 的 assistant tool-call block）的结果以 `unknown tool` 的名义清理。

### 设置阈值

所有设置均可选。生成的[配置目录](../../../docs/config-catalog.zh.md#prism-aiprism-microcompact)是穷尽来源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.7` | 以路由上下文窗口的这一比例启动 microcompact。 |
| `headroomTokens` | `131072` | 在输出预留之后、清理启动之前预留的容量。 |
| `keepRecentResults` | `4` | 始终保留的最近工具结果条数。 |
| `tools` | — | 允许清理的工具名；缺省清理所有工具。 |

启动阈值为 `min(thresholdRatio × contextWindow, contextWindow − reservedOutput − headroomTokens)`。在默认 1M 窗口上，默认值落在 `dsh-compaction-basic` 启动点之下（613k 对 678k），这正是廉价清理先行的原因；达到或超过压缩启动点的配置会让本流程永远无法启动。未知字段在插件构造时拒绝；不可用的路由容量按目标告警一次，而不是让回合失败。

### 清理何时运行

清理在步骤之间、pre-step 链中 compaction-basic 自身的压力检查之前运行。低于启动阈值时一切保持不变，且该流程本身不发起模型调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 microcompact 背后的设计决策；可观察行为已由 [Use this package](#use-this-package) 完整覆盖。

### 设计理念

本插件建立在三个承诺之上：

- **自有 headroom，沿用压缩的包络形状。** 启动阈值沿用 `dsh-compaction-basic` 的 `min` 公式但使用 microcompact 自己的 `headroomTokens`；否则压缩的 headroom 会把所有比例钳到同一阈值，本流程永远无法先行启动。
- **可重放的替换。** 原事件保留在追加式日志中；替换通过 `sourceEventSeqs` 引用它，重放因此能恢复产生存根的精确输入。
- **shadow-price 协议。** `compaction/prune` 紧贴每次替换之前，用注入的 token meter 为被替换区间定价，纯消费方无需每节点状态即可扣除。

### 清理机制

一轮扫描把当前表面折叠为 `callId → toolName` 映射（来自 assistant 的 tool-call block）加上工具结果序列。过期结果被替换为一条新追加的 `tool/result`，替换原节点并引用原文。`tool/result` 节点被替换为另一条 `tool/result` 节点，工具配对按构造保持完整，因此无需查询配对辅助器。`tools` 过滤与存根长度的幂等检查在任何事件追加之前跳过候选；一轮没有清理任何内容的执行不会落地任何事件。精确签名见 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`PrismMicrocompact` 服务、pre-step 监听器、`microcompactIfNeeded` / `pressure` |
| [`src/config.ts`](src/config.ts) | 默认值、校验、启动阈值数学、`MicrocompactPressureConfigError` |
| [`src/microcompact.ts`](src/microcompact.ts) | 过期选择、存根内容、持久替换协议 |
| [`src/types.ts`](src/types.ts) | `PrismMicrocompactConfig`、`ResolvedConfig`、`ClearedEntry`、`MicrocompactResult`、`PressureSnapshot` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面；它们从本插件走向它延迟的后端与共同测量的计价服务。

- [Compaction basic backend](../../compaction/compaction-basic/README.zh.md) — 本插件延迟的摘要后端。
- [Compaction seam](../../compaction/compaction/README.zh.md) — 本插件复用其替换协议的压缩契约。
- [Tool-result pruner](../../compaction/compaction-tool-result-pruner/README.zh.md) — 在压缩内部运行的按体积清理的姊妹流程。
- [Token meter](../../llm/token-meter/README.zh.md) — 启动决策背后的计量服务。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#prism-aiprism-microcompact) — 每个接受的配置字段及其来源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 被清理的工具结果

#### 模型看到的内容

跨过启动阈值后，后续请求看到的每条过期结果内容都是 `[Earlier <tool> result cleared by microcompact to free context; re-run the tool if you still need it.]`。最近 `keepRecentResults` 条结果保留完整文本。模型不会看到原文的第二份副本。

#### Token 影响

清理本身不发起模型调用；每条被清理的结果大致释放其全文的价格。当重新计量低于启动阈值时，摘要压缩完全不发生，模型保留本会被摘要压缩的近期历史。

#### KV Cache 影响

替换较早的结果会使从首个变化 token 起的缓存复用失效。被清理的结果位于较旧的历史中，因此保持不变的新近前缀仍可复用，变化区域不在热路径上。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了 microcompact 何时不适配或需要特别小心；它们是当前的包约束。

- **新旧不等于重要** —— 本流程只按新近度清理；一条持有某事实唯一副本的过期结果也会被同样清理，模型必须重跑工具取回。
- **阈值关系靠文档而非强制** —— 本插件读不到 `dsh-compaction-basic` 的有效启动点，因此错误配置会让两个流程在同一压力启动，microcompact 流程成为空操作。
- **估计 token，而非精确值** —— `ctx.tokenMeter` 启发式决定启动；provider 的精确记账可能不同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文，明确非权威；已发布行为以上方章节、包代码与链接的 Agent Notes 为准。

- **移植自 ZCode** —— 两段式压力响应（轻清理先行、摘要在后）移植自 zai-org/ZCode 的 microcompact 设计；阈值包络经过重塑，因为 compaction-basic 的 headroom 钳制会让移植无法生效。
- **按工具的新近度，暂缓** —— ZCode 按工具名分组并为每组保留最近结果；本移植使用单一全局新近窗口，更简单且释放严格更多。

</details>
