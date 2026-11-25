---
feature: usage-reminder-toggle
status: designed
updated: 2026-11-24
branch: feat/usage-reminder-toggle
commits: 38749f9739 (master)
---

# 令牌用量提醒开关（默认关闭）

[English](usage-reminder-toggle.md) | 中文

## Report

已实现（2026-11-24，`plugins/prism-guardrails`）：

- T1：`usageReminderThresholds` 进入 `Config`/`ResolvedConfig`/`KNOWN_KEYS`；校验"正整数、严格升序"，空数组与省略键同为关闭，非法值（非数组、零/负/小数、非升序、重复）加载即 throw。
- T2：`installUsageReminder` 订阅 `session/event`，对 `assistant/message` 按 `totalTokens ?? inputTokens + outputTokens` 按会话内存自累计；在 `agent/turn-stopping` 对首次越过的阈值 `agent.steer` 一句英文提醒（每会话每阈值至多一次；同一边界越过多个阈值只报最高者并一并标记），经 `note()` 记 `usage reminder` 台账；`/guardrails` 报告新增一行（14 条 rail）。
- T3：套件 163 项全绿——默认关闭零行为、空数组=关闭、首次越阈值恰一条 steer、同阈值不重复、一次越多个阈值取最高、无 usage 的 step 不累计、非法配置逐项 throw、`/guardrails` 报告行。
- T4：README.md 与 README.zh.md 同步（配置表、rail 小节、拒绝项表、`/guardrails` 示例、已知限制），README.i18n.yaml 重新录制。
- 验证：`tsc --noEmit` 通过；tsdown 构建产物含新 rail；`scripts/smoke.mjs` 通过。

## [S1] Problem

ZCode v3.19.1 新增"令牌用量提醒开关，默认关闭"。prism 有完整的用量**展示**（客户端 StatsPills/UsagePill 读 durable `tokenUsage` 投影，`packages/client/ui-chat/src/client/chat/StatsPills.tsx:299`；服务端投影 `packages/llm/token-meter/src/usage-projection.ts:124-164`），但没有"累计用量达到阈值时提醒模型注意"的机制。落点在 `plugins/prism-guardrails`：它已订阅 `session/event`（`src/index.ts:396-407`）并已在 `agent/turn-stopping` 上做 steer 注入（`src/index.ts:555-564`、`600-608`），基建全部现成。

## [S2] Design

### S2.1 观察点：`session/event` 自累计

- 插件订阅 `session/event`（先例 `plugins/prism-pocket/src/index.ts:239-242`），对 `event.type === 'assistant/message'` 读取 `event.data.usage?: TokenUsage`（`packages/core/session/src/types.ts:349-357`），按会话累加。
- 口径：优先 `totalTokens`，缺省时 `inputTokens + outputTokens`（`TokenUsage` 定义 `packages/llm/llm/src/types.ts:182`）。纯内存累计，插件重启清零——提醒不是计费，可接受（README 注明）。
- 不读 `tokenUsage` 投影：其 fold 语义含 retry 替换/settledAt（面向计费正确性），对"提醒"是多余精度；自累计约 20 行且不依赖 token-meter 是否挂载。

### S2.2 注入：越阈值时 `agent.steer`

- 阈值列表 `usageReminderThresholds`（升序校验）。某会话累计**首次**越过某阈值时，在该会话的 `agent/turn-stopping` 事件里 `agent.steer(message)`（guardrails verification-gate 同款，`runtime-types.ts:260`），每会话每阈值至多一次。
- 文本（英文，同现有 steer）：`Session token usage has reached ~120k tokens. Continue with the task, but prefer concise outputs and avoid re-reading large files unnecessarily.`（数字按实际阈值格式化）。
- steer 在最近 step 边界消费，不打断任务；与 stuck-nudge 的"只提醒不拦截"同哲学。

### S2.3 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `usageReminderThresholds` | `[]` | 累计 token 阈值列表（升序正整数）；**空数组 = 关闭**，对齐 ZCode"默认关闭" |

- 加入 `KNOWN_KEYS`；校验：数组、正整数、升序，非法值加载即 throw；`configVersion` 自动覆盖。

### S2.4 台账

触发时经 `note()` 记 `usage reminder`（`/guardrails` 报告可见）。

## [S3] Scope

- In scope: guardrails 内 `session/event` 累计、阈值判定、`agent.steer` 注入、`usageReminderThresholds` 配置、台账、测试、README。
- Out of scope: 成本/金额展示（`usage-billing` spec 已交付）；限流、熔断或强制停止；跨插件重启的累计持久化；多会话聚合提醒。

## Tasks

- [x] T1: config `usageReminderThresholds` + 校验 + KNOWN_KEYS（depends: none）
- [x] T2: `session/event` 累计 + 阈值判定 + `agent/turn-stopping` steer + 台账（depends: T1）
- [x] T3: 测试——默认关闭零行为、越首阈值恰一条 steer、同阈值不重复、多阈值递进、非法配置 throw（depends: T2）
- [x] T4: README 补充说明（depends: T2）

## [S4] Acceptance

- [ ] 默认 `[]` 时零注入、零台账，行为与现状一致
- [ ] 配置 `[100000, 250000]` 时：累计达 100k 后的下一轮边界收到一条 steer；达 250k 再收到一条；同阈值不重复
- [ ] 累计口径 = `totalTokens`（缺省 input+output），消息中的数字与阈值一致
- [ ] `[50000, 20000]`（非升序）、`[-1]`、`"100000"` 等非法配置加载即 throw
- [ ] guardrails 既有测试全绿；新增用例覆盖上述路径
