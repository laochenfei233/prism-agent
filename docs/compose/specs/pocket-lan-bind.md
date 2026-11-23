---
feature: pocket-lan-bind
status: designed
updated: 2026-11-24
branch: feat/pocket-lan-bind (worktree .worktrees/pocket-lan-bind)
commits: 26b7c472a5..
---

# Pocket LAN Bind Action

English | [中文](pocket-lan-bind.zh.md)

## Report

## [S1] Problem

The Pocket settings page reports the LAN blocker ("服务只监听本机：需要绑定到局域网地址再启动") whenever the hub's webserver did not bind the machine's LAN address. The only remedy the page offers is a CLI command (`prism web --host <lan> --port <port>`), which a desktop user cannot act on without leaving the app, and a desktop shell that predates the `--bind-lan` spawn argument stays loopback-bound across relaunches. The page should be able to open the LAN listener itself.

## [S2] Design

**S2.1 — Runtime bind on the webserver service.** `WebServer` gains `bindAdditionalHost(host: string): Promise<void>`: it validates one concrete, non-wildcard IP literal that the service has not already bound, builds a listener with the same request, upgrade, and TLS wiring activation uses, listens on the configured port, and records the address in the service's bound set — so `hosts` (the authority list the `/api` trust fence reads) and disposal include it. A listen failure throws with the OS reason; existing listeners keep serving.

**S2.2 — Pocket bind route.** `POST /api/pocket/lan/bind` detects the machine's preferred LAN IPv4 (the existing `detectLanAddress` probe), binds it through S2.1 — idempotent when already bound — and answers the same status body as `GET /api/pocket/remote`. A missing LAN address answers `400 { error }`; a failed listen answers `500 { error }`.

**S2.3 — Live surface.** The status body's server surface reads the webserver service's live `host`/`port`/`hosts` instead of the frozen startup flags, so a runtime bind appears in `additionalHosts` and clears the LAN blocker without a restart. `publicUrl` and `trustedHosts` still come from the startup flags.

**S2.4 — Page action.** When the chosen transport is LAN and the phone blocker is `not-bound` or `loopback`, the settings page shows a primary "bind now" button beside the steps. Success re-renders the status (the QR code and link appear); failure shows the error note. The copyable CLI step stays as the fallback text, with its stale "the desktop app always starts on loopback" wording refreshed.

## [S3] Scope

- In scope: the webserver runtime bind method with tests; the pocket route and live surface with tests; the client button and en/zh copy; the hint-text refresh.
- Out of scope: the Tailscale and tunnel transports; firewall configuration; persisting the bind across restarts (the desktop shell already passes `--bind-lan` on spawn); changes to the trust fence's rules (bind addresses are already admitted).

## Tasks

- [ ] T1: webserver `bindAdditionalHost` — validation, shared listener construction, disposal, tests (depends: none)
- [ ] T2: pocket bind route and live surface assembly, with route tests (depends: T1)
- [ ] T3: client bind button, en/zh locales, hint refresh (depends: T2)
- [ ] T4: focused verification — webserver and pocket suites, pocket typecheck, translation-pairing gate (depends: T2, T3)

## [S4] Acceptance

- [ ] A loopback-only hub, after `POST /api/pocket/lan/bind`, reports the LAN address in `server.additionalHosts`, offers a `phone.url` on that address, and the trust fence admits the authority.
- [ ] Binding an already-bound address is idempotent; an invalid address answers 400; a failed listen answers an error and leaves the existing listeners serving.
- [ ] The page shows the bind action only while the LAN transport is blocked, and the blocker clears on success.
