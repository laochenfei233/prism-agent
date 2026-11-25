---
feature: usage-reminder-toggle
status: designed
updated: 2026-11-24
branch: feat/usage-reminder-toggle
commits: 38749f9739 (master)
---

# Token usage reminder switch (off by default)

English | [中文](usage-reminder-toggle.zh.md)

English | [中文](usage-reminder-toggle.zh.md)

## Report

Delivered (2026-11-24, `plugins/prism-guardrails`):

- T1: `usageReminderThresholds` joins `Config`/`ResolvedConfig`/`KNOWN_KEYS`; validation requires "positive integers, strictly ascending"; an empty array and an omitted key are both off, and illegal values (not an array, zero/negative/fractional, non-ascending, duplicates) throw at load.
- T2: `installUsageReminder` subscribes to `session/event`, accumulating per session in memory for `assistant/message` by `totalTokens ?? inputTokens + outputTokens`; at `agent/turn-stopping` it steers the agent once in English for the first threshold crossed (at most once per session per threshold; crossing several at one boundary reports only the highest and marks them all), the ledger records `usage reminder` via `note()`; the `/guardrails` report gains one line (14 rails).
- T3: the suite is 163/163 green — default off with zero behavior, empty array = off, the first crossing steers exactly once, no repeats for the same threshold, one boundary crossing several thresholds reports the highest, steps without usage accumulate nothing, every illegal config throws, and the `/guardrails` report line.
- T4: README.md and README.zh.md updated together (the config table, the rail section, the rejection table, the `/guardrails` example, known limitations), README.i18n.yaml re-recorded.
- Verification: `tsc --noEmit` passes; the tsdown build contains the new rail; `scripts/smoke.mjs` passes.

## [S1] Problem

ZCode v3.19.1 adds a "token usage reminder switch, off by default". prism has full usage **display** (the client StatsPills/UsagePill read the durable `tokenUsage` projection, `packages/client/ui-chat/src/client/chat/StatsPills.tsx:299`; the server projection is `packages/llm/token-meter/src/usage-projection.ts:124-164`) but no mechanism that "reminds the model when cumulative usage reaches a threshold". The home is `plugins/prism-guardrails`: it already subscribes to `session/event` (`src/index.ts:396-407`) and already injects steers at `agent/turn-stopping` (`src/index.ts:555-564`, `600-608`) — the infrastructure is all there.

## [S2] Design

### S2.1 Observation point: accumulate from `session/event`

- The plugin subscribes to `session/event` (precedent `plugins/prism-pocket/src/index.ts:239-242`) and, for `event.type === 'assistant/message'`, reads `event.data.usage?: TokenUsage` (`packages/core/session/src/types.ts:349-357`), accumulating per session.
- The measure: prefer `totalTokens`, falling back to `inputTokens + outputTokens` (the `TokenUsage` definition, `packages/llm/llm/src/types.ts:182`). Purely in-memory; a plugin restart clears it — a reminder is not billing, which is acceptable (stated in the README).
- It does not read the `tokenUsage` projection: that fold's semantics include retry replacement/settledAt (billing correctness), extra precision a reminder does not need; self-accumulation is ~20 lines and does not depend on token-meter being mounted.

### S2.2 Injection: steer when a threshold is crossed

- The threshold list is `usageReminderThresholds` (validated ascending). When a session's cumulative total **first** crosses a threshold, the rail calls `agent.steer(message)` on that session's `agent/turn-stopping` event (same as guardrails' verification gate, `runtime-types.ts:260`), at most once per session per threshold.
- The text (English, same as the existing steers): `Session token usage has reached ~120k tokens. Continue with the task, but prefer concise outputs and avoid re-reading large files unnecessarily.` (the number formatted from the actual threshold).
- The steer is consumed at the nearest step boundary and never interrupts the task; same philosophy as the stuck nudge — remind, never block.

### S2.3 Configuration

| Key | Default | Meaning |
|---|---|---|
| `usageReminderThresholds` | `[]` | Cumulative token thresholds (ascending positive integers); **empty array = off**, matching ZCode's default-off |

- It joins `KNOWN_KEYS`; validation: an array of positive integers, ascending; illegal values throw at load; `configVersion` covers it automatically.

### S2.4 Ledger

On trigger the rail records `usage reminder` via `note()` (visible in the `/guardrails` report).

## [S3] Scope

- In scope: the `session/event` accumulation in guardrails, threshold decisions, the `agent.steer` injection, the `usageReminderThresholds` config, the ledger, tests, and the README.
- Out of scope: cost/money display (the `usage-billing` spec is delivered); rate limiting, circuit breaking, or forced stops; persistent cross-restart accumulation; multi-session aggregated reminders.

## Tasks

- [x] T1: config `usageReminderThresholds` + validation + KNOWN_KEYS (depends: none)
- [x] T2: `session/event` accumulation + threshold decisions + the `agent/turn-stopping` steer + ledger (depends: T1)
- [x] T3: tests — default off with zero behavior, the first crossing steers exactly once, no repeats, multi-threshold progression, illegal config throws (depends: T2)
- [x] T4: README updates (depends: T2)

## [S4] Acceptance

- [ ] With the default `[]`, zero injections and zero ledger rows — behavior identical to today
- [ ] With `[100000, 250000]`: the turn boundary after reaching 100k delivers one steer; reaching 250k delivers another; the same threshold never repeats
- [ ] The measure is `totalTokens` (fallback input+output), and the number in the message matches the threshold
- [ ] `[50000, 20000]` (non-ascending), `[-1]`, `"100000"` and other illegal configs throw at load
- [ ] guardrails' existing tests stay green; the new cases cover the paths above
