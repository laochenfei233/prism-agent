---
feature: pocket-remote-providers
status: in-progress
updated: 2026-11-04
branch: feat/pocket-remote-providers
---

# Pocket remote transports

English | [中文](pocket-remote-providers.zh.md)

## Report

Delivered at finalize; see the sections below for the design under implementation.

## [S1] Problem

The Pocket settings page explains one route off this machine: the local Tailscale CLI, its MagicDNS name, and the `tailscale serve` proxy. A user who already exposes the loopback port through a Cloudflare tunnel with a stable hostname has the same reachability, but the page reports `no-tailscale` and offers no link, because Tailscale is the only transport the status route knows. The user cannot tell the plugin which transport it should describe, and the trusted-host step it prints is always the ts.net authority.

## [S2] Design

### S2.1 Two transports, one selected

The plugin knows two transports: `tailscale` (probe the local CLI, derive the MagicDNS root) and `tunnel` (a stable HTTPS hostname the user owns and serves with `cloudflared` or any reverse proxy). The selection is persisted host-side in `pocket/remote.json` beside the bot store (`{ version: 1, provider: 'tailscale' | 'tunnel', tunnelUrl?: string }`, rewritten atomically with mode 0600) and defaults to `tailscale`, which is the behavior a fresh install already has.

The selection names which transport the page explains and which address the phone link, QR, and verdict describe. The other transport's facts stay in the status body and remain visible: both probes are always reported, so a user can see that Tailscale is installed while the tunnel is the chosen route.

### S2.2 The tunnel transport is a stable HTTPS hostname

The route is the stored `tunnelUrl`, falling back to the `--public-url` value the webserver surface already carries. It must be an `https:` URL with no credentials; a path is preserved (a prefix-stripping proxy is legitimate), a fragment is rejected. The plugin never starts, stops, or configures the tunnel process: like `tailscale serve`, the tunnel is the user's daemon, and the plugin only explains the step and the fence entry it needs.

### S2.3 cloudflared detection

The node half probes `cloudflared --version` on PATH (5 s timeout, the same fail-soft contract as `detectTailscale`) and reports `{ available, version?, detail? }`. It performs no network call, reads no credentials, and infers no hostname from the cloudflared configuration: the stable hostname is whatever the user stores, because a token-managed tunnel has no local config to read.

### S2.4 Phone access per provider

`phoneAccess(surface, tailscale)` keeps today's resolution for the tailscale arm (`publicUrl`, then the MagicDNS root, then a non-loopback bind address) and today's blockers. `tunnelAccess(surface, tunnelUrl)` resolves the stored URL, then `publicUrl`; its blockers are `no-tunnel-url` when neither exists, `untrusted` when the authority is absent from `trustedHosts`, and the measured `not-serving` when the HTTPS probe fails. The fence itself is unchanged.

### S2.5 Wire

`GET /api/pocket/remote` returns `server`, `tailscale`, `cloudflared`, `remote: { provider, tunnelUrl? }`, `phone` for the selected transport, and the existing `pocket` block. `POST /api/pocket/remote` accepts `{ provider, tunnelUrl? }`, validates it, persists it, and answers the fresh status body, so the page never reconstructs state the host owns.

### S2.6 Commands

For `tailscale` the commands are unchanged. For `tunnel` the page prints: `cloudflared tunnel run <name>` (a named tunnel keeps the hostname stable), `cloudflared tunnel --url http://127.0.0.1:<port>` (a first-run test whose hostname is random and therefore not fenced), the trust patch for the stored hostname, and the `--trusted-host <host>` flag for a CLI-started server. A hostname that is not yet stored hides the host-dependent steps.

### S2.7 Settings surface

A transport selector sits at the top of the phone panel, followed by the tunnel hostname field and its save action when `tunnel` is chosen. The QR, verdict, link, and numbered steps describe the selected transport only. Copy is locale-owned (zh/en) like the rest of the page; the page keeps its existing panel classes and adds no stylesheet.

### S2.8 Trust and security unchanged

The plugin validates the stored URL at the trust boundary, never fetches anything but the phone target it is about to report, and never mutates `trustedHosts`. A tunnel hostname that the fence does not name renders as `untrusted` with the patch to add, and the address is only reported as ready after the probe is answered by the server. The tunnel process, its credentials, and its DNS route stay outside the plugin.

### S2.9 Tests

Unit tests cover URL validation (scheme, credentials, fragment, path), the per-transport target and blocker matrix, the tunnel command set, the cloudflared version probe parsing, and the prefs store's default/corrupt-file behavior. The settings page's pure logic stays in `commands.ts` and the new modules, so no browser harness is needed.

## [S3] Scope

- In scope: `pocket/remote.json` prefs store, `POST /api/pocket/remote`, cloudflared probe, per-transport phone access and commands, the status wire fields, the settings selector and hostname field, zh/en copy, README section, unit tests, changelog fragment.
- Out of scope: starting or supervising `cloudflared`, `tailscale serve`, or `tailscale funnel`; reading `~/.cloudflared`; wildcard or dynamic trust; WebRTC or a bespoke relay; a fourth transport (ngrok, frp) beyond the generic stable-hostname arm.

## Tasks

- [ ] T1: prefs store + validation + `POST` route (covers: S2.1, S2.2, S2.5)
- [ ] T2: cloudflared probe (covers: S2.3)
- [ ] T3: per-transport access, blockers, and commands (covers: S2.4, S2.6, S2.8)
- [ ] T4: status wire composition and probing (covers: S2.5)
- [ ] T5: settings selector, tunnel field, steps, zh/en copy (covers: S2.7)
- [ ] T6: tests, README, changelog (covers: S2.9)

## [S4] Acceptance

- With `provider: tailscale` the page behaves exactly as before: same target, verdict, and steps on a machine with Tailscale; `no-tailscale` without it.
- With `provider: tunnel` and a stored `https://prism.example.com`, the page reports that address as the phone target, `untrusted` until `trustedHosts` names `prism.example.com`, and `not-serving` when nothing answers; the trust patch it prints matches `packages/client/connection/src/api-request-trust.ts`.
- `POST /api/pocket/remote` rejects a non-https URL, credentials, and a fragment with 400 and keeps the stored value unchanged; an accepted body persists to `pocket/remote.json` with mode 0600 and survives a restart.
- The page reports the cloudflared probe result separately from the selection.
- `vitest run` in `plugins/prism-pocket` passes, including the new validation, access-matrix, command, and probe tests; `tsc --noEmit` and the plugin build are clean.
