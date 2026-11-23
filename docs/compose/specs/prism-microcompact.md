---
feature: prism-microcompact
status: delivered
updated: 2026-11-24
branch: feat/prism-microcompact
commits: f9433f3732..1317226412
---

# Prism Microcompact: salvage of the stale tool-result pass

English | [中文](prism-microcompact.zh.md)

## Report

**What was built** — the branch delivered a host-only plugin that ports zai-org/ZCode's microcompact stage. An `agent/pre-step` listener measures the routed conversation and, above its own arming threshold, replaces stale tool results with one stub naming the tool. The defaults (`thresholdRatio: 0.7`, `headroomTokens: 131072`, `keepRecentResults: 4`) arm at 612,928 estimated tokens on a 1M window with 256k reserved, below `dsh-compaction-basic`'s 678,464, so the model-free pass runs before summarization. Each replacement follows the pruner's durable shadow-price protocol (`compaction/prune` plus a same-kind `tool/result` citing the original), and `pressure()` reports the routed measurement against the threshold. The port landed the pass at `packages/prism/prism-microcompact` as `@prism/prism-microcompact`, mounted by the base bundle between `token-meter` and `compaction-basic`, and added the recorded-session scenario `snapshots/session/microcompact-stub`, whose replay carries the shadow price, the model-visible stub, and the follow-up request header.

**Why renamed** — the tree already carries `plugins/prism-guardrails`, an out-of-tree capability-hardening bundle with twelve enforcement rails, a Ponytail mode, and `/guardrails` commands. The branch's package lived at `packages/prism/prism-guardrails` as `@prism-ai/prism-guardrails`; the two products shared a name while doing unrelated work. The branch plugin never refuses a call, never registers a command, and never touches a tool decision: it only rewrites conversation history to delay compaction. It is now `@prism/prism-microcompact` at `packages/prism/prism-microcompact`, with the service renamed to `ctx.microcompact`.

**Why this is a salvage, not a merge** — the branch sits on `df1583090a` (2026-11-08), before the current tree's `0.2.2-rc.1` resync and before fork plugins settled in `plugins/`. Rebasing it would collide with the capability bundle's identity, the newer packaging convention, and the generated catalogs. The branch remains the reference implementation; the port copies this behavior and its tests into the current tree rather than replaying the old commits.

**Verification** — the ported package's focused suite passes 22/22 (including the new empty-`tools` normalization case) with a clean `tsc -b`; the root typecheck passes all 5 gates after updating the test's `agent/pre-step` payload for the current tree's `modelSelection` field; `build:check` passes 2/2 against the rebuilt artifacts; the generators and their freshness gates (config catalog, Cordis catalog and API catalog, inspect catalog, doc graphs, plugin packages, tsconfig paths, product use) all pass; and the recorded-session corpus invariants pass 3/3 with the new scenario correctly skipping on Windows (`platform: posix`). Pre-existing failures unrelated to this change, reproduced on the base tree: the repo-wide oxlint run, several `doc-sync` gates (translation pairing's `tool-catalog` heading imbalance and `ui-conversation` drift, `speech-to-text-http` JSDoc, CLI help, type equivalence, markdown links, documentation build, session-format references, README summaries), and the Windows snapshot lane's ungated posix scenarios. This change's files appear in none of those failures.

**Journey log** — the original threshold could not copy `dsh-compaction-basic`'s formula: its headroom clamp collapses every ratio below 0.8 into the same arm point, so the pass needs its own `headroomTokens` to be reachable at all. Tool names come from assistant tool-call blocks, not `tool/call` events, because the latter are log-only and not surface nodes. The optional-array config keeps the sibling convention (`tools?: string[]`, no `readonly`) instead of a banned `as unknown` default. The `plugins/` layout was rejected during the port on ordering grounds: a bundle layer composes after the profile's own bundles, so a layer-mounted pre-step listener registers after `dsh-compaction-basic`'s and the cheaper pass can never arm first. Schemastery turns an omitted array config field into `[]`; `resolveConfig` normalizes that empty list back to the documented omission, or the tools filter silently clears nothing. The recorded fixture was converged on Windows by driving the real harness in refresh mode with the scenario temporarily flagged `platform: pwsh`, then hand-normalizing the cwd separators and restoring `platform: posix` for the required posix lane.

## [S1] Problem

Two different products answer to "prism guardrails" in the same tree. `plugins/prism-guardrails` is an enforcement bundle: it decides whether a tool call may run, sends repeated calls to approval, enforces budgets and turn boundaries, and ships Ponytail. The branch package is a compaction optimization: it makes the conversation cheaper by removing stale tool output before summarization. A deployment, a catalog reader, or a maintainer searching the name cannot tell which one a row, anchor, or log line means.

The collision is not only editorial. The branch's service was `ctx.guardrails`, its class and config types carried `Guardrails`, its error prefix was `prism-guardrails:`, and its bundle row id was `prism-guardrails`. Those names now read as the enforcement bundle. The rename gives the compaction pass its own vocabulary before any port work begins.

