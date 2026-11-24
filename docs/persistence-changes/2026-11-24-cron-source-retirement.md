---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-24-cron-source-retirement

English | [中文](2026-11-24-cron-source-retirement.zh.md)

## Summary

Retiring the Cron scheduling packages removes one `MessageSource` variant, `{ kind: "cron", jobId }`, so the four Session event roots that carry user-role message attribution change digest. Committed Sessions that recorded a Cron delivery keep that attribution and stay readable; no other persisted type changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-24-cron-source-retirement
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-cron-message-source"
    after: "02e873a375eab467d83c4b26cc303a15bdf09dd15cbe8eb5dcffff6bccbb8715"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-cron-message-source"
    after: "485185a7f0b054d26ed1a617eb0ed65e12ea8e931949779270bbf0d630084130"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-cron-message-source"
    after: "431f7d2823dfc50f714ff5bddb8ee15f8db63505a151f59060ab796af0870ce0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-cron-message-source"
    after: "89fa7972288b9fdee82649ab02260e52af977b22d03225e1c6a4aa9093aabe09"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers keep historical meaning. A committed V4 row is admitted by the shape of its `source`, not by a closed list of kinds: [message-sources.ts](../../packages/session/session-format-v3-to-v4/src/message-sources.ts) requires a non-empty producer-owned `kind` string and refuses only the retired `plugin` wrapper, and [message.ts](../../packages/llm/llm/src/message.ts) documents `MessageSource` as merge-extensible, where "consumers fall through unknown kinds". A recorded `{ kind: "cron", jobId }` therefore survives admission and rendering exactly as any other unrecognized attribution does: source attribution is descriptive metadata, not a dispatch key, and the removal adds no required field and changes no existing one.

Older readers keep the same behavior, because absence is not new data: a reader that still declares the `cron` variant simply never encounters it in records written after this change, and every other source kind it knows keeps its meaning. No migration, reindex, or truncation is required, so the Session header version stays unchanged.

The durable consequences named by this acknowledgement are limited to attribution. The `cron` storage domain itself is not a Session format; its records stay on disk untouched and unread, as the [upgrade guide](../upgrade-guide/v0.2.2-rc.1/cron-removal/guide.md) states.

<a id="verification"></a>
## Verification

`pnpm run gen-persistence-catalog` rewrote the catalog, the Chinese pair, and `docs/persistence-schema.json`; the four root digests above are that output. Diffing `docs/persistence-schema.json` against the committed inventory showed exactly those four roots changed, no root added, and no root removed.

`pnpm --silent run verify-persistence-changes` cannot complete in this checkout: the committed companion `docs/persistence-changes/2026-11-05-cron-message-source.schema.json` carries no `nodes` table, so the history loader fails before reaching this record. That defect predates this change; once that record's snapshot is restored, this acknowledgement covers every root the current source changes.

<a id="dev-note"></a>
## Dev Note

None.
