---
feature: prism-pocket-bots
status: designed
updated: 2026-11-03
branch: feat/pocket-bots
commits: ba06d2162f..TBD
---

# Prism Pocket Bots

English | [中文](prism-pocket-bots.zh.md)

## Report

## [S1] Problem

The Pocket settings section answers "can a phone open this" with a copyable link, but the page is spartan: three text panels, no QR code, and no way to reach the workspace from a chat app. Upstream's `@xmanrui/dsh-im` plugin (dsh-plugin.org) shows the mature shape: a remote-control surface with a QR code for the phone link and bot channels for WeChat, 飞书, 钉钉, 企业微信, QQ, Slack, Telegram, Discord, and WhatsApp, each connecting a chat bot to the workspace with streaming replies and ask-relay. Prism Pocket should look and behave at that level while staying fork-native, dependency-free at runtime, and honest about which channels can work without public callback infrastructure.

## [S2] Design

### S2.1 Shape: extend `plugins/prism-pocket`, both faces

The feature extends the existing `@prism/prism-pocket` out-of-tree plugin; no new package. The node half gains a `src/bots/` subtree (adapters, store, supervisor, session binding, ask relay) and new routes; the browser half gains a redesigned `PocketSection` with nine channel cards and a QR block. Edits stay out of `packages/` and `apps/`. One new build-time-only devDependency is added at the repository root: `qrcode-generator` (MIT, zero dependencies, single file), inlined into the client bundle by tsdown; the published plugin needs nothing beyond what the profile already provides.

### S2.2 Redesigned Pocket page (browser half)

The section follows the app's settings pages: one 720px column, a 16/24 section title with a tertiary intro, settings-material cards (`--dsw-alias-settings-card-*` tokens), 13/20 rows, weights ≤ 500, and visible `:focus-visible` rings. Four panels:

1. **手机访问** — a QR card (left) beside the verdict strip, the authenticated link with its copy action, and the missing-steps list (right). The QR encodes the tokenized phone URL and is generated locally; the token never leaves the page except inside the QR itself and the copy action. The layout collapses to one column under 560px.
2. **Bot 渠道** — nine channel cards in a responsive grid. Each card carries a brand-colored logo chip, the channel name with its region tag where one exists (飞书/Lark), a status dot with status text, an expandable credential form, and start/stop/test actions. Callback channels additionally show their public callback URL and the reachability hint.
3. **通知** — the existing push panel, restyled onto the same card material.
4. **安装到主屏幕** — the existing PWA panel, restyled.

All copy routes through the `pocket.settings` namespace; channel names are locale keys. Both themes are verified; brand color appears only on logo chips and status dots, never on text.

### S2.3 Bot channels (node half)

Nine adapters under `src/bots/adapters/`, one per channel, each exporting a `createAdapter(config, hooks)` factory returning a handle with `start()`, `stop()`, `send(chatId, text)`. IO sits in thin wrappers; every protocol transformation (frame parse/build, signature, encryption, chunking) is a pure exported function with unit tests. Adapters never import each other; shared IO helpers live in `src/bots/shared/` (`http.ts` for timeouts, `ws.ts` for reconnect-with-backoff WebSocket, `sign.ts` for WeChat-family AES and HMAC, `xml.ts` for the flat WeChat-family envelope).