## [S2] Design

### S2.1 Rename map

| Old identity | New identity |
|---|---|
| package `@prism-ai/prism-guardrails` | `@prism/prism-microcompact` |
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
| Package | `prism-guardrails` (private) | `@prism/prism-microcompact` |
| Owns | enforcement rails, Ponytail, `/guardrails` | stale tool-result clearing, `pressure()` |
| This salvage | untouched | renamed and documented here |

The port must not edit `plugins/prism-guardrails`, its `cordis.patch.yml`, its tests, its `guardrails-hardening` spec, or its `/guardrails` command. The two plugins can be loaded together; they share only `agent/pre-step`. The rename only covers the compaction pass and the wiring that mounts it.

### S2.2 Behavior

The behavior is unchanged. The service keeps `static inject = ['llm', 'tokenMeter']` and one `agent/pre-step` waterfall listener. The listener skips on an aborted signal, runs `microcompactIfNeeded`, logs one `info` per landed pass, logs one `warn` per failed pass and continues the turn, and always returns `next()`. The threshold remains `floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`. Stale selection remains every result older than the most recent `keepRecentResults`, filtered by `tools`. The replacement keeps the pruner's shadow-price event and `sourceEventSeqs` citation. `pressure()` returns `{ totalTokens, contextWindow, thresholdTokens, willMicrocompact }` or `null`.

### S2.3 Relationship to the two neighbors

`plugins/prism-guardrails` and this pass share only the `agent/pre-step` extension point. The bundle decides budgets, continuations, and enforcement; this pass rewrites history. Ordering between them is not significant, and neither should depend on the other.

`dsh-compaction-tool-result-pruner` is the closer neighbor. The pruner runs inside `dsh-compaction-basic` after its higher pressure threshold and rewrites oversized current results; this pass arms earlier and clears all stale results, not only oversized ones. They are complementary; a deployment can load both. The pass must register before `dsh-compaction-basic` so its lower threshold is reachable.

### S2.4 Salvage port

The port targets the current tree's packaging. The working name was `plugins/prism-microcompact`, a private unscoped package like `plugins/prism-guardrails`; the port instead keeps the first-party shape at `packages/prism/prism-microcompact` as `@prism/prism-microcompact`. A `plugins/` bundle layer composes after the profile's own bundles, so its pre-step listener would register after `dsh-compaction-basic`'s and the lower arming threshold would never be reachable; the base bundle mounts the pass between `token-meter` and `compaction-basic`, which preserves the required order in every profile that loads the base bundle. The port updated the bundle patch, bundle dependencies, tsconfig alias and host reference, the config catalog, the Cordis catalogs, the capability-seams graph, the event matrix, the composition graph, and the plugin-package reference.

The source adaptation is small: `compaction/prune`, `session.eventAt`, `deriveEventMessage`, and `tokenMeter` still exist on the current tree. `session.eventAt` is deprecated for new production calls and no non-deprecated synchronous per-sequence accessor exists; the port keeps the read under the sanctioned line-scoped `typescript/no-deprecated` waiver — the same deferred-migration form the sibling `dsh-compaction-tool-result-pruner` uses. The port re-ran the test suite (22 tests) and added the recorded-session case for the model-visible stub: `snapshots/session/microcompact-stub` mounts the pass with thresholds calibrated above the mounted tool catalog's heuristic price, and the replayed session carries the `compaction/prune` shadow price, the stub replacement, and the follow-up request header that shows the stub to the model.

The port adds an upgrade-guide entry if it introduces a deployment-visible plugin row or config field. The rename on this branch does not need one: the package was never released and no profile mounted the old name.

### S2.5 Open decisions

- **Layout and scope** — decided: `packages/prism/prism-microcompact` as `@prism/prism-microcompact`. The `plugins/` shape was rejected during the port: a bundle layer composes after the profile's own bundles, so its listener would register after `dsh-compaction-basic`'s and the lower arming threshold would be unreachable. Only a workspace package mounted by the base bundle's own patch achieves the required order.
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
- [x] T4: port the source and tests to the current tree under the chosen layout (depends: T2)
- [x] T5: add the recorded-session case for the model-visible stub (depends: T4)
- [x] T6: re-run typecheck, build, and documentation gates on the port (depends: T4, T5)

## [S4] Acceptance

- [x] Live wiring in this tree uses `prism-microcompact` and `ctx.microcompact`; no live reference to `@prism-ai/prism-guardrails` remains outside this document's history.
- [x] `plugins/prism-guardrails`, its commands, its spec, and its changelog are unchanged.
- [x] The renamed package's focused tests and typecheck pass, and the generated catalogs are fresh.
- [x] A recorded-session case covers the model-visible stub replacement (`snapshots/session/microcompact-stub`; replayed green on the Windows convergence run, posix replay rides the required snapshot lane).
- [x] The port lands on the current tree under the chosen layout and re-runs the gates.
