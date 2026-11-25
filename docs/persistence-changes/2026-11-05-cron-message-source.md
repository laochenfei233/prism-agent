---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-cron-message-source

English | [中文](2026-11-05-cron-message-source.zh.md)

## Summary

Cron job deliveries carry their own message-source variant, so a reader can tell a scheduled delivery from a human turn or a Schedule reminder.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-cron-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "d3dcdc21130c63631548151bc26929a3f05a7ca29cc957f1eea8da1cfe2d0868"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "1e42757fe16ef9e2dd45ec328710e337ec8d6c4791304a048d2c9a374e8c4755"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "04229f2fff9e243d02092dc26aa27924a4f126f66b5f90cfdd8374f9c7f76090"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "3e61772c5b1261ba3e69f5ee569feccb13f5d90aa70fbdbf24869a3ac140d0c9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

MessageSourceMap stays merge-extensible through declaration merging, and persisted readers never exhaustively switch on source kinds: the transcript projections fall through a documented default that keeps an unknown producer visible by its durable kind (packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts, packages/client/ui-trajectory trajectory projection). An older reader replaying a log that carries source kind "cron" therefore renders the row instead of failing, and a new reader replays older logs unchanged because the variant is simply absent. The session/title-llm-request messages union grows only because a cron-sourced user message can join the request; consumers forward message content regardless of producer kind.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/client/ui-chat/tests/event-projection.client.spec.ts packages/client/ui-chat/tests/chat-node-source.client.spec.ts — 12 tests passed, including the plugin-producer case that exercises the documented default branch.

<a id="dev-note"></a>
## Dev Note

None.
