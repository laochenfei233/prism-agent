---
feature: pocket-remote-providers
status: delivered
updated: 2026-11-04
branch: feat/pocket-remote-providers
commits: 50ff54bd96..fc01b19f6c
---

# Pocket remote transports

English | [中文](pocket-remote-providers.zh.md)

## Report

**What was built** — The Pocket phone panel now offers three transports behind one selector, and starts on the local network: it finds the machine's private IPv4 address (192.168 first), and a listener bound to that address gives the phone `http://<address>:<port>/` with no trust entry, because the fence already admits the listener's own bind address. A loopback-bound server reports `not-bound` with the `prism web --host <address> --port <port>` step instead of a link; the desktop app always starts on loopback. Tailscale (unchanged probe, MagicDNS target, `tailscale serve` step, ts.net trust patch) and a stable tunnel (a user-stored `https` hostname served by `cloudflared` or any reverse proxy) remain selectable fallbacks. The selection persists host-side in the DSH home's `pocket/remote.json`; `POST /api/pocket/remote` validates the body (https, no credentials, no fragment, no surrounding whitespace), writes the file atomically with mode 0600, and answers with a fresh status body, so the page never reconstructs state the host owns. `GET` reports the LAN address, both CLI probes, the resolved tunnel URL, and the phone address for the selected transport; an advertised HTTPS address shares the readiness measurement, so it counts as ready only after it answers the probe without a fence refusal.

**Verification** — In the worktree: `vitest run` in `plugins/prism-pocket` — 14 files, 122 tests, 0 failures (new: `tests/lan.spec.ts` 3, `tests/remote-prefs.spec.ts` 7, `tests/tunnel.spec.ts` 5, `tests/commands.spec.ts` 24 including the three command sets and the per-transport access matrix); `tsc --noEmit` over the plugin sources against the main checkout's built declarations — clean; `tsdown` built both faces; `oxlint` on the plugin sources and tests — 0 warnings, 0 errors; `verify-md-links` (2108 files) and `verify-client-ui-i18n` (1117 files) pass, and `verify-translation-pairing` passes for the changed spec and README pairs. Repo-wide `verify-md-wrap`, `verify-export-jsdoc`, and `verify-translation-pairing` fail only on pre-existing master content (`docs/compose/specs/*`, `packages/transfer`, `packages/client/ui-theme`, `packages/host/webserver`). Review round 1 returned no critical findings and five fixable gaps — the tunnel steps and `--trusted-host` flag were never rendered, a whitespace-padded stored URL skipped the readiness probe, the save button posted an empty value, the failed-switch note was hidden, and the input lacked a label — all fixed in `d8b9f2ff1f` and re-verified; the LAN default was added afterwards at the user's direction.

**Journey log** — The phone client is a browser, so a real P2P transport would need a service worker request proxy or native clients with a relay; a stable HTTPS hostname over the existing loopback listener is the smallest change that actually reaches the phone, and the fence's exact-authority rule rules out random quick-tunnel hostnames. The plugin still starts no daemon, so the page explains `cloudflared` rather than running it. Tooling: in a linked worktree, `pnpm install` lifecycle scripts and vite's Windows realpath probe both spawn children with piped stdio, which this sandbox denies; tests ran through the `.pnpm` vitest entry with escalated access, and pointing the worktree's `node_modules` at the main checkout let `pnpm exec` rewrite the main checkout's workspace links — repaired with a reinstall there, and pnpm must run only in the checkout that owns `node_modules`.

## [S1] Problem

The Pocket settings page explains one route off this machine: the local Tailscale CLI, its MagicDNS name, and the `tailscale serve` proxy. The fastest route — a phone on the same Wi-Fi opening the machine's own private address — is not offered at all. A user who already exposes the loopback port through a Cloudflare tunnel with a stable hostname has the same reachability, but the page reports `no-tailscale` and offers no link, because Tailscale is the only transport the status route knows. The user cannot tell the plugin which transport it should describe, and the trusted-host step it prints is always the ts.net authority.

## [S2] Design

### S2.1 Three transports, one selected

