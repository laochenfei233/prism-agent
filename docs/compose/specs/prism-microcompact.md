---
feature: prism-microcompact
status: in-progress
updated: 2026-11-21
branch: feat/prism-guardrails
commits: df1583090a..07b09556bf
---

# Prism Microcompact: salvage of the stale tool-result pass

English | [中文](prism-microcompact.zh.md)

## Report

**What was built** — the branch delivered a host-only plugin that ports zai-org/ZCode's microcompact stage. An `agent/pre-step` listener measures the routed conversation and, above its own arming threshold, replaces stale tool results with one stub naming the tool. The defaults (`thresholdRatio: 0.7`, `headroomTokens: 131072`, `keepRecentResults: 4`) arm at 612,928 estimated tokens on a 1M window with 256k reserved, below `dsh-compaction-basic`'s 678,464, so the model-free pass runs before summarization. Each replacement follows the pruner's durable shadow-price protocol (`compaction/prune` plus a same-kind `tool/result` citing the original), and `pressure()` reports the routed measurement against the threshold.

**Why renamed** — the tree already carries `plugins/prism-guardrails`, an out-of-tree capability-hardening bundle with twelve enforcement rails, a Ponytail mode, and `/guardrails` commands. The branch's package lived at `packages/prism/prism-guardrails` as `@prism-ai/prism-guardrails`; the two products shared a name while doing unrelated work. The branch plugin never refuses a call, never registers a command, and never touches a tool decision: it only rewrites conversation history to delay compaction. It is now `@prism-ai/prism-microcompact` at `packages/prism/prism-microcompact`, with the service renamed to `ctx.microcompact`.

**Why this is a salvage, not a merge** — the branch sits on `df1583090a` (2026-11-08), before the current tree's `0.2.2-rc.1` resync and before fork plugins settled in `plugins/`. Rebasing it would collide with the capability bundle's identity, the newer packaging convention, and the generated catalogs. The branch remains the reference implementation; the port copies this behavior and its tests into the current tree rather than replaying the old commits.

**Verification** — the renamed package's focused suite, typecheck, and the generated-catalog freshness checks are run for this change. Recorded-session coverage for the model-visible stub is still open: the default arm point is unreachable in the recorded fixtures, and per-scenario threshold overrides need snapshot-harness support the branch did not build.

**Journey log** — the original threshold could not copy `dsh-compaction-basic`'s formula: its headroom clamp collapses every ratio below 0.8 into the same arm point, so the pass needs its own `headroomTokens` to be reachable at all. Tool names come from assistant tool-call blocks, not `tool/call` events, because the latter are log-only and not surface nodes. The optional-array config keeps the sibling convention (`tools?: string[]`, no `readonly`) instead of a banned `as unknown` default.

## [S1] Problem

Two different products answer to "prism guardrails" in the same tree. `plugins/prism-guardrails` is an enforcement bundle: it decides whether a tool call may run, sends repeated calls to approval, enforces budgets and turn boundaries, and ships Ponytail. The branch package is a compaction optimization: it makes the conversation cheaper by removing stale tool output before summarization. A deployment, a catalog reader, or a maintainer searching the name cannot tell which one a row, anchor, or log line means.

The collision is not only editorial. The branch's service was `ctx.guardrails`, its class and config types carried `Guardrails`, its error prefix was `prism-guardrails:`, and its bundle row id was `prism-guardrails`. Those names now read as the enforcement bundle. The rename gives the compaction pass its own vocabulary before any port work begins.

## [S2] Design

### S2.1 Rename map

| Old identity | New identity |
|---|---|
| package `@prism-ai/prism-guardrails` | `@prism-ai/prism-microcompact` |
| directory `packages/prism/prism-guardrails` | `packages/prism/prism-microcompact` |
| service `ctx.guardrails` | `ctx.microcompact` |
| class `PrismGuardrails` | `PrismMicrocompact` |
| config `PrismGuardrailsConfig` | `PrismMicrocompactConfig` |
| error `GuardrailPressureConfigError` | `MicrocompactPressureConfigError` |
| local agent surface `GuardrailAgent` | `MicrocompactAgent` |
| bundle row id `prism-guardrails` | `prism-microcompact` |
| spec, README, test, locale, catalog keys | `prism-microcompact` |

Two plugins share part of the name, and only one is in scope here:

| | Capability bundle | Microcompact pass |
|---|---|---|
| Home | `plugins/prism-guardrails` | `packages/prism/prism-microcompact` |
| Package | `prism-guardrails` (private) | `@prism-ai/prism-microcompact` |
| Owns | enforcement rails, Ponytail, `/guardrails` | stale tool-result clearing, `pressure()` |
| This salvage | untouched | renamed and documented here |

