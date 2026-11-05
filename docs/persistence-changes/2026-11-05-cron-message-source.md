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
    previous: "2026-10-13-user-rpc-principal"
    after: "c797fcc92780db18c44fcbe603fe44a7051be5310785f27d6b676a5af4d948d0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "d88688defdf08b52170dc7f4faa3a35b70136cdbe7a32000c69f1472a597a8fc"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "cc80152216ab3bd33412da06d59f9308c535833a90584897d8f9fd1fb873c8b1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "1dc3688420349ac567e54fd0967420ffaf57960fdf189d46f3305f5002006f80"
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
