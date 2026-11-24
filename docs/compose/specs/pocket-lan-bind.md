---
feature: pocket-lan-bind
status: delivered
updated: 2026-11-24
branch: feat/pocket-lan-bind (worktree .worktrees/pocket-lan-bind)
commits: 26b7c472a5..daa351655c
---

# Pocket LAN Bind Action

English | [中文](pocket-lan-bind.zh.md)

## Report

**What was built** — The Pocket settings page can now put the hub's listener on the machine's LAN address itself, instead of only printing a CLI command. `WebServer.bindAdditionalHost(host)` binds one more concrete local address on the live listener after activation: the address joins `hosts` — the authority list the `/api` trust fence reads — and disposal closes the listener. Wildcard, non-literal, duplicate, port-0, and disposed-service requests throw; a failed listen throws with the OS reason and leaves the serving listeners untouched. `POST /api/pocket/lan/bind` detects the machine's preferred LAN address, binds it (idempotent when already bound), and answers the fresh status body; the status now reads the listener's live hosts and port, so a runtime bind clears the LAN blocker without a restart. While the LAN transport reports an unbound address, the page shows a primary "bind now" button; failures surface as a note beside the copyable CLI step, whose stale loopback wording is refreshed.

**Verification** — `packages/host/webserver` vitest 32/32 (4 new runtime-bind tests covering success, duplicate/wildcard/non-literal, port 0, failed listen keeping the primary, and post-disposal refusal). `plugins/prism-pocket` vitest 156/156 (4 `applyLanBind` tests plus 4 route tests over the real stores: live `additionalHosts` and authenticated `phone.url` in the body, idempotent skip, 400 without a LAN address, 500 with the OS reason). Pocket `tsc` reports no error in the changed files (the 19 remaining are the fresh-worktree unresolved-module set). `verify-translation-pairing` passes for the three edited doc pairs. The repository coverage gate (`pnpm run test:coverage`) ran end to end: no failed test and no coverage violation touches the changed packages, and the typert catalog failures reproduce identically on the unmodified checkout, so they are pre-existing.

**Journey log**

- Moving the TLS material read out of the listen effect broke "closes the listener when disposal lands while the TLS material is still being read": the read must stay inside the effect so a disposal landing mid-read still waits for the listen it must close.
- The frozen startup-flag surface could not see a runtime bind; reading `webserver.hosts`/`port` live makes the fence's authority list and the page's report the same truth.
- Importing the plugin's `index.ts` under vitest loads the `@deepseek-ai/dsh-llm` facade, which is declarations-only; the bot specs' `createUserMessage` mock is required for any spec touching the plugin root.
- Ad-hoc `vitest --coverage` runs with a file filter reported 0% for instrumented files; the per-file gate evidence comes from the full `test:coverage` run, whose failures outside the changed packages reproduce on the unmodified checkout.

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

- [x] T1: webserver `bindAdditionalHost` — validation, shared listener construction, disposal, tests (depends: none)
- [x] T2: pocket bind route and live surface assembly, with route tests (depends: T1)
- [x] T3: client bind button, en/zh locales, hint refresh (depends: T2)
- [x] T4: focused verification — webserver and pocket suites, pocket typecheck, translation-pairing gate (depends: T2, T3)

## [S4] Acceptance

- [x] A loopback-only hub, after `POST /api/pocket/lan/bind`, reports the LAN address in `server.additionalHosts`, offers a `phone.url` on that address, and the trust fence admits the authority.
- [x] Binding an already-bound address is idempotent; an invalid address answers 400; a failed listen answers an error and leaves the existing listeners serving.
- [x] The page shows the bind action only while the LAN transport is blocked, and the blocker clears on success.
