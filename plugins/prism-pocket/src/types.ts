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

/** The `GET /api/pocket/remote` body. */
export interface PocketRemoteStatus {
  server: PocketServerSurface
  tailscale: PocketTailscaleInfo
  pocket: {
    pushEnabled: boolean
    notifyTurnComplete: boolean
    barkConfigured: boolean
    /** VAPID public key (base64url of the raw P-256 point) for `applicationServerKey`. */
    vapidPublicKey: string
    subscriptions: number
  }
}

/** Copyable remote-access commands the settings page renders. */
export interface PocketRemoteCommands {
  /** `prism --profile web --host <tailscale-ip>` — the fence accepts the bind IP directly. */
  directIp?: string
  /** `tailscale serve --bg --https=443 http://127.0.0.1:<port>` for the MagicDNS path. */
  serve?: string
  /** `--trusted-host <machine>.<tailnet>.ts.net` for the MagicDNS path. */
  trustedHost?: string
  /** `--public-url https://<machine>.<tailnet>.ts.net/` for the MagicDNS path. */
  publicUrl?: string
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
