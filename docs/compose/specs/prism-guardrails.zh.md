---
feature: prism-guardrails
status: in-progress
updated: 2026-11-09
branch: feat/prism-guardrails
commits: df1583090a..
---

# Prism Guardrails：microcompact + 阈值追踪

[English](prism-guardrails.md) | 中文

## Report

## [S1] 问题

Prism 的自动压缩只在压力跨过 `dsh-compaction-basic` 阈值（默认 `min(0.8 × window, window − reserved − headroom)`）时才对历史做摘要。摘要是完整的辅助模型请求，并用单个摘要替换大段历史，丢掉模型本可保留的细节。ZCode 插入了更廉价的第一阶段（"microcompact"）：压力跨过更低阈值时就地清理过期的工具结果（免模型），延迟完整摘要并保留近期细节。Prism 没有对应机制，也没有可供消费方上报的压力追踪状态。

## [S2] 设计

### S2.1 新包 `packages/prism/prism-guardrails`

仅 host 的插件 `@prism-ai/prism-guardrails`，沿用 `dsh-compaction-tool-result-pruner` 的包布局：单一 leaf `tsconfig.json`（`rootDir: src`、`outDir: lib/types`，references 指向 `vendor/cosmokit`、`vendor/cordis`、`vendor/schemastery`、`packages/llm/llm`、`packages/llm/token-meter`、`packages/core/session`、`packages/core/agent`、`packages/compaction/compaction`），`src/` + `tests/*.spec.ts`，`README.md` + `README.zh.md` + `README.i18n.yaml`。由 base bundle 挂载；无每包 `cordis.patch.yml`（pruner 模式）。

### S2.2 服务

`PrismGuardrails` Cordis 服务，注册为 `ctx.guardrails`（Context merge 带目录 JSDoc），`static inject = ['llm', 'tokenMeter']`，schemastery `static Config`。构造器注册一个 `agent/pre-step` waterfall 监听器：(1) `signal.aborted` 时静默跳过；(2) 运行 `microcompactIfNeeded(agent, signal)`；(3) 每次落地一轮记一条 `info`（`cleared N results, ~X tokens freed`）；(4) 每次失败记一条 `warn` 并继续回合（护栏失败绝不阻塞步骤），分类的配置失败按路由目标只告警一次；(5) 始终 `return next()` —— 绝不短路 pre-step 链。

### S2.3 Microcompact 阈值（自有 headroom，不照抄压缩公式）

`resolveThreshold(config, contextWindow, reservedCompletionTokens)` = `floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`，沿用 `dsh-compaction-basic` 的包络形状但使用护栏自己的 `headroomTokens`，让结果能真正落到压缩阈值之下。默认 `thresholdRatio: 0.7`、`headroomTokens: 131_072`：在默认 1M 窗口、预留 256k 时，microcompact 在 612,928 启动，压缩在 678,464 启动，廉价流程先行。产生非正阈值的配置在解析时抛出本地 `GuardrailPressureConfigError`（响亮失败，同 `TargetPressureConfigError`）。"必须落在 compaction-basic 阈值之下才有效"这一关系写在配置字段文档上；不做跨包校验。

`thresholdRatio ∈ (0, 1]`、`headroomTokens ≥ 0` 整数、`keepRecentResults ≥ 1` 整数、`tools` 为非空字符串的可选数组。全部在 `resolveConfig` 中校验（`run()` 内没有 `?? default`；resolve 步骤拥有默认值）。

### S2.4 过期工具结果的选择

对稳定快照 `[...session.surface.nodes]` 的一轮扫描：(1) 折叠 `assistant/message` 的 tool-call block 得到 `callId → toolName`（表面配对把工具名放在 assistant 块中；`tool/call` 日志事件不是表面节点）；(2) 按表面顺序收集 `tool/result` 事件；(3) 过期 = 除最近 `keepRecentResults`（默认 4）条之外的全部结果，经 `tools` 过滤（缺省 = 所有工具均可清理）；(4) 跳过文本内容已不超过替换存根的候选（幂等；没有可释放内容时扫描保持廉价）。

### S2.5 持久替换协议

每个被清理的候选严格走 pruner 的 shadow-price 协议：(1) `session.append('compaction/prune', { shadowedRange: {start, end}, shadowedSeqs: [seq], shadowedTokenCount: tokenMeter.estimateMessage(original) })`；(2) `session.append('tool/result', { ...event.data, message }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })`，内容经 `freezeMessage` 替换为一段文本存根：`[Earlier <toolName> result cleared by microcompact to free context; re-run the tool if you still need it.]`。

替换是同类 `tool/result` 节点，工具配对按构造不受影响（无删除、无重排）；不需要 `toolPairingBalanced*` 辅助器。消息可见的历史变化通过追加的事件代次保持持久（model-visible ⟺ logged）。

### S2.6 阈值追踪

服务的 `async pressure(agent)` 返回脱离的快照 `{ totalTokens, contextWindow, thresholdTokens, willMicrocompact }` —— 通过注入的 token meter 加解析出的路由模型信息与 S2.3 阈值测得。`undefined` 上下文窗口产出 `null`（无可追踪）。UI 消费不在范围内。

## [S3] 范围

- 范围内：S2.1–S2.6 的新包；base bundle 接线（`packages/bundle/base/cordis.patch.yml` 的 insert 放在 `compaction-basic` 条目之前，让护栏 pre-step 监听器先注册；`packages/bundle/base/package.json` resolver-manifest 依赖）；单元测试；包 README（双语三件套）；目录/图生成器登记（SERVICE_PAGE、SERVICE_ROLES、类型豁免）；`docs/subsystems/compaction.md` 上的护栏段落。
- 范围外：ZCode 的工具副作用契约、prompt `cacheHint` 排序、`pressure()` 的任何 UI、对 `dsh-compaction-basic` 或 `dsh-compaction-tool-result-pruner` 的改动、subagent/workflow 特定行为。

## Tasks

- [x] T1：包脚手架（package.json、tsconfig、README 三件套、locale 目录）（依赖：无）
- [x] T2：配置解析 + 阈值数学，含校验测试（依赖：T1）
- [x] T3：microcompact 选择 + 持久替换流程，含测试（依赖：T2）
- [x] T4：pre-step 注册 + `pressure()` 追踪，含测试（依赖：T3）
- [x] T5：base bundle 接线 + lockfile + hygiene（依赖：T1）
- [ ] T6：完整验证轮（依赖：T2–T5）

## [S4] 验收

- [x] 在 1M 窗口、预留 256k 时，`thresholdRatio: 0.7, headroomTokens: 131072` 的护栏阈值（612,928）严格低于 compaction-basic 阈值（678,464）。
- [x] 超过 microcompact 阈值的会话，其过期工具结果被存根替换；最近 `keepRecentResults` 条与非 `tools` 结果保持完整。
- [x] 每次替换之前都有指名被遮蔽 seq 与估计 token 的 `compaction/prune` shadow-price 事件；`sourceEventSeqs` 引用原文。
- [x] 一轮之后工具配对完好（每个工具调用仍有恰好一条配对结果）。
- [x] 对已 microcompact 表面的第二轮零替换。
- [x] pre-step 监听器失败记警告并继续回合；链路从不短路。
- [ ] `pnpm run test`（包级）、`pnpm run typecheck` 与 `pnpm run hygiene` 对本变更面通过。
