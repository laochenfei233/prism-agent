---
feature: prism-microcompact
status: in-progress
updated: 2026-11-21
branch: feat/prism-guardrails
commits: df1583090a..07b09556bf
---

# Prism Microcompact：过期工具结果清理流程的 salvage

[English](prism-microcompact.md) | 中文

## Report

**交付内容** —— 本分支交付了一个仅 host 的插件，移植 zai-org/ZCode 的 microcompact 阶段。一个 `agent/pre-step` 监听器测量路由后的会话，在跨过自己的启动阈值后，把过期的工具结果替换为一段点名工具的存根。默认值（`thresholdRatio: 0.7`、`headroomTokens: 131072`、`keepRecentResults: 4`）在 1M 窗口、预留 256k 时于 612,928 估计 token 启动，低于 `dsh-compaction-basic` 的 678,464，因此免模型的廉价流程先于摘要压缩发生。每次替换沿用 pruner 的持久 shadow-price 协议（`compaction/prune` 加一条引用原文的同类 `tool/result`），`pressure()` 上报路由测量值与阈值的对比。

**为什么改名** —— 仓库里已经有 `plugins/prism-guardrails`：一个出树的能力强制化 bundle，包含十二条强制决策 rail、Ponytail 模式和 `/guardrails` 命令。本分支的包位于 `packages/prism/prism-guardrails`，包名 `@prism-ai/prism-guardrails`；两个产品共享同一个名字，却做互不相关的事。本分支插件从不拒绝调用、不注册命令、不碰工具决策：它只改写会话历史来推迟压缩。现在它是 `packages/prism/prism-microcompact` 下的 `@prism-ai/prism-microcompact`，服务名改为 `ctx.microcompact`。

**为什么是 salvage 而不是 merge** —— 本分支停在 `df1583090a`（2026-11-08），早于当前树的 `0.2.2-rc.1` resync，也早于 fork 插件统一落在 `plugins/` 的形态。直接 rebase 会与能力强制 bundle 的身份、新的打包约定和生成的目录相撞。本分支保留为参考实现；移植是把这里的行为和测试复制到当前树，而不是重放旧提交。

**验证** —— 本次改名运行了重命名后包的聚焦测试、typecheck 和生成目录的 freshness 检查。模型可见存根的录制会话覆盖仍未完成：默认启动点在现有录制夹具中不可达，按场景覆盖阈值需要分支尚未构建的快照 harness 支持。

**Journey log** —— 最初的阈值不能照抄 `dsh-compaction-basic` 的公式：它的 headroom 钳制会把 0.8 以下所有比例压到同一个启动点，因此本流程必须有自己的 `headroomTokens` 才可能先行启动。工具名来自 assistant 的 tool-call block，而不是 `tool/call` 事件，因为后者仅写入日志、不是表面节点。可选数组配置沿用兄弟包约定（`tools?: string[]`、无 `readonly`），而不是被禁的 `as unknown` 默认值。

## [S1] 问题

同一棵树里有两个不同的产品都叫 "prism guardrails"。`plugins/prism-guardrails` 是强制化 bundle：它决定工具调用能不能跑、把重复调用送去审批、执行预算与回合边界，并自带 Ponytail。本分支的包是压缩优化：在摘要压缩前移除过期的工具输出，让会话更便宜。部署方、目录读者或搜索这个名字的维护者，无法从一行配置、一个锚点或一条日志里判断指的是哪个。

撞名不只是措辞问题。本分支的服务叫 `ctx.guardrails`，类和配置类型都带 `Guardrails`，错误前缀是 `prism-guardrails:`，bundle 行 id 也是 `prism-guardrails`。这些名字现在会被读成强制化 bundle。改名让压缩流程在开始移植前先拥有自己的词汇。

## [S2] 设计

### S2.1 改名映射

| 旧身份 | 新身份 |
|---|---|
| 包 `@prism-ai/prism-guardrails` | `@prism-ai/prism-microcompact` |
| 目录 `packages/prism/prism-guardrails` | `packages/prism/prism-microcompact` |
| 服务 `ctx.guardrails` | `ctx.microcompact` |
| 类 `PrismGuardrails` | `PrismMicrocompact` |
| 配置 `PrismGuardrailsConfig` | `PrismMicrocompactConfig` |
| 错误 `GuardrailPressureConfigError` | `MicrocompactPressureConfigError` |
| 本地 agent 表面 `GuardrailAgent` | `MicrocompactAgent` |
| bundle 行 id `prism-guardrails` | `prism-microcompact` |
| spec、README、测试、locale、目录键 | `prism-microcompact` |

两个插件共享一部分名字，但只有一个是本次对象：

| | 能力强制 bundle | Microcompact 流程 |
|---|---|---|
| 位置 | `plugins/prism-guardrails` | `packages/prism/prism-microcompact` |
| 包 | `prism-guardrails`（private） | `@prism-ai/prism-microcompact` |
| 负责 | 强制决策 rail、Ponytail、`/guardrails` | 清理过期工具结果、`pressure()` |
| 本次 salvage | 不动 | 改名并记录在这里 |

