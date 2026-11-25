---
feature: guard-message-redaction
status: designed
updated: 2026-11-24
branch: feat/guard-message-redaction
commits: 待交付时回填
---

# Guardrails 消息与台账脱敏

## Report

待实施后回填。

## [S1] Problem

guardrails 的拦截/审批/steer 消息与决策台账会携带来自命令或工具错误的原文片段：命令守卫的台账 `subject` 就是命令原文（`src/index.ts:1114`，`src/decision.ts:33-35`），可能含 `password=...`、URL 内嵌凭据、`Bearer` 令牌；stuck-nudge 注入的工具错误文本（截 160 字符，`index.ts:743-757`、`failureText` `index.ts:762-766`）、verification gate 的文件列表、ponytail marker 原文（`index.ts:481-483`）同理。ZCode v3.19.1 修复了"钩子拦截提示暴露命令中的密码等敏感信息"；prism 需要在插件自有消息面统一脱敏。settings 的 `redactSecrets` 是 schema 驱动的结构化脱敏（`packages/settings/settings/src/redact.ts:106-116`），不能处理自由文本，需要一个小型文本脱敏 helper。基库的后台任务 label / 调用卡片标题（`packages/shell/tool-bash`）不在插件射程，本次不动。

## [S2] Design

### S2.1 文本脱敏 helper（新 `src/redact.ts`）

- `redactSecretsInText(text: string): string`，模式替换、大小写不敏感、幂等：
  - URL 内嵌凭据：`scheme://user:pass@host` → `scheme://***@host`；
  - 敏感键赋值：`password=…`、`token: …` 等 `key=value` / `key: value` 形态，key 命中名单（`password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|secret[-_]?key|client[-_]?secret|authorization|credential|private[-_]?key`）→ 值替换为 `***`；
  - HTTP 头形态：`Bearer <tok>` / `Basic <tok>` → `Bearer ***` / `Basic ***`；
  - 不碰普通路径、哈希、长随机 id（保留调试价值，避免误伤）。
- 只做展示层脱敏：**规则匹配仍用原文**（先匹配、后脱敏），否则模式会漏配。

### S2.2 统一应用点

- `decide()` / `note()`（`index.ts:183-216`）：对入参 `subject` 与 `reason` 先过 helper 再入台账/生成决策——一次性覆盖 plan-mode、repeat、skill guidance、routing contract、write budget、dependency manifests、sensitive reads、command guard 的消息与台账；`/guardrails` 报告（`describeRails`/`describeDecisions`）读的是已脱敏台账，自动受益。
- steer 类直接构造文本的三处单独接入：verification gate 文件列表（`index.ts:558` 附近）、unfinished todos（`index.ts:603` 附近）、stuck-nudge 注入文本与 `failureText`（`index.ts:749`、`762-766`）。

### S2.3 配置

无新增配置键，常开（安全卫生修复，与 ZCode 行为对齐；模式名单不是部署可调项）。

## [S3] Scope

- In scope: `src/redact.ts` helper 及单测、`decide`/`note` 入口接入、三处 steer 文本接入、行为测试、README 说明。
- Out of scope: 基库后台任务 label 与 bash 调用卡片标题（`tool-bash` 的 `label: args.command`）；命令/路径匹配语义的任何变化；跨插件通用脱敏服务。

## Tasks

- [ ] T1: `src/redact.ts` + 单测（各模式、幂等、不误伤）（depends: none）
- [ ] T2: `decide`/`note` 入口与三处 steer 文本接入（depends: T1）
- [ ] T3: 行为测试——含密命令命中后台账/报告无原文、stuck-nudge 错误文本脱敏、匹配行为不变（depends: T2）
- [ ] T4: README 补一段脱敏说明（depends: T2）

## [S4] Acceptance

- [ ] 命令 `curl -d "password=hunter2" …` 命中规则后，台账 `subject` 与 `/guardrails` 报告中只见 `password=***`
- [ ] `https://user:pass@host/x` 在任何经手消息中凭据被掩码为 `***@host`
- [ ] `Authorization: Bearer abc.def.ghi` 在错误文本/steer 文本中被掩码
- [ ] 规则 pattern 匹配仍基于原文，命中行为（ask/deny/observe）与现状一致
- [ ] 普通路径、普通文本、哈希不受影响；helper 幂等
- [ ] guardrails 既有测试全绿；新增用例覆盖上述路径
