---
kind: upgrade-guide
description: "prism-memory now auto-saves distilled and imported claims as active, promotes pending claims on corroboration, settles contradictions by recency, and can read each turn with a model call; review-first behavior moves behind explicit configuration."
---

# prism-memory defaults flip from review-first to autopilot

English | [中文](guide.zh.md)

## Change

Through v0.2.1-rc.4, `prism-memory` parked every claim its automatic producers wrote — distilled from a turn, imported from another tool, or generated as a topic digest — as `pending`, so a person approved each one through `/memory review` or the memory page. Contradictions were only reported, and the hygiene pass (`/memory maintain`) ran only by operator command.

The shipped defaults now run the plugin on autopilot:

- A claim distilled from the person's own message writes at `autoDistillUserConfidence` (new, default `0.7`), which sits above the review floor `pendingBelowConfidence` (`0.5`), so it lands `active` and injects. A claim distilled from the assistant's account still writes at `autoDistillConfidence` (`0.4`) and stays `pending`. `autoDistillStatus` and `importStatus` now default to `active`, and topic digests follow the new `dreamDigestStatus` (default `active`), so digests participate in keyword recall.
- A `pending` claim restated at active confidence is promoted in place by the write path, and one corroborated by a second conversation is promoted by the consolidation pass (`dream`) — corroboration is the approval.
- On apply, `dream` settles contradictions by recency (new `dreamAutoResolveConflicts`, default on): the newer claim supersedes the older; `/memory restore` rolls a wrong choice back. It then runs the hygiene pass with apply (new `dreamAutoMaintain`).
- New optional model-read extraction (`llmDistill`, off in the plugin defaults, enabled in this bundle's `cordis.patch.yml`): one auxiliary model call per turn reads for claims the form matcher misses. Enabling it without a mounted llm service fails plugin load.

Everyone running prism-memory sees the new admission behavior after upgrading; no stored record is rewritten except by the passes above, and pre-existing `pending` records from imports and from the person's own message layers (`user`, `rule`) are promoted at the first load without `requireApproval`.

## Migration

1. Nothing is required to adopt the autopilot behavior.
2. To keep review-first: set `autoDistillStatus: pending`, `importStatus: pending`, and `dreamDigestStatus: pending` on the `prism-memory` row (or a later patch layer). `requireApproval: true` continues to hold everything, including the corroboration promotion and the backlog promotion.
3. To disable the model-read extraction this bundle enables, set `llmDistill: false` on the `prism-memory` row.
4. To keep contradictions human-settled, set `dreamAutoResolveConflicts: false`; to keep hygiene operator-run, set `dreamAutoMaintain: false`.
5. Confirm: `/memory status` shows `pending` only for claims that are neither the person's own words nor imported; `/memory dream apply` reports resolved contradictions and a hygiene summary.