移植不得修改 `plugins/prism-guardrails`、它的 `cordis.patch.yml`、测试、`guardrails-hardening` spec 或 `/guardrails` 命令。两个插件可以同时加载；它们只共享 `agent/pre-step`。改名只覆盖压缩流程和挂载它的接线。

### S2.2 行为

行为不变。服务保留 `static inject = ['llm', 'tokenMeter']` 和一个 `agent/pre-step` waterfall 监听器。监听器在信号中止时跳过，运行 `microcompactIfNeeded`，每次落地记一条 `info`，每次失败记一条 `warn` 并继续回合，始终返回 `next()`。阈值仍是 `floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`。过期选择仍是除最近 `keepRecentResults` 条之外的所有结果，并按 `tools` 过滤。替换保留 pruner 的 shadow-price 事件和 `sourceEventSeqs` 引用。`pressure()` 返回 `{ totalTokens, contextWindow, thresholdTokens, willMicrocompact }` 或 `null`。

### S2.3 与两个邻居的关系

`plugins/prism-guardrails` 与本流程只共享 `agent/pre-step` 扩展点。bundle 决定预算、续跑和强制决策；本流程改写历史。两者的顺序不重要，也不应互相依赖。

更近的邻居是 `dsh-compaction-tool-result-pruner`。pruner 在 `dsh-compaction-basic` 内部、更高的压力阈值之后运行，只改写超长的当前结果；本流程更早启动，清理所有过期结果，而不只是超长的。两者互补，部署可以同时加载。本流程必须注册在 `dsh-compaction-basic` 之前，低阈值才可达。

### S2.4 salvage 移植

移植目标采用当前树的打包方式。工作名是 `plugins/prism-microcompact`，与 `plugins/prism-guardrails` 一样是 private、无 scope 的包；如果 fork 继续保留 `packages/prism` 下的第一方公开包，同一包也可以留在原处。移植时决定最终 scope 与布局，然后更新 bundle patch、tsconfig 路径、config catalog、Cordis API catalog、capability seams 图、事件矩阵、composition 图和插件包清单。

源码适配很小：`compaction/prune`、`session.eventAt`、`deriveEventMessage` 和 `tokenMeter` 在当前树上仍然存在。`session.eventAt` 已废弃，移植时换成当前访问器。移植重跑 21 个测试，然后为模型可见存根补录制会话用例。需要一个能达到更低启动点的快照夹具，或快照 harness 里的阈值覆盖；在补齐之前，这个模型可见变更没有录制覆盖。

如果移植引入部署可见的插件行或配置字段，需要写升级指南。本分支的改名不需要：包从未发布，也没有 profile 挂载旧名字。

### S2.5 待定决策

- **布局与 scope** —— `plugins/prism-microcompact`（private、无 scope）匹配当前 fork 打包；`packages/prism/prism-microcompact` 保留分支的第一方形态。行为相同。
- **服务名** —— 新名是 `ctx.microcompact`；更长的 `ctx.contextMicrocompact` 没有第二个上下文服务来支撑。
- **并进 pruner？** —— 不。pruner 在 `dsh-compaction-basic` 内部按阈值运行、按体积选择；本流程在旁边按更低阈值运行、按新旧选择。合并会把两条独立策略藏进一个配置面。

## [S3] 范围

- 本次范围内：分支上的改名；bundle、tsconfig、lockfile、生成器、目录、图和文档接线；重写的 spec 与 README。
- salvage 的后续：移植到当前树、补录制会话覆盖、确定最终布局，并在移植上重跑门禁。
- 范围外：修改 `plugins/prism-guardrails`、`dsh-compaction-basic` 或 `dsh-compaction-tool-result-pruner`；给本流程加 UI 或命令；按历史合并本分支。

## Tasks

- [x] T1：重命名包、目录、服务、类、配置、错误、测试、spec、README 和 locale（依赖：无）
- [x] T2：更新 bundle 行、tsconfig 路径、lockfile、生成器输入和生成目录（依赖：T1）
- [x] T3：重写 spec 与 README 对，并重新录制翻译配对（依赖：T1）
- [ ] T4：按选定布局把源码与测试移植到当前树（依赖：T2）
- [ ] T5：补模型可见存根的录制会话用例（依赖：T4）
- [ ] T6：在移植上重跑 typecheck、build 和文档门禁（依赖：T4、T5）

## [S4] 验收

- [x] 本树的活接线使用 `prism-microcompact` 与 `ctx.microcompact`；除本文件的历史说明外，不再有指向 `@prism-ai/prism-guardrails` 的活引用。
- [x] `plugins/prism-guardrails`、它的命令、spec 和 changelog 未被改动。
- [x] 改名后包的聚焦测试与 typecheck 通过，生成目录保持 fresh。
- [ ] 录制会话用例覆盖模型可见的存根替换（后续）。
- [ ] 移植按选定布局落到当前树并重跑门禁（后续）。
