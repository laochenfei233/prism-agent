---
feature: prism-pocket
status: in-progress
updated: 2026-10-29
branch: feat/prism-pocket
commits: 8c5ed274ee..pending
---

# Prism Pocket

English | [中文](prism-pocket.zh.md)

## Report

## [S1] Problem

A phone browser reaching the Prism web UI today gets a desktop layout that only degrades to a 56 px icon rail below 1024 px: the sidebar has no touch drawer, the soft keyboard covers the composer area with no `visualViewport` handling, `Enter` still sends on touch keyboards, model/permission rows wrap and overflow, and there are no safe-area insets. Remote access adds friction: the webserver binds one concrete host, the Host/Origin trust fence rejects everything else, and nothing in the product explains how to pair a phone over Tailscale. Worst of all, a phone left on the table learns nothing — when the agent requests an approval or asks a question, the page sits silent until someone looks at it.

`dsh-meow-smooth` solved this for upstream dsh by patching the desktop DOM from outside the repo, with per-release selector maintenance. Prism has the same need; this feature delivers the better-shaped fork-native version.

## [S2] Design

### S2.1 Shape: a client-side patch plugin, not a separate app and not core edits

`plugins/prism-pocket` (`@prism/prism-pocket`), a dual-face Cordis plugin following the `plugins/dsh-agent-progress` shape: node half `lib/index.js` (ESM), browser half `lib/client.js` (closure-factory artifact registered through `window.__ModuleLoader__`), `dsh.bundle.patch` + `dsh.client` manifest, `./client` export. No edits to `packages/` or `apps/`. Every adaptation anchors on surfaces the app already declares — the `[data-slot="<key>"]` wrapper (documented as the addressable seam in `packages/client/ui-renderer/src/client/scoped-slots.tsx`), `data-testid` attributes, and standard ARIA roles — and each adaptation is a capability probe that skips with a one-line console note when its anchor is absent. This is the deliberate improvement over meow-smooth: no guessed selectors, no per-release breakage.

### S2.2 Activation

Adaptations activate when the viewport is narrow and the pointer is coarse (`pointer: coarse` and `width <= 768`), or when the URL carries `?pocket=1` / `?pocket=0`; the last explicit choice is remembered in `localStorage`. Desktop appearance is untouched.

### S2.3 Mobile adaptation layer (browser half)

- Sidebar drawer: a swipe from the left edge opens the sidebar; the browser back gesture closes the drawer first (popstate guard) instead of leaving the page; the drawer is an overlay sheet with a dimmed backdrop, and selecting a session closes it.
- Soft keyboard: `visualViewport` tracking collapses the top bar while the keyboard is open; the composer keeps its dock visible; safe-area insets are respected around dock and drawer.
- Touch typing: on coarse pointers `Enter` inserts a newline (IME composition and Shift/Ctrl+Enter unaffected); if the running state exposes no stop affordance, the plugin adds one to the composer dock.
- Rows never wrap: model, permission, and context strips truncate or collapse to icons on narrow screens; tables inside messages scroll horizontally.
- No accidental zoom or rubber-band scroll; settings render full-screen on narrow viewports; after switching sessions on a narrow screen the sidebar returns to collapsed.

Visual additions (drawer, cards) reuse the app theme tokens; the one signature element is the edge-swipe drawer presented as an overlay sheet.

### S2.4 Notifications (browser half)

In-page cards on a plugin-owned portal (a `document.body` child, never patching app DOM) when the agent requests an approval, asks a user question, or a run fails; the same triggers raise a system `Notification` while the page is hidden, never while focused. Only final failures notify; transient retry states do not. Triggers subscribe to the client-side projections and Cordis client events that the shipped approval/question surfaces already consume; exact member names are pinned during T3.

### S2.5 Push delivery (node half)

When the page is closed, the node half delivers: Web Push (RFC 8291 `aes128gcm` payload encryption + RFC 8292 VAPID ES256 JWT, implemented with `node:crypto` — the npm registry is unreachable in this environment, so no push library is added) and an optional Bark webhook. Triggers: approval request, user question, turn completion (configurable, default on), and run failure. VAPID keypair generated once and stored under the DSH home `pocket/` directory (`keys.json`, mode 0600); subscriptions stored beside it (`subscriptions.json`); endpoints answering 404/410 are dropped. Routes register on the authenticated `/api` channel via `connection.fetch.register`: `GET /api/pocket/remote`, `POST /api/pocket/push/subscribe`, `POST /api/pocket/push/test`. Push payloads are structured (`kind`, `sessionId`, `sessionTitle`); the service worker composes localized text from `navigator.language`. Config fields (schemastery `Config`): `pushEnabled` (default true), `notifyTurnComplete` (default true), `barkUrl` (optional). Push and Bark fire only from the node half when at least one subscription or the webhook exists.

### S2.6 Tailscale remote access (node half + settings page)

