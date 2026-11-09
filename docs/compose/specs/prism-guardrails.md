---
feature: prism-guardrails
status: in-progress
updated: 2026-11-09
branch: feat/prism-guardrails
commits: df1583090a..
---

# Prism Guardrails: microcompact + threshold tracking

English | [中文](prism-guardrails.zh.md)

## Report

## [S1] Problem

Prism's automatic compaction summarizes history only when pressure crosses `dsh-compaction-basic`'s threshold (default `min(0.8 × window, window − reserved − headroom)`). Summarization is a full auxiliary model request and replaces a large span with one summary, losing detail the model could have kept. ZCode inserts a cheaper first stage ("microcompact"): when pressure crosses a lower threshold, stale tool results are cleared in place (model-free), delaying full summarization and preserving recent detail. Prism has no equivalent, and no tracked pressure state a consumer could report.

## [S2] Design

### S2.1 New package `packages/prism/prism-guardrails`

Host-only plugin `@prism-ai/prism-guardrails` following the `dsh-compaction-tool-result-pruner` package layout: single leaf `tsconfig.json` (`rootDir: src`, `outDir: lib/types`, references to `vendor/cosmokit`, `vendor/cordis`, `vendor/schemastery`, `packages/llm/llm`, `packages/llm/token-meter`, `packages/core/session`, `packages/core/agent`, `packages/compaction/compaction`), `src/` + `tests/*.spec.ts`, `README.md` + `README.zh.md` + `README.i18n.yaml`. Mounted by the base bundle; no per-package `cordis.patch.yml` (the pruner pattern).

### S2.2 Service

`PrismGuardrails` Cordis service, registered as `ctx.guardrails` (Context merge with catalog JSDoc), `static inject = ['llm', 'tokenMeter']`, schemastery `static Config`. Constructor registers one `agent/pre-step` waterfall listener that: (1) skips silently on `signal.aborted`; (2) runs `microcompactIfNeeded(agent, signal)`; (3) logs one `info` line per landed pass (`cleared N results, ~X tokens freed`); (4) logs one `warn` per failed pass and continues the turn (guard failures never block a step), warning once per routed target for classified configuration failures; (5) always `return next()` — never short-circuits the pre-step chain.

### S2.3 Microcompact threshold (own headroom, not the compaction formula)

`resolveThreshold(config, contextWindow, reservedCompletionTokens)` = `floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`, mirroring `dsh-compaction-basic`'s envelope shape but with the guardrails' own `headroomTokens` so the result can actually fall below compaction's threshold. Defaults `thresholdRatio: 0.7`, `headroomTokens: 131_072`: on the default 1M window with 256k reserved, microcompact arms at 612,928 while compaction arms at 678,464, so the cheap pass runs first. Config values that produce a non-positive threshold throw a local `GuardrailPressureConfigError` at resolution (loud, like `TargetPressureConfigError`). The relationship "must land below compaction-basic's threshold to be effective" is documented on the config field; cross-package validation is not attempted.

`thresholdRatio ∈ (0, 1]`, `headroomTokens ≥ 0` integer, `keepRecentResults ≥ 1` integer, `tools` optional array of non-empty strings. All validated in `resolveConfig` (no `?? default` inside `run()`; the resolve step owns defaults).

### S2.4 Stale tool-result selection

One pass over a stable snapshot `[...session.surface.nodes]`: (1) fold `assistant/message` tool-call blocks to map `callId → toolName` (surface pairing carries names in assistant blocks; `tool/call` log events are not surface nodes); (2) collect `tool/result` events in surface order; (3) stale = every result except the last `keepRecentResults` (default 4) results, filtered by `tools` (omitted = every tool is eligible); (4) skip candidates whose text content is already no longer than the replacement stub (idempotency; passes stay cheap when there is nothing to free).

### S2.5 Durable replacement protocol

Per cleared candidate, exactly the pruner's shadow-price protocol: (1) `session.append('compaction/prune', { shadowedRange: {start, end}, shadowedSeqs: [seq], shadowedTokenCount: tokenMeter.estimateMessage(original) })`; (2) `session.append('tool/result', { ...event.data, message }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })` with `freezeMessage`'d content replaced by one text stub: `[Earlier <toolName> result cleared by microcompact to free context; re-run the tool if you still need it.]`.

The replacement is a same-kind `tool/result` node, so tool pairing is untouched by construction (no removal, no reordering); the `toolPairingBalanced*` helpers are not needed. The message-visible history change is durable through the appended event generation (model-visible ⟺ logged).

### S2.6 Threshold tracking

`async pressure(agent)` on the service returns a detached snapshot `{ totalTokens, contextWindow, thresholdTokens, willMicrocompact }` — measured through the injected token meter plus the resolved routed model info and S2.3 threshold. `undefined` context window yields `null` (nothing tracked). UI consumption is out of scope.

## [S3] Scope

- In scope: new package per S2.1–S2.6; base-bundle wiring (`packages/bundle/base/cordis.patch.yml` insert placed before the `compaction-basic` entry so the guardrails pre-step listener registers first; `packages/bundle/base/package.json` resolver-manifest dependency); unit tests; package READMEs (bilingual trio); catalog/graph generator registrations (SERVICE_PAGE, SERVICE_ROLES, type exemptions); a guardrails paragraph on `docs/subsystems/compaction.md`.
- Out of scope: ZCode's tool side-effect contracts, prompt `cacheHint` ordering, any UI for `pressure()`, changes to `dsh-compaction-basic` or `dsh-compaction-tool-result-pruner`, subagent/workflow-specific behavior.

## Tasks

- [x] T1: package scaffold (package.json, tsconfig, README trio, locale dir) (depends: none)
- [x] T2: config resolution + threshold math with validation tests (depends: T1)
- [x] T3: microcompact selection + durable replacement pass with tests (depends: T2)
- [x] T4: pre-step registration + `pressure()` tracking with tests (depends: T3)
- [x] T5: base-bundle wiring + lockfile + hygiene (depends: T1)
- [ ] T6: full verification pass (depends: T2–T5)

## [S4] Acceptance

- [x] With `thresholdRatio: 0.7, headroomTokens: 131072` on a 1M window with 256k reserved, the guardrails threshold (612,928) is strictly below the compaction-basic threshold (678,464).
- [x] A session above the microcompact threshold gets its stale tool results replaced by stubs; the most recent `keepRecentResults` results and every non-`tools` result stay intact.
- [x] Each replacement is preceded by a `compaction/prune` shadow-price event naming the shadowed seq and estimated tokens; `sourceEventSeqs` cites the original.
- [x] Tool pairing survives a pass (every tool call still has exactly one paired result).
- [x] A second pass over an already-microcompacted surface lands zero replacements.
- [x] Pre-step listener failures log a warning and the turn continues; the chain is never short-circuited.
- [ ] `pnpm run test` (package-scoped), `pnpm run typecheck`, and `pnpm run hygiene` pass for the change surface.
