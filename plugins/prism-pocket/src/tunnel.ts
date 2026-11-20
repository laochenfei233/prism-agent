/**
 * Local cloudflared probe. The settings page offers a stable tunnel hostname
 * as the second remote transport; this module only answers whether the CLI is
 * installed and which version it is. It reads no credentials and no tunnel
 * configuration — a token-managed tunnel has no local file to read.
 *
 * @module @prism/prism-pocket/tunnel
 */

import { runProcess, type ExecRunner } from './exec.ts'
import type { PocketCloudflaredInfo } from './types.ts'

/** How long the CLI may take to answer before the probe reports unavailable. */
const PROBE_TIMEOUT_MS = 5000

/** Windows install location the PATH lookup misses when launched from a service. */
const WINDOWS_CLI_PATH = 'C:\\Program Files\\cloudflared\\cloudflared.exe'

/**
 * Probe the local cloudflared install.
 * @param runner - injectable process runner; defaults to `execFile`.
 * @returns the CLI version when it answered, or an `available: false` result
 * carrying the failure detail.
 */
export async function detectCloudflared(runner: ExecRunner = runProcess): Promise<PocketCloudflaredInfo> {
  const commands = candidateCommands()
  let lastError = 'cloudflared was not found'
  for (const file of commands) {
    let stdout: string
    try {
      ({ stdout } = await runner(file, ['--version'], { timeout: PROBE_TIMEOUT_MS }))
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
      // Only the not-installed case falls through to the next candidate; a
      // real CLI failure (bad install, denied exec) is reported as-is.
      if (!lastError.includes('ENOENT') || commands.length === 1) {
        return { available: false, detail: lastError }
      }
      continue
    }
    return { available: true, ...versionOf(stdout) }
  }
  return { available: false, detail: lastError }
}

/**
 * Lift the version out of `cloudflared version 2024.8.3 (built …)` output.
 * Exported for tests; an unrecognised line still proves the binary runs.
 * @param stdout - the CLI's stdout.
 * @returns the version field when the line carries one.
 */
export function versionOf(stdout: string): { version?: string } {
  const match = /\bversion\s+(\S+)/u.exec(stdout)
  const version = match?.[1]
  return version === undefined ? {} : { version }
}

/** CLI candidates in order: the Windows install location first, then PATH lookup. */
function candidateCommands(): readonly string[] {
  if (process.platform === 'win32') return [WINDOWS_CLI_PATH, 'cloudflared']
  return ['cloudflared']
}