The node half detects Tailscale (`tailscale status --json --peers=false`, Windows path `C:\Program Files\Tailscale\tailscale.exe` included) and reports self MagicDNS name and 100.x addresses. The settings section renders the server surface (bind host, port, public URL, trusted hosts from the `webStartup`-fed connection row), marks the current origin trusted (the authenticated call itself is the proof), and offers copyable commands:

- Direct IP: `prism --profile web --host <tailscale-ip>` — the fence accepts the listener bind IP without `--trusted-host`.
- MagicDNS: `tailscale serve --bg --https=443 http://127.0.0.1:3080` plus `--trusted-host <machine>.<tailnet>.ts.net` and `--public-url https://<machine>.<tailnet>.ts.net/` — TLS terminates at tailscale, the loopback transport stays HTTP, and the ts.net authority must join `trustedHosts`.

The kernel trust policy (`packages/client/connection/src/api-request-trust.ts`), the webserver wildcard rejection, and all CLI flags remain untouched; the plugin only reads them and explains them. A connection that fails the fence is a 403 from the existing code, and the page explains which command was missed.

### S2.7 PWA install

The node half registers webserver routes for static assets it owns: `/pocket.webmanifest`, `/pocket-sw.js` (root path, so the default scope is `/`), and an SVG icon. The browser half injects the manifest link, `apple-touch-icon`, and `theme-color` meta at boot. The service worker handles `push` (show a notification) and `notificationclick` (focus or open the session). iOS lacks SVG home-screen icons; shipping PNG icons is a named follow-up.

### S2.8 Locale ownership

All user-visible copy routes through `ctx.locale` with zh/en dictionaries; the service worker keeps its own minimal zh/en table (it lives outside the client context).

## [S3] Scope

- In scope: plugin skeleton (both faces, patch rows, manifest), mobile adaptation layer, in-page/system notifications, Web Push + Bark delivery, tailscale detection and the remote-access settings section, PWA assets and service worker, zh/en locale, plugin README (en/zh), unit tests for the node half and pure client logic, spec document pairing.
- Out of scope: a takeover shell or standalone mobile page, edits to `packages/`/`apps/`, attachment upload from the phone, a history compression proxy (the webserver already gzips), automatic `tailscale serve` execution or automatic trust-list mutation, QR codes, desktop (Tauri) surface changes, PNG icon generation.

## Tasks

- [ ] T1: plugin skeleton — `plugins/prism-pocket` package.json (`@prism/prism-pocket`, `dsh.bundle.patch`, `dsh.client`, `./client` export), tsdown two-face build with the hand-written closure banner/footer, `cordis.patch.yml` inserting the node row and browser roster row (covers: S2.1)
- [ ] T2: node half remote service — schemastery `Config` (S2.5 fields), tailscale detection and parsing, `GET /api/pocket/remote` over `connection.fetch.register` (covers: S2.5, S2.6)
- [ ] T3: push engine — VAPID key storage, RFC 8291 encryption + RFC 8292 JWT via `node:crypto`, subscription store with 404/410 pruning, Bark delivery, session trigger wiring (approval waterfall, user-question surface, `turn/end`), `POST /api/pocket/push/subscribe|test` (covers: S2.5)
- [ ] T4: browser-half mobile adapter — activation probe, edge-swipe drawer with popstate guard, `visualViewport` keyboard handling, `Enter`-as-newline with IME guard, no-wrap row CSS, safe-area/zoom/rubber-band rules, in-page notification portal + system notifications (covers: S2.2, S2.3, S2.4)
- [ ] T5: browser-half settings section (remote access + push status/test), PWA asset routes, manifest link injection, service worker (covers: S2.6, S2.7)
- [ ] T6: zh/en locale dictionaries, plugin README en+zh, JSDoc on exported contracts (covers: S2.8)
- [ ] T7: tests — RFC 8291 round-trip + VAPID JWT verification, tailscale JSON parsing, command generation, subscription store pruning, activation/gesture/command-copy pure logic (covers: S2.5, S2.6)
- [ ] T8: verification — build both faces, typecheck, focused tests, install into a dev web profile, phone-viewport browser check with screenshots (covers: S4)

## [S4] Acceptance

- The plugin builds both faces and a web profile boots with it loaded; the desktop appearance and behavior are unchanged with a fine pointer or a wide viewport.
- On a phone-size coarse-pointer viewport: edge swipe opens the drawer, back closes it, `Enter` inserts a newline, the composer and info rows do not overflow, and opening the keyboard collapses the top bar.
- An approval request raises an in-page card, a system notification when hidden, and a Web Push delivery to a subscribed browser; `POST /api/pocket/push/test` demonstrably delivers; a configured `barkUrl` receives the POST.
- `GET /api/pocket/remote` reports the bind surface, trusted hosts, and tailscale facts, and the settings section renders copyable commands that match the fence rules.
- `/pocket.webmanifest` and `/pocket-sw.js` are served, and a mobile browser offers installation.
- Unit tests cover the push crypto (round-trip plus JWT verification against the stored public key), tailscale parsing, command generation, and store pruning; all pass.
- Documentation: bilingual spec pair + plugin README pass `verify-md-wrap`, `verify-md-links`, and `verify-translation-pairing`.
