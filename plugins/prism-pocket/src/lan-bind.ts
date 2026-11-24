/**
 * The LAN bind action behind `POST /api/pocket/lan/bind`: detect the machine's
 * preferred LAN address and put it on the running listener, so the settings
 * page can open the phone link without a CLI restart.
 *
 * @module @prism/prism-pocket/lan-bind
 */

import { detectLanAddress } from './lan.ts'
import type { PocketLanInfo } from './types.ts'

/** The webserver members the bind action needs. */
export interface BindableWebServer {
  /** Every bound address: the configured host first, then the runtime binds. */
  readonly hosts: readonly string[]
  /** Bind one more concrete local address on the configured port. */
  bindAdditionalHost(host: string): Promise<void>
}

/** The outcome of one bind attempt. */
export type LanBindResult = { ok: true; ipv4: string } | { ok: false; status: 400 | 500; error: string }

/**
 * Detect — or take the given — preferred LAN address and bind it on the
 * running listener. An already-bound address succeeds without touching the
 * listener; a failed listen reports the OS reason and leaves the serving
 * listeners untouched.
 * @param webserver - the running listener's service.
 * @param lan - the LAN probe result; defaults to a fresh `detectLanAddress()`.
 */
export async function applyLanBind(webserver: BindableWebServer, lan: PocketLanInfo = detectLanAddress()): Promise<LanBindResult> {
  if (!lan.available || lan.ipv4 === undefined) {
    return { ok: false, status: 400, error: `no local-network address to bind: ${lan.detail ?? 'none found'}` }
  }
  // The fence compares authorities zone-stripped, so the skip check does too.
  if (webserver.hosts.some(host => host.split('%')[0] === lan.ipv4)) return { ok: true, ipv4: lan.ipv4 }
  try {
    await webserver.bindAdditionalHost(lan.ipv4)
  } catch (cause: unknown) {
    return { ok: false, status: 500, error: cause instanceof Error ? cause.message : String(cause) }
  }
  return { ok: true, ipv4: lan.ipv4 }
}
