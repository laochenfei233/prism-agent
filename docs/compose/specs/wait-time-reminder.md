---
feature: wait-time-reminder
status: designed
updated: 2026-11-25
branch: feat/wait-time-reminder
commits: 待交付时回填
---

# 按实际等待时长的静默提醒

## Report

已实现（2026-11-25，`plugins/prism-guardrails`）：

- T1：`waitReminderAfterMs`、`waitReminderPerTurn` 进入 `Config`/`ResolvedConfig`/`KNOWN_KEYS`；`waitReminderAfterMs` 出厂默认 60000（与 stuck nudge 同款"纯提醒出厂开启"），`0` = 关闭；`waitReminderPerTurn` 默认 2，`0` = 关闭；非整数或负数加载即 throw。
- T2：`installWaitTimeReminder` 包装 `tools/execute`（t0 → `next()` → elapsed），不触碰 `exec.signal`；`elapsed >= 阈值` 时在该结果上追加一条 `additionalContexts`（`createUserMessage`，stuck-nudge 同款形态），原结果 content 不变；每轮配额沿用 guardrails 既有 `agent/pre-step` turnSeen 轮次机制重置；经 `note()` 记 `wait reminder`（`steer`，observe/enforce 行为一致）；`/guardrails` 报告新增一行（共 15 条 rail）。
- T3：新增 8 项用例——`0` 关闭零注入、超阈值恰一条提醒且原结果不变、每轮限频 2、新一轮配额重置、时长格式化、enforce 状态行、observe 下台账可见 `wait reminder` steer；套件 181 项全绿。
- T4：README.md 与 README.zh.md 同步（rail 总表、配置表、加载期拒绝项表、`/guardrails` 示例、rail 小节），package.json 描述更新，README.i18n.yaml 重新录制。
- 验证：`npm run typecheck`（tsc --noEmit）通过；`npm run build` + `npm run smoke` 通过；`npm test`（vitest，181 项）全绿；`verify-translation-pairing` 一致。

## [S1] Problem

ZCode v3.19.1："静默提醒改为按实际等待时间触发，提示更及时"。prism 没有对应机制：`packages/schedule` 是日历/周期调度、`repeat-tool-reminder` 按重复次数、`timeout-policy` 是超时截断——都没有"这次调用实际让模型等了多久"的度量与提醒。

**语义假设（请确认）**：本 spec 把该条实现为——前台工具调用**实际等待时长**超过阈值时，在该调用的结果上附加一句提醒（模型下一步可见），提示等待成本并建议后台化/拆分。它与基库的前台超时（默认 120s、封顶 600s，到点转后台，`packages/shell/tool-bash/src/index.ts:336-356`）互补：阈值低于超时，提前给出软提示而不是等到硬截断。日历式"定时提醒"已有 `schedule` 包承担，不在本 spec 范围。若你想要的是"用户/模型设定 N 分钟后提醒"的相对定时器，请在确认时说明，spec 将改为 timer + `agent.followup` 方案（cron 已有同款先例）。

## [S2] Design

### S2.1 挂点：`tools/execute` 环绕计时

- guardrails 新增 `tools/execute` 监听（模板 `packages/guard/timeout-policy/src/index.ts:52-76`）：`t0 = Date.now()`；`const result = await next()`；`elapsed = Date.now() - t0`。不修改 `exec.signal`（避免与 caller 信号 fuse 语义纠缠，`pipeline.ts:262-284`）。
- 到点即"触发"：实际等待时长就是本次调用的真实阻塞时长，无需额外定时器，也就没有"等待中途注入"的时序问题（工具返回前模型本就看不到任何注入点）。

### S2.2 注入：结果附加 `additionalContexts`

- `elapsed >= waitReminderAfterMs` 时，向该结果追加一条 `createUserMessage`（stuck-nudge 同款形态，`plugins/prism-guardrails/src/index.ts:743-757`；管线合并 `pipeline.ts:486-525`；最终 splice 进下一步 inbox，`packages/core/agent-loop/src/agent.ts:594-596`）。
- 文本（英文，与现有 steer 文本同语言）：说明该调用实际等待了约 X 秒/分钟，建议：长等待改用后台运行（`run_in_background`）、拆分任务，或检查是否在等待不可能完成的输入。语气与 stuck-nudge 一致：只提示，不判定失败。
- 每个调用至多一条；每轮至多 `waitReminderPerTurn` 条（默认 `2`），由 `agent/turn-stopping` 轮次边界重置计数（guardrails 既有轮次机制）。

### S2.3 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `waitReminderAfterMs` | `60000` | 触发阈值的实际等待毫秒数；`0` = 关闭 |
| `waitReminderPerTurn` | `2` | 每轮最多注入条数 |

- 两键加入 `KNOWN_KEYS`（`config.ts:206-226`），整数/区间校验，非法值加载即 throw；`configVersion` 自动覆盖。

### S2.4 台账

触发时经 `note()`（`index.ts:208-216`）记 `wait reminder`（纯提醒，不拦截，observe/enforce 行为一致）。

## [S3] Scope

- In scope: guardrails 内 `tools/execute` 计时包装、阈值/限频配置、`additionalContexts` 注入、台账记录、测试、README。
- Out of scope: 等待后台子任务/用户输入期间的提醒（无注入点）；`schedule` 包的日历提醒；基库超时/转后台行为改动；对流式中间结果的注入。

## Tasks

- [x] T1: config 两键 + 校验 + KNOWN_KEYS（depends: none）
- [x] T2: `tools/execute` 计时 + 注入 + 每轮限频 + 台账（depends: T1）
- [x] T3: 测试——快调用不注入、超阈值注入一条、限频、`0` 关闭、轮次重置、observe 一致（depends: T2）
- [x] T4: README 补充说明（depends: T2）

## [S4] Acceptance

- [x] 默认 60s 阈值下，<60s 的调用结果无附加内容
- [x] ≥60s 的调用结果恰好多一条提醒 context，原结果 content 不变
- [x] 同一轮第 3 次超阈值不再注入（限频 2）；新一轮计数重置
- [x] `waitReminderAfterMs: 0` 时全程无注入
- [x] observe 与 enforce 行为一致（纯提醒）；台账可见 `wait reminder` 记录
- [x] guardrails 既有测试全绿；新增用例覆盖上述路径
