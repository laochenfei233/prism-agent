/**
 * The remote transport the settings page describes, persisted beside the bot
 * store. Values read from disk or the settings route are re-validated: a file
 * a user edited by hand can only select a known transport and an acceptable
 * tunnel URL.
 *
 * @module @prism/prism-pocket/remote-prefs
 */

import { readFileSync } from 'node:fs'
import { writeJsonFile } from './atomic-json.ts'
import type { PocketProvider, PocketRemotePrefs } from './types.ts'

/**
 * Validate a stable tunnel URL: https, no credentials, no fragment. A path is
 * kept, because a prefix-stripping proxy is a legitimate deployment.
 * @param value - the candidate from the settings route or the prefs file.
 * @returns the URL when acceptable.
 */
export function readTunnelUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return undefined
  return url.hostname === '' ? undefined : value
}

/**
 * Validate one `POST /api/pocket/remote` body.
 * @param value - the parsed JSON body from the wire.
 * @returns the selection to persist when every field is acceptable.
 */
export function readRemotePrefs(value: unknown): PocketRemotePrefs | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { provider?: unknown; tunnelUrl?: unknown }
  if (candidate.provider !== 'tailscale' && candidate.provider !== 'tunnel') return undefined
  const provider: PocketProvider = candidate.provider
  if (candidate.tunnelUrl === undefined) return { provider }
  const tunnelUrl = readTunnelUrl(candidate.tunnelUrl)
  return tunnelUrl === undefined ? undefined : { provider, tunnelUrl }
}

/** The remote-transport selection, file-backed and synchronous. */
export class RemotePrefsStore {
  private prefs: PocketRemotePrefs

  /**
   * @param file - absolute path of the prefs JSON file; created on first write.
   */
  constructor(private readonly file: string) {
    this.prefs = readPrefsFile(file)
  }

  /** The current selection. */
  read(): PocketRemotePrefs {
    return this.prefs
  }

  /**
   * Replace the selection and persist it atomically.
   * @param prefs - the validated selection.
   */
  write(prefs: PocketRemotePrefs): void {
    this.prefs = prefs
    writeJsonFile(this.file, { version: 1, ...prefs })
  }
}

/** Read the file without trusting it; anything unreadable selects the default. */
function readPrefsFile(file: string): PocketRemotePrefs {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { provider: 'tailscale' }
  }
  return readRemotePrefs(parsed) ?? { provider: 'tailscale' }
}
