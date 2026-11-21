/**
 * windows-acl grant ownership through the real LocalSandboxProvider: one
 * standing capability per workspace plus one random, distinct, revocable
 * temp capability per live session/workspace pair, each materialized by a
 * grant-runner helper child (the Win32 ACL work itself is covered by
 * sandbox-windows-acl's real-FFI suites; this spec drives a fake child that
 * records its argv, so the spawn, memoization, timeout, and teardown
 * contracts hold on every platform).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

/**
 * The fake grant runner: argv `[node, fake.mjs, LOG, BEHAVIOR, ...forwarded]`.
 * Every run records the forwarded argv first; `fail` then prints the failure
 * signature and exits 127; `hang` exits late, so the test observes both the
 * abandoned wait and the untouched child settling.
 */
const FAKE_GRANT_RUNNER = `
import { appendFileSync } from 'node:fs'
const [log, behavior] = process.argv.slice(2, 4)
const forwarded = process.argv.slice(4)
appendFileSync(log, JSON.stringify(forwarded) + '\\n')
if (behavior === 'fail') {
  process.stderr.write('windows-acl-grant: exploded\\n')
  process.exit(127)
}
if (behavior === 'hang') await new Promise(resolve => setTimeout(resolve, 5000))
`

interface Setup {
  ctx: Context
  sandbox: LocalSandboxProvider
  /** Disposes the provider exactly once, however many callers await it. */
  dispose: () => Promise<void>
  log: string
  setBehavior: (behavior: 'ok' | 'fail' | 'hang') => void
}

/** Directories every test leaves behind, removed after each test. */
const cleanupDirs: string[] = []

async function setup(config: { grantTimeoutMs?: number } = {}): Promise<Setup> {
  const ctx = new Context()
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acl-grants-test-')))
  cleanupDirs.push(scratch)
  const log = join(scratch, 'grant-log.jsonl')
  const script = join(scratch, 'fake-grant-runner.mjs')
  writeFileSync(script, FAKE_GRANT_RUNNER)
  const fiber = await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = {
    platform: 'win32',
    windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'],
    windowsAclGrantRunnerArgs: [process.execPath, script, log, 'ok'],
  }
  let disposed = false
  return {
    ctx, sandbox, log,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await fiber.dispose()
    },
    setBehavior: (behavior) => {
      sandbox.internals = { ...sandbox.internals, windowsAclGrantRunnerArgs: [process.execPath, script, log, behavior] }
    },
  }
}

function workspaceRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acl-grants-ws-')))
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

function loggedInvocations(log: string): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
}

