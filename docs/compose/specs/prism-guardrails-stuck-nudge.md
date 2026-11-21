---
feature: prism-guardrails-stuck-nudge
status: delivered
updated: 2026-11-13
branch: feat/prism-guardrails-stuck-nudge
commits: 5e4a579eaa..3a74af2a3e
---

# Prism-guardrails 卡住提醒（stuck nudge）

## Report

**What was built** — guardrails bundle 的第十三条 rail。一轮之内连续失败调用达到 `stuckNudgeAfterFailures`（默认 3，出厂开启，`0` 关闭）时，一次走 agent 自身 provider 路由、绑定 `exec.signal` 的一次性裁判调用判断这串失败是否同一个循环；置信度达 `stuckNudgeConfidence` 的肯定把一句提醒附在失败调用的已接受结果上（`additionalContexts`），调用本身永不被拒。任何成功清空失败串；循环开启新轮次（无论由什么消息开启）即重置失败串与 `stuckNudgePerTurn` 配额。无 llm 服务、无路由、输出不可解析、裁判调用失败都只留 warn 日志并放行；ledger 记 `steer`，`/guardrails` 列出该 rail 与武装状态。

**Verification** — host face `tsc --noEmit` PASS；vitest 174/174 PASS（含新增：off 全程零裁判、每轮配额独立、observe 注入且 ledger 计数、判定不足/解析失败/成功清串/跨轮重置）；capability e2e 4/4 PASS（patch 显式关 nudge，理由在注释）；oxlint、whitespace、双语配对一致。独立 review 的 2 个 CRITICAL（无路由/不可解析路径缺 warn、非用户消息开启的轮次不重置）与可行动 MINOR（quota-0 时 status 武装判定、裁判调用转发取消信号、组合工具盲点注释、陈旧 changelog hash、空洞断言与覆盖缺口）全部修复；修复后全套件重跑通过。

**Journey log** —
- **e2e 加载 built `lib/`。** capability 场景从构建产物加载 bundle；改了 src 之后不重建，patch 里的新配置键就是旧产物的 unknown key，整个 bundle 加载失败、四个场景全挂。改完源码必须 `node node_modules/tsdown/dist/run.mjs` 重建再跑 e2e。另外 out-of-tree 插件目录跑 `pnpm run build` 会生成游离的 `pnpm-lock.yaml`，不要把它提交进去。
- **重置语义按轮次号，不按消息来源。** 初版用"出现用户消息即重置"（repeat rail 的写法），review 指出 schedule 来源开启的轮次不会重置。改为与 TurnRecords 相同的"循环开启该记录未 见过的轮次即重置"，对任何入队来源都成立。
- **裁判调用的失败路径要可区分。** 初版 `judgeStuck` 对无路由与不可解析都静默返回 `undefined`，README 却承诺"留一行日志"。改为返回 `StuckVerdict | 'no-route' | 'unusable'`，由调用方按原因分别 warn——承诺与实现重新对齐。
- **observe 模式的 steer 不进 decisions 列表。** `describeDecisions` 只列 `observed` 行，steer 只进计数；断言 ledger 时要盯 `decisions this session: N (0 observed)` 这一行，不是找 steer 行文本。

## [S1] Problem

Agent 在同一轮里反复重试同一种失败调用（同样的报错、相近的参数），没有任何机制提示它换思路。现有 repeat rail 只拦截"完全相同的调用"，且动作是送去审批，不是提醒。参考微软 TokenEconomizer 的第一招：同一轮里反复出现同样的报错时，请一个"裁判"模型判断是否真的在原地打转，置信度足够才注入一句提醒，让 agent 换个思路；提醒后仍卡住则明说可以停下——绝不自行掐断。

## [S2] Design

### S2.1 检测（`tools/post-execute`）

- `result.isError === true` 时向该 agent 的失败链追加 `{tool, message}`（错误文本截断）；一次成功调用清空链。
- 轮次号变化即重置：检测范围是一轮之内（TokenEconomizer 语义），`tools/pre-execute`/`turn` 边界不额外维护。
- 链长达到 `stuckNudgeAfterFailures` 时触发一次裁判调用；链长继续增长（裁判期间更多失败）不重复触发，由每轮配额约束。

