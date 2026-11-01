/** The Git workbench routes over a real temporary repository and the Connection fetch fence. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GIT_COMMIT_PATH, GIT_DIFF_PATH, GIT_STAGE_PATH, GIT_STATUS_PATH, GIT_UNSTAGE_PATH } from '../src/contract.ts'
import { GitCommandError } from '../src/git-command.ts'
import { failure, registerGitRoutes, type GitOperations, type GitRouteHost, type GitRouteRegistration } from '../src/git-routes.ts'
import { apply, type Config } from '../src/index.ts'

// Every git command is a child process here; a loaded Windows host needs well over the default five seconds.
vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const CONFIG: Config = { timeoutMs: 30_000, outputMaxBytes: 1 << 20, maxMessageBytes: 1024 }

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: 'ignore',
  })
}

interface Fixture {
  readonly dir: string
  readonly call: (path: string, init?: RequestInit) => Promise<Response>
  readonly fiber: { dispose: () => Promise<void> }
}

/**
 * Build one Host with the routes loaded.
 * @param options.cwd - the Session's working directory; `null` for no repository.
 * @param options.withoutGit - resolve a Host whose git executable is absent.
 */
async function fixture(options: { repo: boolean; withoutGit?: boolean }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ui-sidebar-git-routes-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'workspace')
  await mkdir(dir)
  if (options.repo) {
    git(dir, 'init', '-b', 'main')
    await writeFile(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-m', 'init')
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  if (options.withoutGit === true) {
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('git is not installed') },
    } as never)
  } else {
    await ctx.plugin(LocalSubprocessRuntime)
  }
  ctx.provide('sessions', { get: (id: string) => id === 'owner' ? { header: { cwd: dir } } : undefined } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({
    inject: ['connection', 'sessions', 'subprocess'],
    apply: (scope) => { apply(scope, CONFIG) },
  })
  await fiber
  const handler = connection.createSharedFetchHandler('/api')
  return {
    dir,
    fiber: { dispose: async () => { await fiber.dispose() } },
    call: (path, init) => handler.fetch(new Request(`http://localhost${path}`, init), connection.browserPeer),
  }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

describe('git status route', () => {
  it('serves the branch and the changed entries', async () => {
    const { call, dir } = await fixture({ repo: true })
    await writeFile(join(dir, 'a.txt'), 'two\n')
    await writeFile(join(dir, 'new.txt'), 'new\n')
    const response = await call(`${GIT_STATUS_PATH}?sessionId=owner`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const status = await response.json() as { root: string }
    // git reports the canonical root with forward slashes on Windows.
    expect(status.root.replaceAll('\\', '/')).toBe(dir.replaceAll('\\', '/'))
    expect(status).toMatchObject({
      available: true,
      repo: true,
      branch: 'main',
      entries: [
        { index: ' ', worktree: 'M', path: 'a.txt' },
        { index: '?', worktree: '?', path: 'new.txt' },
      ],
    })
  })

  it('reports a directory outside any repository', async () => {
    const { call } = await fixture({ repo: false })
    expect(await (await call(`${GIT_STATUS_PATH}?sessionId=owner`)).json()).toEqual({ available: true, repo: false, entries: [] })
  })

  it('reports an absent git executable', async () => {
    const { call } = await fixture({ repo: true, withoutGit: true })
    expect(await (await call(`${GIT_STATUS_PATH}?sessionId=owner`)).json()).toEqual({ available: false, repo: false, entries: [] })
  })

  it('rejects a missing or unknown Session', async () => {
    const { call } = await fixture({ repo: true })
    expect((await call(GIT_STATUS_PATH)).status).toBe(400)
    expect((await call(`${GIT_STATUS_PATH}?sessionId=`)).status).toBe(400)
    expect((await call(`${GIT_STATUS_PATH}?sessionId=other`)).status).toBe(404)
  })
})

describe('git comparison route', () => {
  it('serves the work-tree comparison of a tracked file', async () => {
    const { call, dir } = await fixture({ repo: true })
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const response = await call(`${GIT_DIFF_PATH}?sessionId=owner&path=a.txt&side=worktree`)
    expect(response.status).toBe(200)
    const diff = await response.json() as { kind: string; path: string; hunks: Array<{ lines: string[] }> }
    expect(diff).toMatchObject({ kind: 'text', path: 'a.txt' })
    expect(diff.hunks[0]?.lines).toEqual(['-one', '+two'])
  })

  it('rejects invalid coordinates, unknown Sessions, escapes, and absent repositories', async () => {
    const { call } = await fixture({ repo: true })
    expect((await call(`${GIT_DIFF_PATH}?path=a.txt&side=worktree`)).status).toBe(400)
    expect((await call(`${GIT_DIFF_PATH}?sessionId=owner&path=a.txt&side=bogus`)).status).toBe(400)
    expect((await call(`${GIT_DIFF_PATH}?sessionId=other&path=a.txt&side=worktree`)).status).toBe(404)
    expect((await call(`${GIT_DIFF_PATH}?sessionId=owner&path=../x&side=worktree`)).status).toBe(400)
    const outside = await fixture({ repo: false })
    expect((await outside.call(`${GIT_DIFF_PATH}?sessionId=owner&path=a.txt&side=worktree`)).status).toBe(404)
    const absent = await fixture({ repo: true, withoutGit: true })
    expect((await absent.call(`${GIT_DIFF_PATH}?sessionId=owner&path=a.txt&side=worktree`)).status).toBe(409)
  })
})

describe('git index routes', () => {
  it('stages and unstages one path', async () => {
    const { call, dir } = await fixture({ repo: true })
    await writeFile(join(dir, 'b.txt'), 'b\n')
    const staged = await call(GIT_STAGE_PATH, post({ sessionId: 'owner', paths: ['b.txt'] }))
    expect(staged.status).toBe(200)
    expect(await staged.json()).toMatchObject({ entries: [{ index: 'A', worktree: ' ', path: 'b.txt' }] })
    const unstaged = await call(GIT_UNSTAGE_PATH, post({ sessionId: 'owner', paths: ['b.txt'] }))
    expect(await unstaged.json()).toMatchObject({ entries: [{ index: '?', worktree: '?', path: 'b.txt' }] })
  }, 30_000)

  it('rejects malformed unstage and commit bodies before touching the repository', async () => {
    const { call } = await fixture({ repo: true })
    // A body that is not JSON at all, then JSON that is not an object.
    expect((await call(GIT_UNSTAGE_PATH, post('not json'))).status).toBe(400)
    expect((await call(GIT_UNSTAGE_PATH, post([]))).status).toBe(400)
    // An object without usable paths.
    expect((await call(GIT_UNSTAGE_PATH, post({ sessionId: 'owner' }))).status).toBe(400)
    expect((await call(GIT_COMMIT_PATH, post('not json'))).status).toBe(400)
  })

  it('rejects malformed bodies, unknown Sessions, escapes, and absent repositories', async () => {
    const { call } = await fixture({ repo: true })
    for (const body of ['not json', '[]', { sessionId: 'owner' }, { sessionId: 'owner', paths: [] }, { sessionId: 'owner', paths: [1] }]) {
      expect((await call(GIT_STAGE_PATH, post(body))).status).toBe(400)
    }
    expect((await call(GIT_STAGE_PATH, post({ sessionId: 'other', paths: ['a.txt'] }))).status).toBe(404)
    expect((await call(GIT_STAGE_PATH, post({ sessionId: 'owner', paths: ['../x'] }))).status).toBe(400)
    const outside = await fixture({ repo: false })
    expect((await outside.call(GIT_STAGE_PATH, post({ sessionId: 'owner', paths: ['a.txt'] }))).status).toBe(404)
    const absent = await fixture({ repo: true, withoutGit: true })
    expect((await absent.call(GIT_STAGE_PATH, post({ sessionId: 'owner', paths: ['a.txt'] }))).status).toBe(409)
  })

  it('commits the staged content and reports a refusal with its stderr', async () => {
    const { call, dir } = await fixture({ repo: true })
    await writeFile(join(dir, 'c.txt'), 'c\n')
    await call(GIT_STAGE_PATH, post({ sessionId: 'owner', paths: ['c.txt'] }))
    const committed = await call(GIT_COMMIT_PATH, post({ sessionId: 'owner', message: 'add c' }))
    expect(committed.status).toBe(200)
    expect(await committed.json()).toMatchObject({ repo: true, entries: [] })
    const refused = await call(GIT_COMMIT_PATH, post({ sessionId: 'owner', message: 'nothing' }))
    expect(refused.status).toBe(422)
    expect((await refused.json() as { error: string }).error).toContain('git commit failed')
  }, 30_000)

  it('rejects a missing message, an oversized message, an unknown Session, and an absent repository', async () => {
    const { call } = await fixture({ repo: true })
    expect((await call(GIT_COMMIT_PATH, post({ sessionId: 'owner' }))).status).toBe(400)
    expect((await call(GIT_COMMIT_PATH, post({ sessionId: 'owner', message: '   ' }))).status).toBe(400)
    expect((await call(GIT_COMMIT_PATH, post({ sessionId: 'owner', message: 'x'.repeat(CONFIG.maxMessageBytes + 1) }))).status).toBe(413)
    expect((await call(GIT_COMMIT_PATH, post({ sessionId: 'other', message: 'm' }))).status).toBe(404)
    const outside = await fixture({ repo: false })
    expect((await outside.call(GIT_COMMIT_PATH, post({ sessionId: 'owner', message: 'm' }))).status).toBe(404)
    const absent = await fixture({ repo: true, withoutGit: true })
    expect((await absent.call(GIT_COMMIT_PATH, post({ sessionId: 'owner', message: 'm' }))).status).toBe(409)
  })
})

describe('git route registration', () => {
  it('serves only the plugin routes and answers 404 elsewhere', async () => {
    const { call } = await fixture({ repo: true })
    expect((await call('/api/git.unknown')).status).toBe(404)
  })

  it('rejects a non-positive bound before registering anything', () => {
    expect(() => { apply(new Context(), { ...CONFIG, timeoutMs: 0 }) }).toThrow('positive integer timeoutMs')
  })
})

describe('git route failures', () => {
  it('maps a git refusal to 422 and any other failure to 500', () => {
    expect(failure(new GitCommandError('git add', 'locked')).status).toBe(422)
    expect(failure(new Error('boom')).status).toBe(500)
    expect(failure('boom').status).toBe(500)
  })

  it('answers every failing route in the form the panel shows and stops reading after disposal', async () => {
    const routes = new Map<string, GitRouteRegistration>()
    const disposers: Array<() => Promise<void>> = []
    const host: GitRouteHost = {
      effect: (dispose) => { disposers.push(dispose()) },
      cwdOf: () => '/work',
      operations: async () => ({
        locate: async () => '/repo',
        status: async () => { throw new GitCommandError('git status', 'status failed') },
        diff: async () => { throw new GitCommandError('git diff', 'diff failed') },
        stage: async () => { throw new GitCommandError('git add', 'stage failed') },
        unstage: async () => { throw new Error('unstage exploded') },
        commit: async () => { throw new GitCommandError('git commit', 'commit failed') },
      } satisfies GitOperations),
      register: (route) => { routes.set(route.path, route) },
    }
    registerGitRoutes(host, CONFIG)
    const call = async (path: string, query = '', init?: RequestInit): Promise<Response> =>
      routes.get(path)!.fetch(new Request(`http://localhost${path}${query}`, init))
    expect((await call(GIT_STATUS_PATH, '?sessionId=owner')).status).toBe(422)
    expect((await call(GIT_DIFF_PATH, '?sessionId=owner&path=a.txt&side=worktree')).status).toBe(422)
    expect((await call(GIT_STAGE_PATH, '', post({ sessionId: 'owner', paths: ['a.txt'] }))).status).toBe(422)
    expect((await call(GIT_UNSTAGE_PATH, '', post({ sessionId: 'owner', paths: ['a.txt'] }))).status).toBe(500)
    expect((await call(GIT_COMMIT_PATH, '', post({ sessionId: 'owner', message: 'm' }))).status).toBe(422)
    for (const dispose of disposers) await dispose()
  })
})