describe('windows-acl write grants (LocalSandboxProvider)', () => {
  const scratch: string[] = []

  afterEach(() => {
    for (const dir of [...scratch.splice(0), ...cleanupDirs.splice(0)]) rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('does not spawn a grant runner for a cancelled confinement request', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const reason = new Error('cancel before grant creation')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('cancelled'),
      }, AbortSignal.abort(reason))).rejects.toBe(reason)
      expect(loggedInvocations(log)).toEqual([])
    } finally { await dispose() }
  })

  it('workspace-write spawns one grant runner per pair covering workspace and temp, then reuses both', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-1') }

      const confined = await sandbox.confine(['pwsh', '/Command', 'x'], policy)
      const tempDir = flag(confined.argv, '--temp')
      const tempSid = flag(confined.argv, '--temp-write-sid')
      expect(tempDir).toBeDefined()
      expect(basename(tempDir ?? '')).toMatch(/^dsh-[A-Za-z0-9_-]{6}$/u)
      expect(tempSid).toBe(tempWriteSid(tempDir ?? ''))
      expect(tempSid).not.toBe(workspaceWriteSid(ws))
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tempDir,
        '--mode', 'workspace-write',
        '--write-sid', workspaceWriteSid(ws),
        '--temp-write-sid', tempSid,
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(loggedInvocations(log)).toEqual([[
        '--workspace', ws,
        '--write-sid', workspaceWriteSid(ws),
        '--temp', tempDir,
        '--temp-write-sid', tempSid,
      ]])
      expect(existsSync(tempDir ?? '')).toBe(true)

      expect((await sandbox.confine(['pwsh', '/Command', 'x'], policy)).argv).toEqual(confined.argv)
      expect(loggedInvocations(log)).toHaveLength(1)
      expect(existsSync(tempDir ?? '')).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('denies the harness home inside the workspace and passes no deny outside it', async () => {
    const inside = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const home = join(ws, '.prism')
      mkdirSync(home, { recursive: true })
      vi.stubEnv('DSH_HOME', home)
      const confined = await inside.sandbox.confine(['pwsh', '/Command', 'x'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-home'),
      })
      expect(confined.argv).not.toContain('--deny') // the deny travels to the grant runner, not the confinement runner
      const invocation = loggedInvocations(inside.log)[0] ?? []
      expect(invocation).toContain('--deny')
      expect(flag(invocation, '--deny')).toBe(realpathSync.native(home))
    } finally {
      await inside.dispose()
    }

    const outside = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      vi.stubEnv('DSH_HOME', join(outsideTempWorkspaceParent(), 'dsh-home-outside-acl'))
      await outside.sandbox.confine(['pwsh', '/Command', 'x'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-outside'),
      })
      expect(loggedInvocations(outside.log)[0]).not.toContain('--deny')
    } finally {
      await outside.dispose()
    }
  })

  it('read-only materializes no capability; upgrade creates one and downgrade leaves it reusable', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: SessionId('switch') }
      const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('switch') }

      expect((await sandbox.confine(['true'], readOnly)).argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tmpdir(),
        '--mode', 'read-only',
        '--',
        'true',
      ])
      expect(loggedInvocations(log)).toEqual([])

      const upgraded = await sandbox.confine(['true'], workspaceWrite)
      expect(flag(upgraded.argv, '--temp-write-sid')).not.toBe(workspaceWriteSid(ws))
      expect(loggedInvocations(log)).toHaveLength(1)
      await sandbox.confine(['true'], readOnly)
      expect(loggedInvocations(log)).toHaveLength(1)
      expect((await sandbox.confine(['true'], workspaceWrite)).argv).toEqual(upgraded.argv)
      expect(loggedInvocations(log)).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('a fresh provider gives a resumed session a new temp path and SID, so crash residue cannot collide', async () => {
    const first = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('resumed') }
      const firstConfined = await first.sandbox.confine(['true'], policy)
      const firstTemp = flag(firstConfined.argv, '--temp') ?? ''

      // The first provider remains live: model an unclean prior process whose
      // temp directory and ACE survived. A new provider must still proceed.
      const second = await setup()
      const secondConfined = await second.sandbox.confine(['true'], policy)
      const secondTemp = flag(secondConfined.argv, '--temp') ?? ''
      expect(secondTemp).not.toBe(firstTemp)
      expect(flag(secondConfined.argv, '--temp-write-sid')).not.toBe(flag(firstConfined.argv, '--temp-write-sid'))
      expect(existsSync(firstTemp)).toBe(true)
      expect(existsSync(secondTemp)).toBe(true)
      await second.dispose()
    } finally {
      await first.dispose()
    }
  })

  it('forks and workspace changes receive distinct temp capabilities, one grant spawn per pair', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const wsA = workspaceRoot()
      const wsB = workspaceRoot()
      scratch.push(wsA, wsB)
      const parent = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('parent') })
      const child = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('child') })
      const moved = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsB, sessionId: SessionId('parent') })

      expect(flag(child.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(flag(child.argv, '--temp-write-sid')).not.toBe(flag(parent.argv, '--temp-write-sid'))
      expect(flag(moved.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(loggedInvocations(log)).toHaveLength(3)
      expect(flag(loggedInvocations(log)[2] ?? [], '--workspace')).toBe(wsB)
    } finally {
      await dispose()
    }
  })

  it('a failing grant child fails closed with the seam error, removes the temp dir, and the retry respawns', async () => {
    const { sandbox, dispose, log, setBehavior } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      setBehavior('fail')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('fail'),
      })).rejects.toThrow(SandboxUnavailableError)
      // The memo was dropped: the retry spawns a fresh child.
      setBehavior('ok')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('fail'),
      })).resolves.toBeDefined()
      expect(loggedInvocations(log)).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('an expired grant wait fails the command fast, leaves the child to land the ACEs, and the retry respawns', async () => {
    const { sandbox, dispose, log, setBehavior } = await setup({ grantTimeoutMs: 300 })
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      setBehavior('hang')
      let heartbeat = 0
      const heartbeats = setInterval(() => { heartbeat += 1 }, 20)
      const started = Date.now()
      try {
        await expect(sandbox.confine(['true'], {
          mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('timeout'),
        })).rejects.toThrow(/still running in the background/u)
        expect(Date.now() - started).toBeLessThan(2000)
        expect(heartbeat).toBeGreaterThan(2) // the event loop kept ticking while the child ran
      } finally {
        clearInterval(heartbeats)
      }

      // The abandoned child is untouched: it settles and records its argv.
      await vi.waitFor(() => { expect(loggedInvocations(log)).toHaveLength(1) }, { timeout: 8000 })
      // The dropped memo means the retry spawns a fresh (fast) child.
      setBehavior('ok')
      await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('timeout') })
      expect(loggedInvocations(log)).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('rejects a workspace containing the ambient temp root before any grant runner spawns', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: realpathSync.native(tmpdir()), sessionId: SessionId('overlap'),
      })).rejects.toThrow(/temp root must be outside the workspace/u)
      expect(loggedInvocations(log)).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('a failing temp grant removes the random directory and aggregates the removal failure', async () => {
    const { sandbox, dispose, setBehavior } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      setBehavior('fail')
      sandbox.internals.rmTempDir = () => { throw new Error('temp rm exploded') }
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('rm-fail'),
      })).rejects.toThrow(/temp grant materialization failed and its cleanup also failed/u)
    } finally {
      await dispose()
    }
  })

  it('agentless calls pass a temp root and no capabilities; the runner owns the private child lifecycle', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const confined = await sandbox.confine(['pwsh', '/Command', 'x'], { mode: 'workspace-write', workspaceRoot: '/ws' })
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', '/ws',
        '--temp', tmpdir(),
        '--mode', 'workspace-write',
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(loggedInvocations(log)).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('agentless workspace-write passes the nested home denial to the runner', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const home = join(ws, '.prism')
      mkdirSync(home, { recursive: true })
      vi.stubEnv('DSH_HOME', home)
      const confined = await sandbox.confine(['pwsh', '/Command', 'x'], { mode: 'workspace-write', workspaceRoot: ws })
      const at = confined.argv.indexOf('--deny')
      expect(at).toBeGreaterThan(-1)
      expect(confined.argv[at + 1]).toBe(realpathSync.native(home))
      expect(confined.argv).not.toContain('--write-sid')
      expect(loggedInvocations(log)).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('provider teardown revokes each temp capability through the child and removes its directory', async () => {
    const { sandbox, dispose, log } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const confined = await sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('dispose'),
      })
      const tempDir = flag(confined.argv, '--temp') ?? ''
      const tempSid = flag(confined.argv, '--temp-write-sid') ?? ''

      await dispose()
      expect(loggedInvocations(log).at(-1)).toEqual(['--revoke', '--path', tempDir, '--write-sid', tempSid])
      expect(existsSync(tempDir)).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('provider teardown reports revoke and removal failures without aborting teardown', async () => {
    const { ctx, sandbox, dispose, setBehavior } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const confined = await sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('dispose'),
      })
      const tempDir = flag(confined.argv, '--temp') ?? ''
      setBehavior('fail')
      sandbox.internals.rmTempDir = () => { throw new Error('rm exploded') }
      const reported: unknown[] = []
      vi.spyOn(ctx.logger, 'warn').mockImplementation((entry) => { reported.push(entry) })

      await dispose()
      expect(reported.some(entry => typeof entry === 'string' && entry.includes('cleanup completed with 2 failure(s)'))).toBe(true)
      const messages = reported.flatMap(entry => entry instanceof Error ? [entry.message] : [])
      expect(messages).toContainEqual(expect.stringContaining('exited with code 127'))
      expect(messages).toContainEqual(expect.stringContaining('rm exploded'))
      expect(existsSync(tempDir)).toBe(true) // the injected removal failed; the directory stays for temp hygiene
    } finally {
      await dispose()
    }
  })
})
