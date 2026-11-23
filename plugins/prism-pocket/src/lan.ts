/**
 * Local-network address discovery for the phone link. A phone on the same
 * Wi-Fi reaches the loopback port through nothing but the machine's own LAN
 * address, so that address is the first transport the settings page offers.
 * The probe reads no configuration: it reports the interface the OS lists and
 * prefers the private ranges in the order a home network uses them.
 *
 * @module @prism/prism-pocket/lan
 */

import { networkInterfaces } from 'node:os'
import type { PocketLanInfo } from './types.ts'

/** One interface entry, as `os.networkInterfaces()` reports it. */
interface LanCandidate {
  readonly address: string
  readonly family: string
  readonly internal: boolean
}

/**
 * Pick the address a phone on the same network should open.
 * @param interfaces - the OS interface table; defaults to `os.networkInterfaces()`.
 * @returns the preferred private IPv4 address, or an `available: false` result.
 */
export function detectLanAddress(
  interfaces: Readonly<Record<string, readonly LanCandidate[] | undefined>> = networkInterfaces(),
): PocketLanInfo {
  let best: { address: string; rank: number } | undefined
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const rank = rankOf(entry.address)
      if (best === undefined || rank < best.rank) best = { address: entry.address, rank }
    }
  }
  return best === undefined
    ? { available: false, detail: 'no non-internal IPv4 interface was found' }
    : { available: true, ipv4: best.address }
}

/**
 * Rank one IPv4 address by how likely a phone shares it: the home 192.168
 * range first, then the other private ranges, then anything else.
 * @param address - the candidate IPv4 literal.
 * @returns the sort rank, lowest first.
 */
function rankOf(address: string): number {
  const [first, second] = address.split('.').map(Number)
  if (first === 192 && second === 168) return 0
  if (first === 10) return 1
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return 2
  return 3
}
