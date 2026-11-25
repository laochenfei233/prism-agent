---
feature: wait-time-reminder
status: designed
updated: 2026-11-25
branch: feat/wait-time-reminder
commits: 7abf808b6c (master)
---

# Silent reminders by actual wait time

English | [中文](wait-time-reminder.zh.md)

English | [中文](wait-time-reminder.zh.md)

## Report

Delivered (2026-11-25, `plugins/prism-guardrails`):

- T1: `waitReminderAfterMs` and `waitReminderPerTurn` join `Config`/`ResolvedConfig`/`KNOWN_KEYS`; `waitReminderAfterMs` ships at 60000 (the same "pure reminder ships on" posture as the stuck nudge), `0` disables; `waitReminderPerTurn` defaults to 2, `0` disables; a non-integer or negative value throws at load.
- T2: `installWaitTimeReminder` wraps `tools/execute` (t0 → `next()` → elapsed) without touching `exec.signal`; when `elapsed >=` the threshold it appends one `additionalContexts` entry to that result (`createUserMessage`, the stuck-nudge shape) leaving the result's content unchanged; the per-turn quota reuses guardrails' existing `agent/pre-step` turnSeen turn mechanics; the ledger records `wait reminder` via `note()` (`steer`, identical under observe/enforce); the `/guardrails` report gains one line (15 rails total).
- T3: 8 new cases — `0` disables with zero injections, an over-threshold call adds exactly one reminder with the result unchanged, the per-turn limit of 2, a new turn resets the quota, duration formatting, the enforce status line, and the ledger showing the `wait reminder` steer under observe; the suite is 181/181 green.
- T4: README.md and README.zh.md updated together (the rail table, the config table, the load-time rejection table, the `/guardrails` example, the rail section), the package.json description updated, README.i18n.yaml re-recorded.
- Verification: `npm run typecheck` (tsc --noEmit) passes; `npm run build` + `npm run smoke` pass; `npm test` (vitest, 181 tests) all green; `verify-translation-pairing` consistent.

## [S1] Problem

ZCode v3.19.1: "silent reminders now fire by actual wait time, so the nudge arrives earlier". prism has no equivalent: `packages/schedule` is calendar/recurrence scheduling, `repeat-tool-reminder` fires by repetition count, and `timeout-policy` is a cut-off — none measures "how long this call actually made the model wait" or reminds about it.

**Semantic assumption (please confirm)**: this spec implements it as — when a foreground tool call's **actual wait time** exceeds the threshold, attach one reminder sentence to that call's result (visible to the model's next step) naming the wait cost and suggesting backgrounding/splitting. It complements the base's foreground timeout (default 120s, capped at 600s, moves to background at the limit, `packages/shell/tool-bash/src/index.ts:336-356`): the threshold sits below the timeout and gives a soft nudge before the hard cut. Calendar-style "remind me at a time" is already owned by the `schedule` package and stays out of scope. If you wanted "a relative timer the user/model sets for N minutes from now", say so in the confirmation and the spec will become timer + `agent.followup` (cron already has that precedent).

## [S2] Design

### S2.1 Hook: wrap `tools/execute` with timing

- guardrails adds a `tools/execute` listener (template `packages/guard/timeout-policy/src/index.ts:52-76`): `t0 = Date.now()`; `const result = await next()`; `elapsed = Date.now() - t0`. It does not modify `exec.signal` (avoiding the fuse semantics of merging with the caller's signal, `pipeline.ts:262-284`).
- Reaching the threshold IS the trigger: the actual wait is the call's true blocking duration, so no extra timer exists and there is no "inject mid-wait" timing problem (the model cannot see any injection point before the tool returns anyway).

### S2.2 Injection: append `additionalContexts` to the result

- When `elapsed >= waitReminderAfterMs`, append one `createUserMessage` to that result (the stuck-nudge shape, `plugins/prism-guardrails/src/index.ts:743-757`; the pipeline merges `pipeline.ts:486-525`; the final splice lands in the next step's inbox, `packages/core/agent-loop/src/agent.ts:594-596`).
- The text (English, same language as the existing steers): states that the call waited roughly X seconds/minutes and suggests moving the long wait to a background run (`run_in_background`), splitting the task, or checking whether the call awaits input that cannot complete. The tone matches the stuck nudge: a hint, never a verdict of failure.
- At most one per call; at most `waitReminderPerTurn` per turn (default `2`), the counter reset at the `agent/turn-stopping` turn boundary (guardrails' existing turn mechanics).

### S2.3 Configuration

| Key | Default | Meaning |
|---|---|---|
| `waitReminderAfterMs` | `60000` | Actual waited milliseconds that trigger the reminder; `0` disables |
| `waitReminderPerTurn` | `2` | Maximum injections per turn |

- Both keys join `KNOWN_KEYS` (`config.ts:206-226`) with integer/range validation; an illegal value throws at load; `configVersion` covers them automatically.

### S2.4 Ledger

On trigger the rail records `wait reminder` via `note()` (`index.ts:208-216`) — a pure reminder that intercepts nothing, identical under observe and enforce.

## [S3] Scope

- In scope: the `tools/execute` timing wrapper in guardrails, the threshold/rate configuration, the `additionalContexts` injection, the ledger record, tests, and the README.
- Out of scope: reminders while waiting on a background subtask or user input (no injection point); the `schedule` package's calendar reminders; changes to the base timeout/background behavior; injection into streaming intermediate results.

## Tasks

- [x] T1: the two config keys + validation + KNOWN_KEYS (depends: none)
- [x] T2: the `tools/execute` timing + injection + per-turn limit + ledger (depends: T1)
- [x] T3: tests — a fast call injects nothing, an over-threshold call injects exactly one, the per-turn limit, `0` disables, the turn reset, enforce status line, observe ledger parity (depends: T2)
- [x] T4: README updates (depends: T2)

## [S4] Acceptance

- [x] With the default 60s threshold, a call under 60s returns a result with no addition
- [x] A call of 60s or more returns exactly one extra reminder context with the original content unchanged
- [x] The third over-threshold call in one turn is not injected (limit 2); a new turn resets the count
- [x] `waitReminderAfterMs: 0` injects nothing anywhere
- [x] observe and enforce behave identically (pure reminder); the ledger shows the `wait reminder` rows
- [x] guardrails' existing tests stay green; the new cases cover the paths above
