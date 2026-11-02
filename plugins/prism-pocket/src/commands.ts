/**
 * Remote-access facts and command generation, shared by the node half's status
 * route and the settings page (which re-derives the same commands from the
 * status body).
 *
 * The deployment these commands describe is the desktop application, which
 * starts `dsh web` on a loopback port with fixed arguments: it can bind no
 * other address and can pass no trust flag. Exposing it to a phone therefore
 * goes through a `tailscale serve` proxy over the loopback listener, and the
 * MagicDNS authority joins the fence through the profile patch.
 *
 * @module @prism/prism-pocket/commands
 */

import type { PocketPhoneAccess, PocketRemoteCommands, PocketServerSurface, PocketTailscaleInfo } from './types.ts'

/**
 * Render the copyable deployment steps for this deployment.
 * @param surface - the webserver bind surface and trust list.
 * @param tailscale - the local Tailscale probe result.
 * @returns the proxy command and the fence patch when a MagicDNS name exists,
 * and the CLI trust flag for a server the user starts themselves.
 */
export function remoteCommands(surface: PocketServerSurface, tailscale: PocketTailscaleInfo): PocketRemoteCommands {
  if (tailscale.dnsName === undefined) return {}
  return {
    serve: `tailscale serve --bg --https=443 http://127.0.0.1:${surface.port}`,
    trust: `- id: connection\n  config:\n    trustedHosts:\n      - ${tailscale.dnsName}`,
    trustedHost: `--trusted-host ${tailscale.dnsName}`,
  }
}

/**
 * Resolve the address a phone should open and whether the configured trust
 * list already admits it.
 *
 * This is the cheap answer: it reads the bind surface and the Tailscale probe
 * and never touches the network. A proxied address that the list does not name
 * is reported as `untrusted` until the caller probes it, because only a real
 * request through the proxy tells the fence answer from a missing proxy.
 * @param surface - the webserver bind surface and trust list.
 * @param tailscale - the local Tailscale probe result.
 * @returns the address to open, whether its authority passes the fence, and
 * the blocker when no address exists at all.
 */
export function phoneAccess(
  surface: PocketServerSurface,
  tailscale: PocketTailscaleInfo,
): { blocker?: PocketPhoneAccess['blocker']; target?: string; trusted: boolean } {
  const target = phoneTarget(surface, tailscale)
  if (target === undefined) {
    return { blocker: tailscale.available ? 'loopback' : 'no-tailscale', trusted: false }
  }
  const trusted = isOriginTrusted(originOf(target), surface)
  return trusted ? { target, trusted } : { target, trusted, blocker: 'untrusted' }
}

/**
 * Classify one request to the phone address.
 *
 * The Host/Origin fence answers before the session layer, so `403` is the
 * fence refusing this authority and every other answer means the request
 * reached the server. A 2xx and a 401 are therefore equally good news.
 * @param status - the HTTP status the address answered with.
 * @returns `untrusted` when the fence refused, `accepted` otherwise.
 */
export function probeVerdict(status: number): 'untrusted' | 'accepted' {
  return status === 403 ? 'untrusted' : 'accepted'
}

/**
 * The URL a phone should open, before authentication is added.
 * @param surface - the webserver bind surface.
 * @param tailscale - the local Tailscale probe result.
 * @returns the advertised public URL, the MagicDNS root, or the direct bind
 * address; undefined when the server listens on loopback with no Tailscale.
 */
export function phoneTarget(surface: PocketServerSurface, tailscale: PocketTailscaleInfo): string | undefined {
  if (surface.publicUrl !== undefined) return surface.publicUrl
  if (tailscale.dnsName !== undefined) return `https://${tailscale.dnsName}/`
  if (isLoopbackHostname(normalizeHost(surface.host))) return undefined
  return `http://${normalizeHost(surface.host)}:${surface.port}/`
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

/** The origin of an absolute URL, so the fence check sees only scheme and authority. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
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
