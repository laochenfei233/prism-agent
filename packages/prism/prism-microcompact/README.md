---
description: "Model-free context compaction for Prism deployments: clearing stale tool results before summarization compaction and tracking the arming threshold."
kind: "package-reference"
---

# @prism/prism-microcompact

English | [中文](README.zh.md)

## Summary

`prism-microcompact` holds a conversation below `dsh-compaction-basic`'s summarization threshold with a model-free microcompact pass. When estimated pressure crosses its lower arming threshold, it replaces stale tool results — everything older than the most recent few — with a short stub naming the tool, so recent detail survives and summarization runs later or never. Each replacement follows the shared shadow-price protocol, and the complete originals remain in the session log for exact replay. The service also exposes the current pressure against the arming threshold for consumers that report it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package before `dsh-compaction-basic` when conversations accumulate many tool results: the cheap pass then clears stale output before summarization spends a model call condensing history.

### Smallest working composition

Mount token measurement, this package, and the backend in this order:

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@prism/prism-microcompact'
- name: '@deepseek-ai/dsh-compaction-basic'
```

With these rows, stale tool results are cleared automatically between steps. You can verify success by checking that future requests show the stubbed results; the full originals remain in the session log.

### What gets cleared

Every tool result older than the most recent `keepRecentResults` results is replaced by one text stub: `[Earlier <tool> result cleared by microcompact to free context; re-run the tool if you still need it.]`. The replacement keeps the tool call, step, errors, and metadata — only the content changes. Results already no longer than the stub are left alone, so repeated passes converge. Results with no surface pairing (no assistant tool-call block carrying their callId) are cleared under the name `unknown tool`.

### Setting the thresholds

All settings are optional. The generated [configuration catalog](../../../docs/config-catalog.md#prism-aiprism-microcompact) is the exhaustive source.

| Field | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.7` | Arm microcompact at this fraction of the routed context window. |
| `headroomTokens` | `131072` | Capacity withheld after the output reservation before the pass arms. |
| `keepRecentResults` | `4` | Most recent tool results always retained. |
| `tools` | — | Tool names eligible for clearing; omission clears every tool. |

The arming threshold is `min(thresholdRatio × contextWindow, contextWindow − reservedOutput − headroomTokens)`. The defaults land below `dsh-compaction-basic`'s arm point on the default 1M window (613k versus 678k), which is what makes the cheap pass run first; a configuration at or above compaction's arm point makes this pass unreachable. An unknown setting rejects the plugin at construction, and an unusable routed capacity warns once per target instead of failing the turn.

### When clearing runs

Clearing runs between steps, before compaction-basic's own pressure check in the pre-step chain. Below the arming threshold nothing changes, and the pass itself makes no model call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the pass; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The pass is built on three commitments:

- **Own headroom, compaction's envelope shape.** The arming threshold mirrors `dsh-compaction-basic`'s `min` formula but with the pass's own `headroomTokens`; without it, compaction's headroom would clamp every ratio into the same threshold and the pass could never arm first.
- **Replay-safe replacement.** The original event remains in the append-only log; the replacement cites it through `sourceEventSeqs`, so replay recovers the exact input that produced the stub.
- **The shadow-price protocol.** `compaction/prune` immediately precedes each replacement, pricing the exact replaced range through the injected token meter so pure consumers subtract it without per-node state.

### Clearing mechanics

One pass folds the current surface into a `callId → toolName` map from assistant tool-call blocks plus the tool-result sequence. Stale results are replaced by one newly appended `tool/result` that replaces the original node and cites it. Replacing a `tool/result` node with another `tool/result` node keeps tool pairing intact by construction, so no pairing helpers are consulted. The `tools` filter and the stub-length idempotency check skip candidates before any event is appended; a pass that clears nothing lands no events. Exact signatures are in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `PrismMicrocompact` service, pre-step listener, `microcompactIfNeeded` / `pressure` |
| [`src/config.ts`](src/config.ts) | Defaults, validation, arming-threshold math, `MicrocompactPressureConfigError` |
| [`src/microcompact.ts`](src/microcompact.ts) | Stale selection, stub content, durable replacement protocol |
| [`src/types.ts`](src/types.ts) | `PrismMicrocompactConfig`, `ResolvedConfig`, `ClearedEntry`, `MicrocompactResult`, `PressureSnapshot` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from this pass to the backend it delays and the pricing service it measures with.

- [Compaction basic backend](../../compaction/compaction-basic/README.md) — the summarization backend this pass delays.
- [Compaction seam](../../compaction/compaction/README.md) — the condensation contract whose replacement protocol the pass reuses.
- [Tool-result pruner](../../compaction/compaction-tool-result-pruner/README.md) — the size-based sibling pass that runs inside compaction.
- [Token meter](../../llm/token-meter/README.md) — the measurement service behind the arming decision.
- [Generated configuration catalog](../../../docs/config-catalog.md#prism-aiprism-microcompact) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Cleared tool result

#### What the model sees

Above the arming threshold, future requests see `[Earlier <tool> result cleared by microcompact to free context; re-run the tool if you still need it.]` in place of each stale result's content. The most recent `keepRecentResults` results keep their full text. The model does not see a second copy of the original.

#### Token effect

Clearing itself makes no model call; each cleared result frees roughly its full text price. When the remeasured pressure falls below the arming threshold, summarization compaction does not run at all, and the model keeps the recent history a summary would have condensed.

#### KV Cache effect

Replacing an earlier result invalidates reuse from the first changed token. Cleared results sit in the older history, so the recent prefix that stays identical remains eligible for reuse while the changed region is off the hot path.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the pass is a poor fit or needs special care; they are the current package constraints.

- **Age is not importance** — the pass clears by recency only; a stale result holding the only copy of a fact is cleared like any other, and the model must re-run the tool to recover it.
- **Threshold relationship is documented, not enforced** — the pass cannot read `dsh-compaction-basic`'s effective arm point, so a misconfigured deployment arms both passes at the same pressure and the pass becomes a no-op.
- **Estimated tokens, not exact** — `ctx.tokenMeter` heuristics decide arming; the provider's exact accounting can differ.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Ported from ZCode** — the two-stage pressure response (light pass first, summarization second) ports zai-org/ZCode's microcompact design; the threshold envelope was reshaped because compaction-basic's headroom clamp would otherwise make the port unreachable.
- **Per-tool recency, deferred** — ZCode groups by tool name and keeps recent results per group; this port keeps a single global recency window, which is strictly simpler and frees strictly more.

</details>