The plugin knows three transports: `lan` (the machine's private IPv4 address, default), `tailscale` (probe the local CLI, derive the MagicDNS root), and `tunnel` (a stable HTTPS hostname the user owns and serves with `cloudflared` or any reverse proxy). The selection is persisted host-side in `pocket/remote.json` beside the bot store (`{ version: 1, provider: 'lan' | 'tailscale' | 'tunnel', tunnelUrl?: string }`, rewritten atomically with mode 0600) and defaults to `lan`, which is the route a phone on the same network uses with no daemon and no trust entry.

The selection names which transport the page explains and which address the phone link, QR, and verdict describe. The other transport's facts stay in the status body and remain visible: both probes are always reported, so a user can see that Tailscale is installed while the tunnel is the chosen route.

### S2.2 The tunnel transport is a stable HTTPS hostname

The route is the stored `tunnelUrl`, falling back to the `--public-url` value the webserver surface already carries. It must be an `https:` URL with no credentials, no fragment, and no surrounding whitespace; a path is preserved (a prefix-stripping proxy is legitimate). The plugin never starts, stops, or configures the tunnel process: like `tailscale serve`, the tunnel is the user's daemon, and the plugin only explains the step and the fence entry it needs.

### S2.3 cloudflared detection

The node half probes `cloudflared --version` on PATH (5 s timeout, the same fail-soft contract as `detectTailscale`) and reports `{ available, version?, detail? }`. It performs no network call, reads no credentials, and infers no hostname from the cloudflared configuration: the stable hostname is whatever the user stores, because a token-managed tunnel has no local config to read.

### S2.4 Phone access per provider

`phoneAccess(surface, tailscale)` keeps today's resolution for the tailscale arm (`publicUrl`, then the MagicDNS root, then a non-loopback bind address) and today's blockers. `lanAccess(surface, ipv4)` resolves `http://<ipv4>:<port>/`; a listener bound to that address is already trusted by the fence and needs no entry, so the only blockers are `no-lan` when the machine has no non-internal IPv4 interface and `not-bound` when the listener is bound elsewhere. `tunnelAccess(surface, tunnelUrl)` resolves the stored URL, then `publicUrl`; its blockers are `no-tunnel-url` when neither exists, `untrusted` when the authority is absent from `trustedHosts`, and the measured `not-serving` when the HTTPS probe fails. The fence itself is unchanged.

### S2.5 Wire

`GET /api/pocket/remote` returns `server`, `lan`, `tailscale`, `cloudflared`, `remote: { provider, tunnelUrl? }`, `phone` for the selected transport, and the existing `pocket` block. `POST /api/pocket/remote` accepts `{ provider, tunnelUrl? }`, validates it, persists it, and answers the fresh status body, so the page never reconstructs state the host owns.

### S2.6 Commands

For `lan` the page prints `prism web --host <address> --port <port>` while the listener is not bound there, with the note that the desktop app always starts on loopback. For `tailscale` the commands are unchanged. For `tunnel` the page prints: `cloudflared tunnel run <name>` (a named tunnel keeps the hostname stable), `cloudflared tunnel --url http://127.0.0.1:<port>` (a first-run test whose hostname is random and therefore not fenced), the trust patch for the stored hostname, and the `--trusted-host <host>` flag for a CLI-started server. The two tunnel run steps show in every blocked tunnel state, including before a hostname is stored; only the host-dependent steps (the patch and the flag) wait for one.

### S2.7 Settings surface

A transport selector sits at the top of the phone panel, followed by the tunnel hostname field and its save action when `tunnel` is chosen. The QR, verdict, link, and numbered steps describe the selected transport only. Copy is locale-owned (zh/en) like the rest of the page; the page keeps its existing panel classes and adds no stylesheet.

### S2.8 Trust and security unchanged

The plugin validates the stored URL at the trust boundary, never fetches anything but the phone target it is about to report, and never mutates `trustedHosts`. A tunnel hostname that the fence does not name renders as `untrusted` with the patch to add, and the address is only reported as ready after the probe is answered by the server. The tunnel process, its credentials, and its DNS route stay outside the plugin.

### S2.9 Tests

Unit tests cover URL validation (scheme, credentials, fragment, path, surrounding whitespace), the LAN address ranking (192.168 first, then the other private ranges, then any external address; loopback and IPv6 skipped), the per-transport target and blocker matrix, the LAN and tunnel command sets, the cloudflared version probe parsing, and the prefs store's default/corrupt-file behavior. The settings page's pure logic stays in `commands.ts` and the new modules, so no browser harness is needed.

### S2.10 The local network is the default transport

The node half reads the OS interface table (`os.networkInterfaces`) and picks the preferred non-internal IPv4 address: `192.168.*` first, then `10.*`, then `172.16–31.*`, then any other external address. The address is what the phone on the same network opens; the plugin does not start or reconfigure the listener, so a machine whose server binds loopback reports `not-bound` and shows the one command that changes that. Binding the address exposes the whole app to that network — the login token in the link is the only gate — and a phone on plain `http` gets no service worker or push, which the README states as a limit.

## [S3] Scope

- In scope: `pocket/remote.json` prefs store, `POST /api/pocket/remote`, LAN address discovery, cloudflared probe, per-transport phone access and commands, the status wire fields, the settings selector and hostname field, zh/en copy, README section, unit tests, changelog fragment.
- Out of scope: starting or supervising `cloudflared`, `tailscale serve`, or `tailscale funnel`, or relaunching the listener bound to the LAN address (the desktop app starts on loopback by design); reading `~/.cloudflared`; wildcard or dynamic trust; WebRTC or a bespoke relay; a further transport (ngrok, frp) beyond the generic stable-hostname arm; clearing a stored hostname from the page.

## Tasks

- [x] T1: prefs store + validation + `POST` route (covers: S2.1, S2.2, S2.5)
- [x] T2: LAN address discovery and the bind step (covers: S2.10, S2.6)
- [x] T3: cloudflared probe (covers: S2.3)
- [x] T4: per-transport access, blockers, and commands (covers: S2.4, S2.6, S2.8)
- [x] T5: status wire composition and probing (covers: S2.5)
- [x] T6: settings selector, tunnel field, steps, zh/en copy (covers: S2.7)
- [x] T7: tests, README, changelog (covers: S2.9)

## [S4] Acceptance

- With `provider: lan` (the default) and a listener bound to the machine's `192.168.*` address, the phone target is `http://<address>:<port>/` and the page reports it ready with no trust entry; with the default loopback listener it reports `not-bound` and prints `prism web --host <address> --port <port>`; without any non-internal IPv4 interface it reports `no-lan`.
- With `provider: tailscale` the page behaves exactly as before: same target, verdict, and steps on a machine with Tailscale; `no-tailscale` without it.
- With `provider: tunnel` and a stored `https://prism.example.com`, the page reports that address as the phone target, `untrusted` until `trustedHosts` names `prism.example.com`, and `not-serving` when nothing answers; the trust patch it prints matches `packages/client/connection/src/api-request-trust.ts`.
- `POST /api/pocket/remote` rejects a non-https URL, credentials, and a fragment with 400 and keeps the stored value unchanged; an accepted body persists to `pocket/remote.json` with mode 0600 and survives a restart.
- The page reports the cloudflared probe result separately from the selection.
- `vitest run` in `plugins/prism-pocket` passes, including the new validation, access-matrix, command, and probe tests; `tsc --noEmit` and the plugin build are clean.
