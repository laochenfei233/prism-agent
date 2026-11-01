/** Git operations over a scripted runner and over a real temporary repository. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '@deepseek-ai/dsh-workspace-changes'
import type { GitRunResult } from '@deepseek-ai/dsh-workspace-changes'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  commitStaged, GitCommandError, locateRepository, parseHunks, parseStatus, readFileDiff,
  readRepositoryStatus, repositoryPath, stagePaths, unstagePaths, type GitCommandRunner,
} from '../src/git-command.ts'

// Every git command is a child process here; a loaded Windows host needs well over the default five seconds.
vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A runner that answers the scripted results in order and records the arguments. */
function scripted(...results: Array<Partial<GitRunResult>>): GitCommandRunner & { readonly calls: string[][] } {
  const calls: string[][] = []
  let at = 0
  return {
    calls,
    async run(args) {
      calls.push([...args])
      const scripted = results[at++] ?? {}
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, ...scripted }
    },
  }
}

/** One real runner over a temporary repository. */
const runner = (() => {
  let pending: Promise<GitRunner> | undefined
  return () => pending ??= (async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git', undefined, AbortSignal.timeout(30_000))
    return new GitRunner(ctx.subprocess, executable, { timeoutMs: 30_000, outputMaxBytes: 1 << 20 })
  })()
})()

/** Run git inside a fixture repository. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: 'ignore',
  })
}

/** A temporary repository with an initial commit holding one file. */
async function repository(): Promise<{ dir: string; git: GitRunner }> {
  const dir = await mkdtemp(join(tmpdir(), 'ui-sidebar-git-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const instance = await runner()
  git(dir, 'init', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-m', 'init')
  return { dir, git: instance }
}

describe('parseStatus', () => {
  it('reads both status letters and attaches a rename source', () => {
    expect(parseStatus(' M a.txt\0?? b.txt\0R  c.txt\0c-old.txt\0')).toEqual([
      { index: ' ', worktree: 'M', path: 'a.txt' },
      { index: '?', worktree: '?', path: 'b.txt' },
      { index: 'R', worktree: ' ', path: 'c.txt', origPath: 'c-old.txt' },
    ])
  })

  it('ignores empty and truncated fields, and a rename whose source field is missing', () => {
    expect(parseStatus('\0x\0')).toEqual([])
    expect(parseStatus('R  c.txt\0')).toEqual([{ index: 'R', worktree: ' ', path: 'c.txt' }])
    expect(parseStatus('R  c.txt\0\0')).toEqual([{ index: 'R', worktree: ' ', path: 'c.txt' }])
  })
})

describe('parseHunks', () => {
  it('numbers each side, defaults a missing count to one line, and keeps prefixed lines', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1 @@',
      ' one',
      '-two',
      '+TWO',
      '\\ No newline at end of file',
      '@@ -9 +8,2 @@',
      '-nine',
      '+NINE',
      '+ten',
    ].join('\n')
    expect(parseHunks(text)).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [' one', '-two', '+TWO'] },
      { oldStart: 9, oldLines: 1, newStart: 8, newLines: 2, lines: ['-nine', '+NINE', '+ten'] },
    ])
  })

  it('ignores lines before the first hunk', () => {
    expect(parseHunks('no hunk here')).toEqual([])
  })
})

describe('repositoryPath', () => {
  it('accepts a relative path inside the root and rejects escapes', () => {
    expect(repositoryPath('/repo', 'src/a.ts')).toBe('src/a.ts')
    expect(repositoryPath('/repo', '.')).toBe('.')
    for (const path of ['', '/etc/passwd', '../x', 'a/../../x', 'a\0b']) {
      expect(repositoryPath('/repo', path)).toBeUndefined()
    }
  })
})

