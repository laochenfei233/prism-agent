/**
 * Shared wire shapes between the Prism Pocket node half and its browser half.
 *
 * @module @prism/prism-pocket
 */

/** The webserver surface the pocket plugin loaded into, as the settings page reports it. */
export interface PocketServerSurface {
  /** Bind address literal (loopback by default). */
  host: string
  /** Listen port. */
  port: number
  /** Advertised public URL from `--public-url`, when set. */
  publicUrl?: string
  /** Extra trusted authorities from `--trusted-host`, verbatim. */
  trustedHosts: string[]
}

/** The transport the Pocket settings page describes. */
export type PocketProvider = 'lan' | 'tailscale' | 'tunnel'

/** Local-network facts read from the OS interface table. */
export interface PocketLanInfo {
  /** A non-internal IPv4 interface was found. */
  available: boolean
  /** The preferred address, private ranges first. */
  ipv4?: string
  /** Why no address exists, when none does. */
  detail?: string
}

/** cloudflared facts probed from the local CLI. */
export interface PocketCloudflaredInfo {
  /** The `cloudflared` CLI answered `--version`. */
  available: boolean
  /** CLI version, when the output carried one. */
  version?: string
  /** Why the probe failed, when it failed. */
  detail?: string
}

/** The persisted remote-transport selection. */
export interface PocketRemotePrefs {
  /** Which transport the page explains and the phone link describes. */
  provider: PocketProvider
  /** Stable HTTPS hostname of the tunnel transport, when one is stored. */
  tunnelUrl?: string
}

/** Tailscale facts probed from the local CLI. */
export interface PocketTailscaleInfo {
  /** The `tailscale` CLI answered and reported self state. */
  available: boolean
  /** Self MagicDNS name, trailing dot stripped (for example `machine.tailnet.ts.net`). */
  dnsName?: string
  /** First self Tailscale address (100.x.y.z). */
  ipv4?: string
  /** Why the probe failed, when it failed. */
  detail?: string
}

/** The address a phone should open, and what still stands in its way. */
export interface PocketPhoneAccess {
  /** The first thing blocking the phone, when something does. */
  blocker?: 'loopback' | 'no-tailscale' | 'no-lan' | 'not-bound' | 'no-tunnel-url' | 'not-serving' | 'untrusted'
  /** The address already passes the Host/Origin fence. */
  trusted: boolean
  /** Authenticated URL to open on the phone; carries the login token, so never render it verbatim. */
  url?: string
  /** The same URL with its token elided, safe to display and to keep in a screenshot. */
  display?: string
}

/** The `GET /api/pocket/remote` body. */
export interface PocketRemoteStatus {
  server: PocketServerSurface
  lan: PocketLanInfo
  tailscale: PocketTailscaleInfo
  cloudflared: PocketCloudflaredInfo
  remote: PocketRemotePrefs
  phone: PocketPhoneAccess
  pocket: {
    pushEnabled: boolean
    notifyTurnComplete: boolean
    barkConfigured: boolean
    /** VAPID public key (base64url of the raw P-256 point) for `applicationServerKey`. */
    vapidPublicKey: string
    subscriptions: number
  }
}

/** Copyable deployment steps the settings page renders. */
export interface PocketRemoteCommands {
  /** `prism web --host <lan> --port <port>` — binds the listener to the address a phone on this network reaches. */
  bind?: string
  /** `tailscale serve --bg --https=443 http://127.0.0.1:<port>` — exposes the loopback listener to the tailnet. */
  serve?: string
  /** `cloudflared tunnel run <name>` — the named tunnel whose hostname stays stable. */
  run?: string
  /** `cloudflared tunnel --url http://127.0.0.1:<port>` — a first-run test whose hostname is random. */
  quick?: string
  /** Profile patch that admits the remote authority through the Host/Origin fence. */
  trust?: string
  /** `--trusted-host <authority>` for a server the user starts from the CLI. */
  trustedHost?: string
}

/** What the agent needs a human for; the service worker composes localized text from it. */
export interface PocketPushPayload {
  kind: 'approval' | 'question' | 'turn-end' | 'error'
  /** Short context line (tool name, failure summary) when the trigger carries one. */
  detail?: string
  /** Session the event belongs to, when the trigger knows it. */
  sessionId?: string
  /** Session title, when resolvable cheaply at trigger time. */
  sessionTitle?: string
}

/** One browser push subscription persisted beside the VAPID keys. */
export interface PocketPushSubscriptionRecord {
  /** The push service endpoint URL (https). */
  endpoint: string
  /** Client encryption keys, base64url. */
  keys: { p256dh: string; auth: string }
  /** RFC 3339 creation time. */
  addedAt: string
}
