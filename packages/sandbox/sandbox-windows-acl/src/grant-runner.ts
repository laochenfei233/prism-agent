/**
 * The windows-acl grant runner: a standalone helper the sandbox seam spawns so
 * write-grant ACL work (the potentially slow `SetNamedSecurityInfoW`
 * inheritance propagation over a large workspace tree) never executes on the
 * caller's event-loop thread. The seam awaits this child's exit instead of
 * running {@link AclWriteGrant} in-process; a wait timeout leaves the child
 * running (the ACEs land in the background and the exact-entry skip turns the
 * retry into O(1)), so the caller must never kill it mid-propagation.
 *
 * Stable argv contract (the seam builds it):
 *   grant mode (default):
 *     [node, grant-runner.js, '--workspace', <dir>, '--write-sid', <S-1-4-…>,
 *      ['--deny', <dir>]..., ['--temp', <dir>, '--temp-write-sid', <S-1-4-…-1>]]
 *   revoke mode:
 *     [node, grant-runner.js, '--revoke', '--path', <dir>, '--write-sid', <S-1-4-…>]
 *
 * Grant mode materializes the standing workspace-root ACE plus its
 * home-directory denies, and — with the temp pair — the session's revocable
 * private-temp ACE. Every apply goes through the idempotent exact-entry skip,
 * so a rerun after a partial or timed-out attempt is cheap. Revoke mode
 * removes one directory's capability-SID ACEs (the seam's temp teardown).
 *
 * Failure contract: every runner-side failure (bad args, missing directories,
 * SID/path mismatch, ACL apply errors) prints `windows-acl-grant: <detail>`
 * to stderr and exits 127 — the seam's failure rules match that signature.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/grant-runner
 */

import { existsSync, statSync } from 'node:fs'

import { revokeWrite } from './acl.ts'
import { AclWriteGrant } from './grant.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32 } from './ffi.ts'
import { assertTempRootOutsideWorkspace } from './path-boundary.ts'
import { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'

const GRANT_RUNNER_SIGNATURE = 'windows-acl-grant'
const GRANT_RUNNER_FAILURE_EXIT = 127

class GrantRunnerFailure extends Error {}

/** Print the grant-runner failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${GRANT_RUNNER_SIGNATURE}: ${detail}\n`)
  throw new GrantRunnerFailure(detail)
}

interface ParsedArgs {
  revoke: boolean
  /** Grant mode: the workspace root whose standing ACE is materialized. */
  workspace?: string
  /** Grant mode: the session's private temp directory (with its SID). */
  temp?: string
  tempWriteSid?: string
  writeSid?: string
  /** Grant mode: directories denied in front of the inherited workspace allow. */
  denyDirs: string[]
  /** Revoke mode: the directory whose capability ACEs are removed. */
  path?: string
}

function parseArgs(raw: string[]): ParsedArgs {
  const parsed: ParsedArgs = { revoke: false, denyDirs: [] }
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--revoke') {
      parsed.revoke = true
      continue
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': parsed.workspace = value; break
      case '--temp': parsed.temp = value; break
      case '--temp-write-sid': parsed.tempWriteSid = value; break
      case '--write-sid': parsed.writeSid = value; break
      case '--deny': parsed.denyDirs.push(value); break
      case '--path': parsed.path = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  return parsed
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.revoke) {
    if (parsed.path === undefined) fail('--revoke requires --path')
    if (parsed.writeSid === undefined) fail('--revoke requires --write-sid')
    if (parsed.workspace !== undefined || parsed.temp !== undefined || parsed.denyDirs.length > 0) {
      fail('--revoke accepts only --path and --write-sid')
    }
    requireDirectory('--path', parsed.path)
    const api = await win32()
    const slot = allocPtrSlot()
    if (api.convertStringSidToSidW(parsed.writeSid, slot) === 0) {
      throwLastError(api, 'ConvertStringSidToSidW', parsed.writeSid)
    }
    const sidPtr = decodePtr(slot)
    if (sidPtr === null) throwLastError(api, 'ConvertStringSidToSidW', `null SID for ${parsed.writeSid}`)
    try {
      revokeWrite(api, parsed.path, sidPtr)
    } finally {
      const freed = api.localFree(sidPtr)
      if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', 'revoke capability SID')
    }
    return 0
  }

  if (parsed.workspace === undefined) fail('missing --workspace')
  if (parsed.writeSid === undefined) fail('missing --write-sid')
  if (parsed.path !== undefined) fail('--path is only valid with --revoke')
  requireDirectory('--workspace', parsed.workspace)
  if (parsed.writeSid !== workspaceWriteSid(parsed.workspace)) {
    fail('--write-sid does not match --workspace')
  }
  if ((parsed.temp === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail('--temp and --temp-write-sid are required together')
  }
  if (parsed.temp !== undefined) {
    requireDirectory('--temp', parsed.temp)
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
    if (parsed.tempWriteSid !== tempWriteSid(parsed.temp)) {
      fail('--temp-write-sid does not match --temp')
    }
  }

  const api = await win32()
  const grant = AclWriteGrant.create(parsed.writeSid, api)
  // Deliberately no dispose(): the ACEs must SURVIVE this process — the
  // standing workspace ACE is the cross-session reuse cache, and the temp ACE
  // is revoked by a later --revoke invocation, not by this child's exit. The
  // SID allocations are reclaimed by process exit.
  grant.add(parsed.workspace, true)
  for (const denyDir of parsed.denyDirs) {
    requireDirectory('--deny', denyDir)
    grant.deny(denyDir)
  }
  if (parsed.temp !== undefined && parsed.tempWriteSid !== undefined) {
    AclWriteGrant.create(parsed.tempWriteSid, api).add(parsed.temp)
  }
  return 0
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof GrantRunnerFailure)) {
      process.stderr.write(`${GRANT_RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = GRANT_RUNNER_FAILURE_EXIT
  },
)