describe('locateRepository', () => {
  it('finds the top level from a subdirectory and reports a directory outside any repository', async () => {
    const { dir, git: instance } = await repository()
    const sub = join(dir, 'src')
    await writeFile(join(dir, 'placeholder'), '')
    await mkdir(sub)
    expect(await locateRepository(instance, dir, signal)).toBe(dir)
    expect(await locateRepository(instance, sub, signal)).toBe(dir)
    const outside = await mkdtemp(join(tmpdir(), 'ui-sidebar-git-plain-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    expect(await locateRepository(instance, outside, signal)).toBeNull()
  })

  it('reports an empty top-level answer as no repository', async () => {
    expect(await locateRepository(scripted({ stdout: '\n' }), '/repo', signal)).toBeNull()
  })

  it('throws a GitCommandError for any other failure', async () => {
    await expect(locateRepository(scripted({ exitCode: 1, stderr: 'boom' }), '/repo', signal))
      .rejects.toBeInstanceOf(GitCommandError)
  })
})

describe('readRepositoryStatus', () => {
  it('reads the branch, entries, and divergence from the upstream', async () => {
    const git = scripted(
      { stdout: ' M a.txt\0' },
      { stdout: 'feature\n' },
      { stdout: '2\t3\n' },
    )
    expect(await readRepositoryStatus(git, '/repo', signal)).toEqual({
      branch: 'feature', behind: 2, ahead: 3, entries: [{ index: ' ', worktree: 'M', path: 'a.txt' }],
    })
  })

  it('omits the branch on an unborn HEAD and the counts without an upstream', async () => {
    const git = scripted({ stdout: '' }, { exitCode: 128, stderr: 'fatal: unknown revision' }, { exitCode: 128 })
    expect(await readRepositoryStatus(git, '/repo', signal)).toEqual({ entries: [] })
  })

  it('throws when git status fails', async () => {
    await expect(readRepositoryStatus(scripted({ exitCode: 128, stderr: 'fatal' }), '/repo', signal))
      .rejects.toThrow('git status failed')
  })

  it('refuses a listing whose output was truncated', async () => {
    await expect(readRepositoryStatus(scripted({ stdout: ' M a.txt\0', truncated: true }), '/repo', signal))
      .rejects.toThrow('exceeded the output cap')
  })
})

describe('readFileDiff', () => {
  it('serves hunks for a modified tracked file on both sides', async () => {
    const { dir, git: instance } = await repository()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const worktree = await readFileDiff(instance, dir, 'a.txt', 'worktree', signal)
    expect(worktree).toMatchObject({ kind: 'text', path: 'a.txt' })
    expect(worktree.kind === 'text' && worktree.hunks[0]?.lines).toEqual(['-one', '+two'])
    git(dir, 'add', 'a.txt')
    expect(await readFileDiff(instance, dir, 'a.txt', 'index', signal)).toMatchObject({ kind: 'text' })
  })

  it('reports an untracked file and a binary comparison', async () => {
    const { dir, git: instance } = await repository()
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    expect(await readFileDiff(instance, dir, 'new.txt', 'worktree', signal)).toEqual({ kind: 'untracked', path: 'new.txt' })
    await writeFile(join(dir, 'blob.bin'), Uint8Array.of(0, 1, 2))
    git(dir, 'add', 'blob.bin')
    git(dir, 'commit', '-m', 'blob')
    await writeFile(join(dir, 'blob.bin'), Uint8Array.of(0, 3, 4))
    expect(await readFileDiff(instance, dir, 'blob.bin', 'worktree', signal)).toEqual({ kind: 'binary', path: 'blob.bin' })
  })

  it('throws when git diff fails', async () => {
    const git = scripted({ stdout: ' M a.txt\0' }, { exitCode: 1, stderr: 'fatal: bad path' })
    await expect(readFileDiff(git, '/repo', 'a.txt', 'worktree', signal)).rejects.toThrow('git diff failed')
  })

  it('serves the comparison of a staged deletion instead of calling it untracked', async () => {
    const { dir, git: instance } = await repository()
    git(dir, 'rm', 'a.txt')
    const diff = await readFileDiff(instance, dir, 'a.txt', 'index', signal)
    expect(diff).toMatchObject({ kind: 'text', path: 'a.txt' })
    expect(diff.kind === 'text' && diff.hunks[0]?.lines).toEqual(['-one'])
  })

  it('throws when the per-path status read fails', async () => {
    await expect(readFileDiff(scripted({ exitCode: 128, stderr: 'fatal' }), '/repo', 'a.txt', 'worktree', signal))
      .rejects.toThrow('git status failed')
  })

  it('refuses a comparison whose output was truncated', async () => {
    const git = scripted({ stdout: ' M a.txt\0' }, { stdout: 'diff', truncated: true })
    await expect(readFileDiff(git, '/repo', 'a.txt', 'worktree', signal))
      .rejects.toThrow('exceeded the output cap')
  })
})

describe('literal pathspecs', () => {
  it('stages only the path it was handed, never a glob match', async () => {
    const { dir, git: instance } = await repository()
    for (const name of ['[ab].txt', 'a.txt', 'b.txt']) await writeFile(join(dir, name), `${name}\n`)
    await stagePaths(instance, dir, ['[ab].txt'], signal)
    const staged = (await readRepositoryStatus(instance, dir, signal)).entries
      .filter(entry => entry.index === 'A')
      .map(entry => entry.path)
    expect(staged).toEqual(['[ab].txt'])
  })
})

describe('index mutations', () => {
  it('stages and unstages a path', async () => {
    const { dir, git: instance } = await repository()
    await writeFile(join(dir, 'b.txt'), 'b\n')
    await stagePaths(instance, dir, ['b.txt'], signal)
    expect((await readRepositoryStatus(instance, dir, signal)).entries).toEqual([{ index: 'A', worktree: ' ', path: 'b.txt' }])
    await unstagePaths(instance, dir, ['b.txt'], signal)
    expect((await readRepositoryStatus(instance, dir, signal)).entries).toEqual([{ index: '?', worktree: '?', path: 'b.txt' }])
  }, 30_000)

  it('unstages through git rm --cached while HEAD is unborn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-sidebar-git-unborn-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const instance = await runner()
    git(dir, 'init', '-b', 'main')
    await writeFile(join(dir, 'first.txt'), 'first\n')
    await stagePaths(instance, dir, ['first.txt'], signal)
    await unstagePaths(instance, dir, ['first.txt'], signal)
    expect((await readRepositoryStatus(instance, dir, signal)).entries).toEqual([{ index: '?', worktree: '?', path: 'first.txt' }])
  }, 30_000)

  it('commits the staged content', async () => {
    const { dir, git: instance } = await repository()
    await writeFile(join(dir, 'c.txt'), 'c\n')
    await stagePaths(instance, dir, ['c.txt'], signal)
    await commitStaged(instance, dir, 'add c', signal)
    expect((await readRepositoryStatus(instance, dir, signal)).entries).toEqual([])
  }, 30_000)

  it('unstages through the fallback when the reset cannot resolve HEAD', async () => {
    const git = scripted({ exitCode: 1, stderr: 'fatal: ambiguous argument HEAD' }, { exitCode: 0, stdout: '' })
    await expect(unstagePaths(git, '/repo', ['a'], signal)).resolves.toBeUndefined()
  })

  it('reports each failing command as a GitCommandError', async () => {
    await expect(stagePaths(scripted({ exitCode: 1, stderr: 'add failed' }), '/repo', ['a'], signal))
      .rejects.toThrow('git add failed: add failed')
    await expect(unstagePaths(scripted({ exitCode: 1, stderr: 'reset failed' }), '/repo', ['a'], signal))
      .rejects.toThrow('git reset failed: reset failed')
    await expect(unstagePaths(scripted({ exitCode: 1, stderr: 'ambiguous argument HEAD' }, { exitCode: 1, stderr: 'rm failed' }), '/repo', ['a'], signal))
      .rejects.toThrow('git rm --cached failed: rm failed')
    await expect(commitStaged(scripted({ exitCode: 1, stderr: 'nothing to commit' }), '/repo', 'm', signal))
      .rejects.toThrow('git commit failed: nothing to commit')
  })
})
