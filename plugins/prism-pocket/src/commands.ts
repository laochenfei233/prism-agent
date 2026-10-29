/**
 * Remote-access command generation, shared by the node half's status route
 * and the settings page (which re-derives the same commands from the status
 * body). The text mirrors the trust fence: the listener bind IP is accepted
 * without `--trusted-host`, while a proxied authority must join the list and
 * match the advertised public URL.
 *
 * @module @prism/prism-pocket/commands
 */

import type { PocketRemoteCommands, PocketServerSurface, PocketTailscaleInfo } from './types.ts'

/**
 * Render the copyable remote-access commands for this deployment.
 * @param surface - the webserver bind surface and trust list.
 * @param tailscale - the local Tailscale probe result.
 * @returns the direct-IP command when a Tailscale address exists, and the
 * MagicDNS command set when a MagicDNS name exists.
 */
export function remoteCommands(surface: PocketServerSurface, tailscale: PocketTailscaleInfo): PocketRemoteCommands {
  const commands: PocketRemoteCommands = {}
  if (tailscale.ipv4 !== undefined) {
    commands.directIp = `prism --profile web --host ${tailscale.ipv4}`
  }
  if (tailscale.dnsName !== undefined) {
    commands.serve = `tailscale serve --bg --https=443 http://127.0.0.1:${surface.port}`
    commands.trustedHost = `--trusted-host ${tailscale.dnsName}`
    commands.publicUrl = `--public-url https://${tailscale.dnsName}/`
  }
  return commands
}

/**
 * Whether a page origin already passes the host trust fence for the reported
 * server surface — a display-side mirror of `api-request-trust.ts`: the
 * fence accepts any loopback hostname when the server binds loopback, the
 * bind address itself (port-ignored, `%zone` stripped), and `trustedHosts`
 * entries where a port-less entry matches any port. Display logic only; the
 * fence itself stays host-side.
 * @param origin - the page origin, for example `https://machine.tailnet.ts.net`.
 * @param surface - the server bind surface the page is asking about.
 */
export function isOriginTrusted(
  origin: string,
  surface: Pick<PocketServerSurface, 'host' | 'port' | 'trustedHosts'>,
): boolean {
  const authority = origin.replace(/^https?:\/\//, '')
  const { hostname } = splitAuthority(authority)
  if (hostname === undefined) return false
  if (isLoopbackHostname(hostname) && isLoopbackHostname(normalizeHost(surface.host))) return true
  if (hostname === normalizeHost(surface.host)) return true
  return surface.trustedHosts.some((entry) => {
    const { hostname: entryHost, port: entryPort } = splitAuthority(entry)
    if (entryHost === undefined) return false
    if (entryPort === undefined) return entryHost === hostname
    const { port } = splitAuthority(authority)
    return entryHost === hostname && entryPort === port
  })
}

/** Mirror of the fence's `isLoopbackHostname`: localhost, `[::1]`, or 127/8. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** The bind host as a comparable hostname: `%zone` stripped, IPv6 bracketed. */
function normalizeHost(host: string): string {
  const zoneAt = host.indexOf('%')
  const address = zoneAt === -1 ? host : host.slice(0, zoneAt)
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
}

/** Split one `host[:port]` authority; IPv6 literals keep their brackets. */
function splitAuthority(authority: string): { hostname: string | undefined; port: string | undefined } {
  const bracketEnd = authority.indexOf(']')
  if (bracketEnd !== -1) {
    const hostname = authority.slice(0, bracketEnd + 1)
    const rest = authority.slice(bracketEnd + 1)
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : undefined }
  }
  const portAt = authority.lastIndexOf(':')
  if (portAt === -1) return { hostname: authority, port: undefined }
  return { hostname: authority.slice(0, portAt), port: authority.slice(portAt + 1) }
}