| Channel | Connection | Receive | Send | Limits |
| --- | --- | --- | --- | --- |
| Telegram | long polling `getUpdates` | polling loop | `sendMessage` | 4096 chars |
| Discord | Gateway v10 WebSocket | `MESSAGE_CREATE` dispatch | REST `POST /channels/{id}/messages` | 2000 chars |
| Slack | Socket Mode WebSocket | `events_api` envelopes (acked) | `chat.postMessage` | 4000 chars |
| 飞书 / Lark | open-platform WebSocket long connection | `im.message.receive_v1` | `POST /im/v1/messages` | 4000 chars |
| 钉钉 | Stream Mode WebSocket | robot message topic | `sessionWebhook` POST | 2000 chars? — pinned at implementation |
| QQ | open-platform WebSocket gateway | `C2C_MESSAGE_CREATE` / group events | REST v2 messages | pinned at implementation |
| 企业微信 | callback URL (webserver route) | encrypted callback POST | `POST /message/send` with access token | pinned at implementation |
| 微信 | callback URL (webserver route) | encrypted callback POST (公众号/测试号) | passive encrypted reply or 客服消息 API | pinned at implementation |
| WhatsApp | callback URL (webserver route) | Cloud API webhook POST | Graph API `/{phoneNumberId}/messages` | 4096 chars |

Channel limits are pinned to the documented values of each platform at implementation time and live as per-adapter constants next to the chunker.

### S2.4 Credentials and status

Per-channel credentials and the enabled flag persist under the DSH home `pocket/bots.json` (mode 0600), written by a serialized store mirroring `push/store.ts`. Validation is strict per channel at the route (the parser/config trust level); a malformed body is a 400 with the offending field named. `GET /api/pocket/bots` returns status (`off | starting | online | error`), the error message when present, and a masked config summary — secret fields report only whether they are set, never their values. The supervisor starts enabled channels on boot, restarts on config change, applies capped exponential backoff on connection loss, and stops on disable or disposal; every transition updates the status the page polls.

### S2.5 Inbound messages → sessions

Each bot binds one session (single-chat binding for v1). The first inbound message from a bot with no binding creates a blank session via `sessionController.create({})` and stores the id. Inbound text reaches the agent as `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'pocket-bot' } })` through `agent.followup(...)` followed by `sessions.flush(...)`, delivered inside `agents.withoutInitiator(...)` — the schedule delivery pattern. The `'pocket-bot'` member is declared in `MessageSourceMap`, so the message rides the session log like every model-visible input. Commands: `/new` rebinds to a fresh blank session, `/stop` aborts the running turn when the session exposes an abort affordance, `/help` lists the commands; all other text forwards. When the bound session no longer resolves, the binding resets and the next message creates a new session.

### S2.6 Replies

The node half observes `session/event`; for `assistant/message` events whose session is bound to a bot chat, the message's text content is queued per chat and delivered through the adapter with per-channel chunking. Each assistant message of a multi-step turn is sent as it completes; per-token streaming is out of scope. Delivery failures are logged, never thrown into the loop, and never prune the binding.

### S2.7 Ask relay (approvals and user questions)

While a bot chat's bound session has a pending approval or user question, the relay renders it in the chat — the tool name for approvals, the question text with numbered options for questions — and holds the answerer chain open for a bounded window (120s). The matching chat's next reply resolves the pending ask: `1`/`y` maps to the first (approve/accept) option and `2`/`n` to the rejection option for approvals; for questions the number maps to the options the request carries. Timeout or an off-ramp reply delegates through `next()`, so the ask falls back to the host's own surfaces; only one ask is pending per session at any time, and later asks during a pending window delegate immediately. The relay observes only; it never claims a request when the chat is not bound to that session.

### S2.8 Callback channels

The three callback channels register unauthenticated webserver routes (`/pocket/bots/<channel>/callback`, GET for verification handshakes, POST for deliveries) — the PWA asset path. Each request is authenticated by its platform's scheme before any processing: WeChat and 企业微信 by the signature SHA-1 of (token, timestamp, nonce) and the encodingAESKey envelope decrypt with timestamp-freshness check; WhatsApp by the `X-Hub-Signature-256` HMAC over the raw body and the verify-token echo. The page shows each callback channel's public URL and the reachability hint (Tailscale Funnel or an existing reverse proxy); the plugin never mutates proxy state itself. A callback route with no stored credential answers 404.

### S2.9 Routes

