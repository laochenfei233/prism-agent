/**
 * Archive-title to directory-name conversion for imports. Import never
 * overwrites, so a name that already exists at the destination is suffixed
 * rather than rejected.
 *
 * @module @prism/prism-transfer/naming
 */

import { TransferError } from './errors.ts'

/** Characters Windows forbids in path names, plus control characters. */
const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/gu

/** Windows reserved device names, matched case-insensitively and without extension. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** Longest directory name before the ` (n)` suffix budget. */
const MAXIMUM_NAME_CHARACTERS = 80

/** How many ` (n)` suffixes uniqueness probing may consume. */
const MAXIMUM_SUFFIX = 100

/**
 * Convert one manifest title into a single safe directory name.
 * @param title - untrusted manifest title.
 * @param fallback - name used when nothing survives sanitization.
 * @returns one path-safe directory name.
 */
export function sanitizeProjectDirectoryName(title: string, fallback: string): string {
  const stripped = title.replace(FORBIDDEN_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim()
  const withoutEdgeDots = stripped.replace(/[. ]+$/u, '')
  let bounded = withoutEdgeDots.slice(0, MAXIMUM_NAME_CHARACTERS)
  // Back off one UTF-16 unit when the cut splits a surrogate pair.
  const last = bounded.charCodeAt(bounded.length - 1)
  if (bounded.length === MAXIMUM_NAME_CHARACTERS && last >= 0xd800 && last <= 0xdbff) {
    bounded = bounded.slice(0, -1)
  }
  const candidate = bounded === '' ? fallback.replace(FORBIDDEN_CHARACTERS, ' ').trim() : bounded
  const safe = candidate.replace(/[. ]+$/u, '')
  if (safe === '') throw new TransferError('bad-manifest', 'project title sanitizes to an empty name')
  return RESERVED_DEVICE_NAMES.test(safe) ? `_${safe}` : safe
}

/**
 * Pick the first unused `base`, `base (2)` … `base (n)` name.
 * @param available - whether a candidate directory name is free.
 * @param base - sanitized desired name.
 * @returns an unused directory name.
 */
export function uniqueDirectoryName(available: (candidate: string) => boolean, base: string): string {
  if (available(base)) return base
  for (let suffix = 2; suffix <= MAXIMUM_SUFFIX; suffix += 1) {
    const candidate = `${base} (${String(suffix)})`
    if (available(candidate)) return candidate
  }
  throw new TransferError('path-conflict', `"${base}" and every numbered alternative already exists`)
}
