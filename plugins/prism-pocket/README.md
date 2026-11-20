# @prism/prism-pocket

English | [中文](README.zh.md)

Pocket remote access for Prism: the web surface, usable from a phone, chat bots that drive the workspace from nine IM channels, and the agent able to call you back.

A client-side patch plugin — zero changes to the web app itself. Every adaptation anchors on the app's own `[data-slot]` seams, degrades per feature when an anchor is missing, and never touches the desktop experience.

## Features

**Mobile adaptation** (active on narrow coarse-pointer viewports, or `?pocket=1` in the URL):

- Left-edge swipe opens the sidebar as an overlay drawer; the browser back gesture closes the drawer before it leaves the page; any navigation from inside the drawer dismisses it.
- The soft keyboard is tracked through `visualViewport`: the header yields while the composer dock stays, and safe-area insets are respected.
- Plain `Enter` inserts a newline on touch keyboards (IME and modifier chords unaffected).
- Composer control rows scroll instead of wrapping; message tables scroll horizontally; accidental double-tap zoom and rubber-band scrolling are disabled.

**Notifications**:

- In-page cards when the agent requests an approval or asks a user question; a system `Notification` while the page is hidden.
- Web Push (RFC 8291/8292, implemented on `node:crypto` — no push library) while the page is closed, for approvals, questions, completed turns, and run failures. Subscriptions and the VAPID keypair live under the DSH home's `pocket/` directory.
- Optional Bark relay (`barkUrl` config) as a push channel for iOS without an installed PWA.

**Bot channels** (nine channels, configured on the Pocket settings page):

- Telegram, Discord, Slack, 飞书/Lark, DingTalk, and QQ connect outbound — a WebSocket long connection or polling from this machine, no public IP, no tunnel.
- WeChat (公众号/测试号), WeCom (企业微信自建应用), and WhatsApp (Cloud API) receive through signed callback routes the plugin registers on the webserver; the page shows the URL to register and the reachability hint (Tailscale Funnel or your own reverse proxy).
- A bot drives one bound session, and the binding answers only to its operator: send `/start <code>` from your chat with the code the Pocket page shows beside the QR (a channel never binds on its first message), `/new` rebinds from any chat you operate, `/stop` stops the turn when the agent exposes the affordance, `/help` lists the commands. Replies return to the bound chat, chunked to the channel's limit; a pending approval or user question reaches the chat as numbered choices — `1`/`y` approves, `2`/`n` rejects, a number picks a question's option, and 120s of silence delegates to the app's own surfaces.
- Credentials live in the DSH home's `pocket/bots.json` (mode 0600), never leave a route response, and each channel's card reports per-field whether a value is stored. `Test` probes the cheapest credential check without sending a message.

**Remote access: local network first, Tailscale or a stable tunnel as the fallback**:

- The Pocket settings section offers three transports and starts on the local network: it finds the machine's private IPv4 address (192.168 first), and a listener bound to that address gives the phone `http://<address>:<port>/` directly — the fence already admits the listener's own bind address, so no trust entry is needed. When the server listens on loopback only, the page reports `not-bound` and prints `prism web --host <address> --port <port>` instead of a link; the desktop app always starts on loopback.
- Tailscale: it probes the local CLI and answers whether a phone can open this now, requests the advertised address instead of inferring from configuration, so a fence refusal and a missing proxy read differently, and offers the authenticated link to copy — the login token is what the phone trades for a session cookie — with the missing steps (`tailscale serve`, the `trustedHosts` entry for the ts.net authority) when the answer is no. The QR encodes that login link, so keep it off screenshots and shared chats.
- Cloudflare tunnel or any stable HTTPS hostname: enter the public address your named tunnel serves. The page reports the cloudflared probe, prints `cloudflared tunnel run <name>` and a first-run `cloudflared tunnel --url http://127.0.0.1:<port>` test, and prints the `trustedHosts` entry for that hostname; the address counts as ready only after it answers the probe without a fence refusal. The kernel trust policy is read, never modified.

**PWA install**: manifest, icon, and service worker served by the plugin; the browser half injects the tags at runtime, so a phone browser can add Prism to the home screen.

## Install

The desktop runtime ships the plugin automatically. For a source web profile:

```sh
cd plugins/prism-pocket && node ../../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts
prism plugin --profile web add link:<absolute path to plugins/prism-pocket>
```

Install with `link:` so the profile reads this checkout; a bare path installs a copy instead, and a copy taken before the build has no `lib/` to import.

## Configuration (`cordis.yml`)

```yaml
pocket:
  pushEnabled: true          # deliver push notifications at all
  notifyTurnComplete: true   # notify on clean turn completion, not just blocking asks
  barkUrl: https://api.day.app/<device-key>   # optional Bark relay
```

## Notes and limits

- The webserver rejects wildcard binds and unknown Host/Origin authorities by design; the settings page explains the exact command for the path you choose. Tailscale `serve` and a named tunnel both provide HTTPS, which browsers require for push and service workers on non-localhost origins.
- Binding the local-network address exposes the whole app to that network; the login token in the link is the only gate. A phone opened over plain `http` also gets no service worker, push, or home-screen install — those need the HTTPS of Tailscale or the tunnel.
- The plugin never starts, stops, or configures Tailscale or the tunnel process, and reads no tunnel credentials; a random quick-tunnel hostname cannot pass the fence, so the stable name of a named tunnel is what the page stores.
- iOS home-screen icons fall back to a screenshot (SVG touch icons are unsupported there); PNG icons are a follow-up.
- The service worker keeps its own small zh/en text table because it lives outside the client context.
