---
feature: hachimodock-support
status: delivered
updated: 2026-11-12
branch: feat/hachimodock-support
commits: b898399b3c..2ce3993e0f
---

# HachimoDock bridge support: device status, approval relay, voice, and conversation switching

English | [中文](hachimodock-support.zh.md)

## Report

**What was built** — `plugins/prism-hachimodock` (@prism/prism-hachimodock), a TS/ESM port of the HachimoDock DSH bridge protocol v2 (upstream main `361cb0e`): a loopback HTTP/SSE server with token roles relay/bus/voice, the capability descriptor v2 written owner-only to `~/.claw-pet/prism-bridge/capability.json`, compact session summaries and the bounded event feed, the terminal `approval/request` answerer (claim-once, delegate-before-claim only), `/inject` admission streaming, and the voice endpoints with upstream's fail-closed semantics (prism ships no browser InputActions consumer; device voice runs through the OS composer adapter). On top of the port sits the new conversation-switch capability: `POST /sessions/activate` (bus token) validates a live session and fans it to same-origin web clients over `GET /api/hachimodock/activation`; the client half switches the conversation through `uiWorkspace.openSession` for listed ids, never replays, and never steals window focus. Config is a schemastery schema on the patch row (free-port default recorded in the descriptor; `approvalFallback: delegate`).

**Verification** — `tsc -p tsconfig.json --noEmit` exit 0; `tsdown` builds `lib/index.js` + `lib/client.js`; vitest 10 files / 101 tests pass, including the ported upstream suites (approval, events, security, health-sessions, inject+interrupt, voice fail-closed, windows-acl, package invariants) plus the activation and built-bundle client suites. `verify-translation-pairing` recorded the README trio. One review round (REQUEST_CHANGES: relay self-revocation was HachimoDock-side; hub keep-alive leak; banned-cast cleanups; an apply-wiring test that started the real server and wrote a real descriptor) — all fixed and re-verified from clean HEAD `2ce3993e0f`; reviewer verdict PASS-with-minors.