### S2.2 裁判（一次性 llm 调用）

- 输入：失败链摘要（工具名 + 截断错误文本）；system 指令要求只回 JSON `{"spinning": boolean, "confidence": <0..1>}`。
- 路由：调用 agent 自己的路由（`requestHeader().config` → `agent.options`）；无路由或 `ctx.llm` 未挂载 → 不 nudge，warn 日志（检测与计数照常）。
- 判定：`spinning === true && confidence >= stuckNudgeConfidence`（默认 `0.7`）才注入；解析失败视为"没卡"，warn 日志。
- token 上限 `stuckNudgeMaxTokens`（默认 `512`）。裁判调用失败（网络/限流/解析）不重试、不传播——它是外部依赖，失败只意味着这次没有提醒。

### S2.3 注入（`additionalContexts`，绝不拦截）

- post-execute 决策：先 `await next()`，accept 时返回 `{ ...decided, additionalContexts: [nudge] }`——调用结果原样放行，模型在下一步看到提醒；block 类决策原样返回（rail 永不把失败调用变成拒绝）。
- 提醒文本（英文，与现有 steer 文本同语言）：指出同一失败已重复 N 次、错误未必靠重试解决、建议读错误换方法或询问用户，并明说"若继续卡住请直说，用户可以随时中断"。
- 每轮最多 `stuckNudgePerTurn`（默认 `1`）次。
- ledger 记 `note(ledger, agent, 'stuck nudge', subject, 'steer')`，`/guardrails` status 照常显示。

### S2.4 配置与治理

| 字段 | 默认 | 含义 |
|---|---|---|
| `stuckNudgeAfterFailures` | `3` | 触发裁判的连续失败数；`0` = 关（nudge 是纯提醒且裁判只在失败重复时调用，常态零开销，随 TokenEconomizer 默认开） |
| `stuckNudgeConfidence` | `0.7` | 裁判置信度阈值 |
| `stuckNudgeMaxTokens` | `512` | 裁判调用 token 上限 |
| `stuckNudgePerTurn` | `1` | 每轮最多注入次数 |

- 每字段一个 `resolveXxx`（整数/区间校验，非法 throw，`0` 映射 off），加入 `KNOWN_KEYS`；`configVersion` hash 整个 config，新字段自动进版本。
- observe 模式：nudge 是 steer 类（同 verification gate 先例），observe 不关闭它，ledger 记录照走。
- llm 是可选依赖：未挂载时检测照跑、裁判永不满足、其余 rails 不受影响。

## [S3] Scope

- In scope: 检测链、裁判调用、additionalContexts 注入、每轮限频、配置四项、测试、README 三语、changelog。
- Out of scope: 自行掐断会话（永不做）；跨轮记忆卡住状态；为裁判配置独立 provider/model（沿用 agent 路由）；对非 tool 路径（如纯文本循环）的检测。

## Tasks

- [x] T1: config 四字段 + resolve + KNOWN_KEYS（depends: none）
- [x] T2: installStuckNudge（检测链 + 裁判 + 注入 + 限频 + ledger）（depends: T1）
- [x] T3: 测试（patch 式 llm stub：触发/置信度不足/解析失败/无路由/成功清链/轮次重置/限频/observe）（depends: T2）
- [x] T4: README 三语 + changelog（depends: T2）

## [S4] Acceptance

- [x] 默认（off）时行为与现状一致：无检测、无裁判调用、无注入
- [x] 连续 N 次失败且裁判判定 spinning 且置信度达阈值 → 恰好一条 additionalContexts，调用本身照常 accept，结果不被替换
- [x] 裁判判没卡、置信度不足、输出不可解析、无 llm、无路由：全部无注入、无拒绝，warn 留痕
- [x] 一次成功调用清空失败链；新一轮开始时链与配额重置
- [x] 同一轮第二次达到条件不再注入（配额 1）
- [x] observe 模式照常注入并记录
- [x] 四个配置字段的非法值在加载时 throw
- [x] 现有 specs 全绿 + 新增 specs 覆盖上述路径；双面 typecheck 通过