The port must not edit `plugins/prism-guardrails`, its `cordis.patch.yml`, its tests, its `guardrails-hardening` spec, or its `/guardrails` command. The two plugins can be loaded together; they share only `agent/pre-step`. The rename only covers the compaction pass and the wiring that mounts it.

### S2.2 Behavior

The behavior is unchanged. The service keeps `static inject = ['llm', 'tokenMeter']` and one `agent/pre-step` waterfall listener. The listener skips on an aborted signal, runs `microcompactIfNeeded`, logs one `info` per landed pass, logs one `warn` per failed pass and continues the turn, and always returns `next()`. The threshold remains `floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`. Stale selection remains every result older than the most recent `keepRecentResults`, filtered by `tools`. The replacement keeps the pruner's shadow-price event and `sourceEventSeqs` citation. `pressure()` returns `{ totalTokens, contextWindow, thresholdTokens, willMicrocompact }` or `null`.

### S2.3 Relationship to the two neighbors

`plugins/prism-guardrails` and this pass share only the `agent/pre-step` extension point. The bundle decides budgets, continuations, and enforcement; this pass rewrites history. Ordering between them is not significant, and neither should depend on the other.

`dsh-compaction-tool-result-pruner` is the closer neighbor. The pruner runs inside `dsh-compaction-basic` after its higher pressure threshold and rewrites oversized current results; this pass arms earlier and clears all stale results, not only oversized ones. They are complementary; a deployment can load both. The pass must register before `dsh-compaction-basic` so its lower threshold is reachable.

### S2.4 Salvage port

The port targets the current tree's packaging. The working name is `plugins/prism-microcompact`, a private unscoped package like `plugins/prism-guardrails`; if the fork keeps first-party public packages under `packages/prism`, the same package can stay there. The port decides the final scope and layout, then updates the bundle patch, tsconfig path, config catalog, Cordis API catalog, capability-seams graph, event matrix, composition graph, and plugin-package reference.

The source adaptation is small: `compaction/prune`, `session.eventAt`, `deriveEventMessage`, and `tokenMeter` still exist on the current tree. `session.eventAt` is deprecated, so the port replaces it with the current accessor. The port re-runs the 21-test suite, then adds the recorded-session case for the model-visible stub. A snapshot fixture that reaches the lower arm point, or a threshold override in the snapshot harness, is required; until then the model-visible change has no recorded coverage.

The port adds an upgrade-guide entry if it introduces a deployment-visible plugin row or config field. The rename on this branch does not need one: the package was never released and no profile mounted the old name.

### S2.5 Open decisions

- **Layout and scope** — `plugins/prism-microcompact` (private, unscoped) matches the current fork packaging; `packages/prism/prism-microcompact` preserves the branch's first-party shape. The behavior is identical.
- **Service name** — `ctx.microcompact` is the new name; a longer `ctx.contextMicrocompact` is not justified by a second context service.
- **Fold into the pruner?** — No. The pruner runs inside `dsh-compaction-basic` at its threshold and selects by size; this pass runs beside it at a lower threshold and selects by age. Folding them would hide two independent policies behind one config surface.

## [S3] Scope

- In scope for this change: the rename on the branch; bundle, tsconfig, lockfile, generator, catalog, graph, and documentation wiring; the rewritten spec and READMEs.
- Follow-up for the salvage: port to the current tree, add recorded-session coverage, choose the final layout, and re-run the gates on the port.
- Out of scope: changing `plugins/prism-guardrails`, `dsh-compaction-basic`, or `dsh-compaction-tool-result-pruner`; adding UI or commands to the pass; merging the branch as history.

## Tasks

- [x] T1: rename the package, directory, service, class, config, error, test, spec, README, and locale (depends: none)
- [x] T2: update the bundle row, tsconfig paths, lockfile, generator inputs, and generated catalogs (depends: T1)
- [x] T3: rewrite the spec and README pair and re-record translation pairing (depends: T1)
- [ ] T4: port the source and tests to the current tree under the chosen layout (depends: T2)
- [ ] T5: add the recorded-session case for the model-visible stub (depends: T4)
- [ ] T6: re-run typecheck, build, and documentation gates on the port (depends: T4, T5)

## [S4] Acceptance

- [x] Live wiring in this tree uses `prism-microcompact` and `ctx.microcompact`; no live reference to `@prism-ai/prism-guardrails` remains outside this document's history.
- [x] `plugins/prism-guardrails`, its commands, its spec, and its changelog are unchanged.
- [x] The renamed package's focused tests and typecheck pass, and the generated catalogs are fresh.
- [ ] A recorded-session case covers the model-visible stub replacement (follow-up).
- [ ] The port lands on the current tree under the chosen layout and re-runs the gates (follow-up).
