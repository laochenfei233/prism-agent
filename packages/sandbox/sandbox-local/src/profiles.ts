/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * The harness home holds composition the host loads as code, so no writable
 * profile may grant it even when the workspace contains it. Seatbelt and bwrap
 * express the exclusion directly; Landlock is an allow-list and must refuse the
 * policy instead of granting the tree.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SandboxUnavailableError, canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Compare canonical paths with the host's case convention. */
function comparable(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Whether a canonical path is `root` or lies beneath it.
 * @param path - candidate path.
 * @param root - containment root.
 * @returns whether the path is contained.
 */
export function isWithin(path: string, root: string): boolean {
  const target = comparable(canonicalPath(path))
  const base = comparable(canonicalPath(root))
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Harness-home roots a `workspace-write` policy would otherwise grant through
 * one of its writable roots. Outside that overlap the ordinary read-only bind
 * or deny already covers the home.
 * @param policy - file-effect policy to inspect.
 * @returns canonical protected roots inside a writable root; empty for other modes.
 */
export function protectedRootsWithin(policy: SandboxPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const home = canonicalPath(resolveDshHome())
  return writableRoots(policy).some(root => isWithin(home, root)) ? [home] : []
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    // A later mount wins over the workspace bind, so the home stays read-only
    // inside a workspace that contains it.
    for (const root of protectedRootsWithin(policy)) {
      if (existsSync(root)) args.push('--ro-bind', root, root)
    }
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 * @throws {SandboxUnavailableError} when the policy would grant the harness home,
 *   which an allow-list backend cannot exclude.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  if (protectedRootsWithin(policy).length > 0) {
    throw new SandboxUnavailableError(
      policy.mode,
      'Landlock cannot exclude the harness home from the writable workspace; move DSH_HOME outside the workspace or install bubblewrap',
    )
  }
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart. A `deny` rule wins
 * over the allows, so the home is refused even when it lies inside a granted
 * root.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  const protectedRoots = protectedRootsWithin(policy)
  if (protectedRoots.length > 0) {
    forms.push(`(deny file-write* ${protectedRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
