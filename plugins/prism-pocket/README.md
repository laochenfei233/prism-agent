# @prism/prism-pocket

Pocket remote access for Prism: the web surface, usable from a phone, with the agent able to call you back.

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

**Remote access over Tailscale**:

- The Pocket settings section detects the local Tailscale (MagicDNS name + 100.x address), reports the server bind surface, verifies the current connection passes the trust fence, and renders copyable commands: bind the Tailscale IP directly (`--host`), or proxy through `tailscale serve` and trust the ts.net domain (`--trusted-host`, `--public-url`). The kernel trust policy is read, never modified.

**PWA install**: manifest, icon, and service worker served by the plugin; the browser half injects the tags at runtime, so a phone browser can add Prism to the home screen.

## Install

The desktop runtime ships the plugin automatically. For a source web profile:

```sh
pnpm --filter @prism/prism-pocket... build   # or: cd plugins/prism-pocket && pnpm build
prism plugin --profile web add <absolute path to plugins/prism-pocket>
```

## Configuration (`cordis.yml`)

```yaml
pocket:
  pushEnabled: true          # deliver push notifications at all
  notifyTurnComplete: true   # notify on clean turn completion, not just blocking asks
  barkUrl: https://api.day.app/<device-key>   # optional Bark relay
```

## Notes and limits

- The webserver rejects wildcard binds and unknown Host/Origin authorities by design; the settings page explains the exact command for the path you choose. Tailscale `serve` provides HTTPS, which browsers require for push and service workers on non-localhost origins.
- iOS home-screen icons fall back to a screenshot (SVG touch icons are unsupported there); PNG icons are a follow-up.
- The service worker keeps its own small zh/en text table because it lives outside the client context.
