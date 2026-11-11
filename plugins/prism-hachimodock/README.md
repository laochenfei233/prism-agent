# @prism/prism-hachimodock

English | [中文](README.zh.md)

HachimoDock bridge for Prism: the desktop pet terminal follows prism sessions, answers approval prompts from the device, targets voice input, and switches the conversation the device picks.

A patch plugin, ported from HachimoDock's `integrations/dsh-hachimodock` protocol v2 (HachimoDock main `361cb0e`). One loopback HTTP/SSE channel the HachimoDock desktop app talks to; no changes to the web app itself.

## Features

- **Session status follow**: compact summaries (`GET /sessions`) and the compact event stream (`GET /events`) — turn boundaries, tool call/result pairs, title updates, and approval audit edges. Transcript content never leaves the host.
- **Approval relay**: one terminal `approval/request` answerer. A claimed request is owned by the exact relay lease (epoch + connection + session); timeout, abort, or disconnect fails closed. With `approvalFallback: delegate` a request with no attached relay delegates to the resident approval UI.
- **Voice targets**: `/voice/status` reports the scoped-input contract (`hachimodock-scoped-input-v1`) and refuses to guess an editor. The browser InputActions consumer is intentionally absent — device voice input for prism goes through the HachimoDock OS composer adapter, and `allowedOrigins` stays empty.
- **Conversation switching** (prism addition): `POST /sessions/activate` (bus token) validates a live session and fans it to same-origin web clients over the authenticated `GET /api/hachimodock/activation` stream; the client half calls `uiWorkspace.openSession` for a listed session and ignores unknown ids. Live events only, no replay, no window focus change.
- **Capability descriptor v2**: the bridge mints the epoch and three token roles (`relay`, `bus`, `voice`) and writes them owner-only (POSIX 0700/0600; Windows protected DACL through the byte-identical `windows-acl.ps1`) to `~/.claw-pet/prism-bridge/capability.json` — a dedicated directory, so a DeepSeek bridge and this bridge can coexist. The descriptor is the only credential channel; it never appears in URLs, logs, or application resources.

## Install

The desktop runtime copies `plugins/*` into the profile and appends the bundle name (`bundle-runtime.mjs` + `ensure_local_bundles`); no manual wiring is needed on a prism desktop install. Build the plugin before packaging or pointing a dev profile at it:

```sh
pnpm exec tsdown --config tsdown.config.ts
```

The HachimoDock desktop app discovers the bridge by reading the capability descriptor; no managed install into prism profiles exists or is needed.

## Configuration (cordis.patch.yml)

- `port` — fixed loopback port; the default binds a free port at startup and records it in the descriptor.
- `approvalTimeoutMs` — approval wait before failing closed (default 30000; `99999` is the never sentinel).
- `approvalFallback` — `'delegate'` (default) hands an unanswerable request to the next answerer; `'unavailable'` fails closed.
- `injectTimeoutMs` — prompt admission deadline before `inject-timeout` (default 600000).
- `allowedOrigins` — exact browser Origins allowed to pair; empty disables browser voice.
- `descriptorPath` — capability descriptor override (tests).

## Notes and limits

- Transport bounds carry over from the upstream contract: strict JSON objects ≤64KiB with prototype keys rejected, loopback-only bind with exact Host checks, bounded SSE queues and replay rings, epoch-bound cursors, and no replay of old approval or voice commands.
- The wire contract is pinned to upstream main `361cb0e`; endpoints, payload shapes, and protocol strings (`version: 2`, `hachimodock-scoped-input-v1`, `live-session-seq-turn-call-v1`) match byte-for-byte, minus the legacy browser InputActions consumer prism does not ship.