**Journey log** —
- The upstream port cannot drop the "legacy" voice endpoints: HachimoDock's Rust callers (`dsh_desktop.rs`, `dsh_approval.rs`) still hit `/voice/status`, `/pair/ticket`, `/approval/decision`, `/relay/close`, so the protocol surface has no subset; only the browser InputActions consumer is genuinely unused.
- `Number.isSafeInteger` does not narrow `unknown` — bind to a const with a `typeof` check; `exactOptionalPropertyTypes` also forces `prop?: T | undefined` on every optional that receives an explicit undefined.
- schemastery fields are optional-at-input without `.optional()` (which does not exist on `Schema<number>`); the gateway pattern (`z<Config>` with `.default()` per field, interface optional) types cleanly.
- Out-of-tree plugin typecheck must point `@deepseek-ai/cordis` at the BUILT `vendor/cordis/lib/types` — the tsconfig.base paths map pulls vendor source into the program and fails under plugin flags (prism-pocket's own tsc fails this way on master).
- A vitest double that "runs" recorded effects must scope which effects execute: running the bridge effect started a real server and minted real descriptor credentials at the plugin cwd.

## [S1] Problem

HachimoDock (a desktop pet terminal for AI agents, ESP32-P4 device + Tauri desktop app) adapts DeepSeek Harness through a loopback bridge plugin that its installer injects into `~/.dsh/profiles/desktop`. Prism's `~/.prism` isolation means that installer never applies here, so prism users get no device status follow, approval relay, or voice targets. Separately, upstream documents that selecting a conversation bubble on the device does not switch the DeepSeek desktop conversation; prism has the native surface (`uiWorkspace.openSession`) to make switching work.

## [S2] Design

### S2.1 New plugin `@prism/prism-hachimodock`

`plugins/prism-hachimodock` (outside the pnpm workspace, like every `plugins/*` add-on): a TS/ESM port of upstream `integrations/dsh-hachimodock` protocol v2, pinned to HachimoDock `main` `361cb0e`. It serves a loopback HTTP+SSE API with three Bearer token roles (`relay`, `bus`, `voice`) and writes the capability descriptor v2 (64-hex `epoch`, three 64-hex tokens, `http://127.0.0.1:<port>/` base URL) to `~/.claw-pet/prism-bridge/capability.json` — a dedicated directory so a DeepSeek bridge and the prism bridge can coexist. Descriptor and directory stay owner-only (POSIX 0700/0600; Windows protected DACL via the ported `windows-acl.ps1` semantics).

Served endpoints, payload shapes, and protocol strings match upstream exactly (sessions payload `version: 2`; voice protocol `hachimodock-scoped-input-v1`): `GET /health`, `GET /sessions`, `GET /events` (SSE), `GET /inject` (SSE), `POST /interrupt`, `POST /pair`, `POST /pair/ticket`, `POST /approval/decision`, `GET /voice/status`, `POST /voice/begin`, `POST /voice/draft`, `POST /voice/submit`, `POST /voice/ack`, `POST /relay/close`, plus the new `POST /sessions/activate` (S2.5). Transport bounds carry over: strict JSON objects ≤64KiB with prototype keys rejected, loopback-only bind with exact Host/peer checks, SSE via bounded subscriber queues (128KiB disconnect, 8-stream cap), approval pending ≤16 with terminal receipts ≤256, voice pending ≤64 with 120s lifetime, epoch-bound cursors with a 512-event ring, no replay of old approval/voice commands.

### S2.2 Config

Schemastery `Config` on the patch entry, fail-loud at load: `port?: number` (fixed loopback port; default binds a free port at startup and records it in the descriptor), `approvalTimeoutMs: number = 30000`, `approvalFallback: 'delegate' = 'delegate'` (the answerer delegates via `next()` only before a claim, when no authenticated USB relay is attached), `descriptorPath?: string` (tests).

### S2.3 Host wiring

`cordis.patch.yml` inserts the plugin with `inject: [webStartup]`. The plugin consumes host `sessions`, `agents`, `sessionController` (duck-typed like upstream) and answers `approval/request` waterfalls terminally only when the relay is attached. Session summaries and the event feed derive from live sessions exactly as upstream builds them.

### S2.4 Voice

The voice endpoints port with upstream's fail-closed semantics. The browser InputActions consumer stays absent — the client module registers only the activation surface (S2.5), mirroring the upstream desktop manager where device voice input runs through the OS composer adapter and `allowedOrigins` stays empty.

### S2.5 Conversation switching (new capability)

`POST /sessions/activate {sessionId}` (bus token, loopback-only) validates that the id names a live session and broadcasts `{ type: 'session-activated', sessionId, at }` over a same-origin authenticated route `GET /api/hachimodock/activation` (registered through `connection.fetch.register`; the webserver passes `text/event-stream` through uncompressed). The client half (`dsh.client.platform: web`) subscribes with an authenticated fetch-stream, drops events whose session id is absent from the client sessions list, and calls `ctx.uiWorkspace.openSession(sessionId)`. Activations are UI commands: subscribers receive only live events, no replay, and the prism window is never focused — selection changes the conversation in place.

### S2.6 Packaging and docs

`tsdown` builds `lib/index.js` + `lib/client.js` per the `plugins/*` convention (`bundle-runtime.mjs` copies the built plugin into the desktop runtime; `ensure_local_bundles` installs it and appends the bundle name). README trio plus this spec.

## [S3] Scope

- In scope: the plugin port (protocol parity with the pinned upstream revision), the prism capability descriptor, the activation push route and client module, patch wiring, tests, READMEs.
- Out of scope: HachimoDock desktop-side changes (separate feature in that repo), managed-install into prism profiles, browser voice pairing UI, ASR/LLM services, changes under `packages/*`.

## Tasks

- [x] T1: scaffold `plugins/prism-hachimodock` (package.json, cordis.patch.yml, tsdown, tsconfig, vitest) (depends: none)
- [x] T2: capability descriptor store + Windows ACL port (depends: T1) (covers: S2.1)
- [x] T3: loopback HTTP+SSE server with token auth and transport bounds (depends: T1) (covers: S2.1)
- [x] T4: bridge glue — session summaries, event feed, approval answerer, inject/interrupt, voice endpoints (depends: T3) (covers: S2.3, S2.4)
- [x] T5: activation push route + client module (depends: T3) (covers: S2.5)
- [x] T6: vitest ports of the upstream protocol tests + activation tests (depends: T2, T4, T5) (covers: S2.1–S2.5)
- [x] T7: README trio (depends: T6) (covers: S2.6)

## [S4] Acceptance

- [ ] Descriptor v2 written owner-only at the configured path; `GET /sessions` with the bus token returns a `version: 2` payload of live sessions.
- [ ] `approval/request` is answered terminally with a relay lease attached; without one the waterfall delegates via `next()`.
- [ ] `GET /inject` streams an SSE admission receipt via `sessionController.prompt` (`done/stopReason: admitted`); `POST /interrupt` calls `sessionController.cancel`.
- [ ] `POST /sessions/activate` with an unknown session id is refused; a live id reaches a connected same-origin subscriber, and the client module calls `uiWorkspace.openSession` for a listed session and ignores unknown ones.
- [ ] Auth and bounds: missing/wrong token → 401; non-loopback bind or Host → refused; >64KiB or prototype-keyed JSON → rejected.
- [ ] Ported upstream test suites (approval, events, health-sessions, inject, interrupt, security, voice, windows-acl) pass as vitest equivalents; `pnpm run typecheck` clean; plugin `build` emits `lib/`.
