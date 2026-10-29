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
 * server surface. Display logic only; the fence itself stays host-side.
 * @param origin - the page origin, for example `https://machine.tailnet.ts.net`.
 * @param surface - the server bind surface the page is asking about.
 */
export function isOriginTrusted(
  origin: string,
  surface: Pick<PocketServerSurface, 'host' | 'port' | 'trustedHosts'>,
): boolean {
  const authority = origin.replace(/^https?:\/\//, '').replace(/:(443|80)$/, '')
  if (authority === `${surface.host}:${surface.port}`) return true
  return surface.trustedHosts.some(entry => authority === entry || authority === entry.split(':')[0])
}