On the authenticated `/api` channel: `GET /api/pocket/bots`, `PUT /api/pocket/bots/:channel` (config + enabled), `POST /api/pocket/bots/:channel/start|stop|test`. `test` performs the channel's cheapest credential probe (`getMe`, `/gateway/bot`, `apps.connections.open`, tenant token, stream-ticket open, gateway ticket, callback echo when applicable) and reports the outcome without sending a chat message. Misconfiguration fails loud: starting a channel with an incomplete config is a 400, not a silent skip.

### S2.10 Locale ownership

All page copy routes through `ctx.locale` with zh/en dictionaries; the nine channel names, their region tags, and every status/field label are locale keys. The service worker is untouched.

## [S3] Scope

- In scope: the redesigned Pocket page (QR, nine channel cards, push, PWA), nine channel adapters with their protocol unit tests, credential store and supervisor, session binding with commands, reply delivery with chunking, ask relay, the authenticated bot routes, the three callback routes, root devDependency `qrcode-generator`, zh/en locale, README pairing, spec pairing.
- Out of scope: per-token streaming cards, media and file round-trip, QR-scan app creation for 飞书/企业微信 (credential fields only), group or multi-robot management, automatic proxy mutation, edits to `packages/`/`apps/`, harness-connector-style cloud relay, desktop (Tauri) surface changes.

## Tasks

- [ ] T1: bots foundation — `types.ts` channel/config/status discriminated unions, `bots.json` store (0600, serialized writes), supervisor lifecycle (boot start, config-change restart, capped backoff, disposal) (covers: S2.3, S2.4)
- [ ] T2: outbound adapters — telegram, discord, slack, feishu/lark, dingtalk, qq with pure protocol functions and thin IO (covers: S2.3)
- [ ] T3: callback adapters — wechat, wecom, whatsapp: signature/encrypt pure functions, webserver callback routes, send APIs (covers: S2.3, S2.8)
- [ ] T4: session binding, inbound commands, reply outbox with chunking, ask relay for approvals and questions (covers: S2.5, S2.6, S2.7)
- [ ] T5: authenticated routes (list/config/start/stop/test) with strict per-channel validation and masked reads (covers: S2.4, S2.9)
- [ ] T6: client redesign — 720px settings page, QR panel via inlined `qrcode-generator`, nine channel cards with forms and actions, push and PWA panels restyled, responsive collapse, focus rings, zh/en dictionaries (covers: S2.2, S2.3, S2.10)
- [ ] T7: tests — store persistence and permissions, supervisor transitions, every adapter's protocol logic (frames, signatures, AES round-trip, chunking), ask relay resolution and timeout, binding commands, client pure logic (covers: S2.3–S2.7)
- [ ] T8: verification — tsc, vitest, tsdown both faces, live web-profile boot with the bots routes and the redesigned page in a phone-viewport browser (covers: S4)
- [ ] T9: docs — README en+zh, spec en+zh pairing with recorded hashes, changelog note (covers: S2.10)

## [S4] Acceptance

- The plugin typechecks and all tests pass; both faces build; a web profile boots with the plugin and serves the bot routes.
- The redesigned page renders the four panels on the settings material, collapses to one column on a narrow viewport, shows a scannable QR encoding the tokenized phone URL, and carries no hardcoded copy.
- Each of the nine channels can be configured through its card; saving validates strictly, start/stop transitions reflect in status, and `test` reports a real probe outcome.
- An inbound message from a connected channel reaches the bound session and the assistant's reply is delivered back to the chat, chunked to the channel's limit.
- A pending approval or user question on a bound session renders in the chat; a numbered reply resolves it, and a 120s silence delegates through `next()`.
- WeChat, 企业微信, and WhatsApp callback routes verify signatures, decrypt envelopes, and answer their platform handshakes; without a stored credential they answer 404.
- Credentials persist under `pocket/bots.json` with mode 0600 and never appear in any route response.
- Documentation: README and spec pass `verify-md-wrap`, `verify-md-links`, and `verify-translation-pairing`.
