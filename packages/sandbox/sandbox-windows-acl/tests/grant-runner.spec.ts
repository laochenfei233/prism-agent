/**
 * The grant runner's argv contract against the REAL directory DACL (observed
 * through icacls, the operator's own tool): grant mode materializes the
 * standing workspace ACE plus its deny and the revocable temp ACE
 * idempotently, revoke mode removes exactly the temp ACE, and every
 * runner-side failure prints the signature and exits 127. Win32-only, like
 * the other real-FFI suites.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { tempWriteSid, workspaceWriteSid } from '../src/workspace-sid.ts'

const isWin32 = process.platform === 'win32'

const GRANT_RUNNER_ENTRY = fileURLToPath(new URL('../src/grant-runner.ts', import.meta.url))

function runGrantRunner(args: readonly string[], timeout = 60_000): {
  status: number | null
  stderr: string
} {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', GRANT_RUNNER_ENTRY, ...args], {
    timeout,
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr ?? '' }
}

function workspaceDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-grant-runner-ws-'))
}

function aclOf(path: string): string {
  const probe = spawnSync('icacls', [path], { encoding: 'utf8' })
  return probe.stdout ?? ''
}

describe.skipIf(!isWin32)('windows-acl grant runner', () => {
  const scratch: string[] = []

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const makeTempCapability = (): { temp: string; tempSid: string } => {
    const temp = mkdtempSync(join(tmpdir(), 'dsh-grant-runner-tmp-'))
    scratch.push(temp)
    return { temp, tempSid: tempWriteSid(temp) }
  }

  it('grant mode materializes the standing workspace ACE and the Low label, idempotently', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const writeSid = workspaceWriteSid(workspace)

    const first = runGrantRunner(['--workspace', workspace, '--write-sid', writeSid])
    expect(first.status).toBe(0)
    const acl = aclOf(workspace)
    expect(acl).toContain(`${writeSid}:(OI)(CI)(W,D,DC)`)
    expect(acl).toContain('Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)')

    // The rerun exercises the exact-entry skip: cheap, and still exit 0.
    const second = runGrantRunner(['--workspace', workspace, '--write-sid', writeSid])
    expect(second.status).toBe(0)
  })

  it('grant mode pins a harness home inside the workspace with a deny', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const home = join(workspace, '.prism')
    mkdirSync(home)
    const writeSid = workspaceWriteSid(workspace)

    const result = runGrantRunner(['--workspace', workspace, '--write-sid', writeSid, '--deny', home])
    expect(result.status).toBe(0)
    expect(aclOf(home)).toContain(`${writeSid}:(OI)(CI)(DENY)(W,D,DC)`)
  })

  it('grant mode pairs the temp directory with its own revocable capability', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const { temp, tempSid } = makeTempCapability()
    const writeSid = workspaceWriteSid(workspace)

    const result = runGrantRunner([
      '--workspace', workspace, '--write-sid', writeSid,
      '--temp', temp, '--temp-write-sid', tempSid,
    ])
    expect(result.status).toBe(0)
    expect(aclOf(temp)).toContain(`${tempSid}:(OI)(CI)(W,D,DC)`)
    expect(aclOf(temp)).not.toContain(writeSid)
  })

  it('revoke mode removes the temp capability and clears the label it was alone in naming', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const { temp, tempSid } = makeTempCapability()
    const writeSid = workspaceWriteSid(workspace)

    expect(runGrantRunner([
      '--workspace', workspace, '--write-sid', writeSid,
      '--temp', temp, '--temp-write-sid', tempSid,
    ]).status).toBe(0)
    expect(aclOf(temp)).toContain(tempSid)

    const revoked = runGrantRunner(['--revoke', '--path', temp, '--write-sid', tempSid])
    expect(revoked.status).toBe(0)
    expect(aclOf(temp)).not.toContain(tempSid)
    expect(aclOf(temp)).not.toContain('Low Mandatory Level')
  })

  it('a capability SID that does not match its directory fails with the signature and exit 127', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const result = runGrantRunner(['--workspace', workspace, '--write-sid', 'S-1-4-1-2'])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('windows-acl-grant: ')
  })

  it('unknown arguments and revoked-mode extras fail with the signature and exit 127', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const unknown = runGrantRunner(['--workspace', workspace, '--write-sid', workspaceWriteSid(workspace), '--frobnicate', 'x'])
    expect(unknown.status).toBe(127)
    expect(unknown.stderr).toContain('windows-acl-grant: ')

    const extras = runGrantRunner(['--revoke', '--path', workspace, '--write-sid', workspaceWriteSid(workspace), '--deny', workspace])
    expect(extras.status).toBe(127)
    expect(extras.stderr).toContain('windows-acl-grant: ')
  })

  it('a missing directory fails with the signature and exit 127', () => {
    const missing = join(workspaceDir(), 'absent')
    const result = runGrantRunner(['--workspace', missing, '--write-sid', workspaceWriteSid(missing)])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('windows-acl-grant: ')
  })

  it('revoke mode rejects grant-mode flags', () => {
    const workspace = workspaceDir()
    scratch.push(workspace)
    const result = runGrantRunner([
      '--revoke', '--path', workspace, '--write-sid', workspaceWriteSid(workspace),
      '--temp', tmpdir(),
    ])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('windows-acl-grant: ')
  })
})
