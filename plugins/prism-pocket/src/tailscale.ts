/**
 * Local Tailscale probe.
 *
 * Runs `tailscale status --json --peers=false` and lifts the self MagicDNS
 * name and first Tailscale address. Everything fails soft into
 * `{ available: false }` — a machine without Tailscale is a normal
 * deployment, and the settings page renders guidance instead of facts.
 *
 * @module @prism/prism-pocket
 */

import { execFile } from 'node:child_process'
import type { PocketTailscaleInfo } from './types.ts'

/** Injectable process runner; arguments mirror `child_process.execFile`. */
export type ExecRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>

/** Default runner around `child_process.execFile`. */
const defaultRunner: ExecRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null && stdout === '') {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      resolve({ stdout, stderr })
    })
  })

/** How long the CLI may take to answer before the probe reports unavailable. */
const PROBE_TIMEOUT_MS = 5000

/** Windows install location the PATH lookup misses when launched from a service. */
const WINDOWS_CLI_PATH = 'C:\\Program Files\\Tailscale\\tailscale.exe'

/**
 * Probe the local Tailscale state.
 * @param runner - injectable process runner; defaults to `execFile`.
 * @returns the self MagicDNS name and first Tailscale address, or an
 * `available: false` result carrying the failure detail.
 */
export async function detectTailscale(runner: ExecRunner = defaultRunner): Promise<PocketTailscaleInfo> {
  const commands = candidateCommands()
  let lastError = 'tailscale was not found'
  for (const file of commands) {
    let stdout: string
    try {
      ({ stdout } = await runner(file, ['status', '--json', '--peers=false'], {
        timeout: PROBE_TIMEOUT_MS,
      }))
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
      // Only the not-installed case falls through to the next candidate; a
      // real CLI failure (daemon down, bad args) is reported as-is.
      if (!lastError.includes('ENOENT') || commands.length === 1) {
        return { available: false, detail: lastError }
      }
      continue
    }
    return parseTailscaleStatus(stdout)
  }
  return { available: false, detail: lastError }
}

/**
 * Parse `tailscale status --json` output down to the self facts.
 * Exported for tests; tolerates CLI shape drift by reading only the fields it needs.
 * @param stdout - the CLI's stdout.
 */
export function parseTailscaleStatus(stdout: string): PocketTailscaleInfo {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { available: false, detail: 'tailscale status printed non-JSON output' }
  }
  const self = readSelf(parsed)
  const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : undefined
  const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.filter(ip => typeof ip === 'string') : []
  if (self?.Online === false) {
    return { available: false, detail: 'tailscale reports this node offline' }
  }
  if (dnsName === undefined && ips.length === 0) {
    return { available: false, detail: 'tailscale status carried no self facts' }
  }
  const ipv4 = ips.find(ip => ip.includes('.') && !ip.includes(':'))
  return {
    available: true,
    ...(dnsName !== undefined ? { dnsName } : {}),
    ...(ipv4 !== undefined ? { ipv4 } : {}),
  }
}

/** CLI candidates in order: the Windows install location first, then PATH lookup. */
function candidateCommands(): readonly string[] {
  if (process.platform === 'win32') return [WINDOWS_CLI_PATH, 'tailscale']
  return ['tailscale']
}

interface TailscaleSelf {
  DNSName?: unknown
  TailscaleIPs?: unknown
  Online?: unknown
}

/** Read the `Self` record out of the status JSON without trusting its shape. */
function readSelf(parsed: unknown): TailscaleSelf | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const self = (parsed as { Self?: unknown }).Self
  if (typeof self !== 'object' || self === null) return undefined
  return self as TailscaleSelf
}
