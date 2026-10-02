import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CronLeadership, LEADER_LOCK_FILENAME } from '@deepseek-ai/dsh-cron'

const roots: string[] = []
const held: CronLeadership[] = []

afterEach(async () => {
  await Promise.allSettled(held.splice(0).map(leadership => leadership.release()))
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A fresh directory plus the lock path inside it, created when absent. */
async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-lease-'))
  roots.push(dir)
  return join(dir, LEADER_LOCK_FILENAME)
}

async function take(path: string): Promise<CronLeadership> {
  const leadership = await CronLeadership.take(path)
  expect(leadership).toBeDefined()
  held.push(leadership as CronLeadership)
  return leadership as CronLeadership
}

describe('CronLeadership', () => {
  it('creates the scheduler directory a lock inside it needs', async () => {
    // The directory does not exist yet, so taking the lock is what creates it.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-lease-'))
    roots.push(dir)
    const path = join(dir, 'scheduler', LEADER_LOCK_FILENAME)
    await take(path)
    expect(existsSync(dirname(path))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('creates the lock file on POSIX', async () => {
    // Windows holds a named kernel semaphore instead, which leaves no file.
    const path = await lockPath()
    await take(path)
    expect(existsSync(path)).toBe(true)
  })

  it('refuses a second holder without waiting', async () => {
    const path = await lockPath()
    await take(path)
    await expect(CronLeadership.take(path)).resolves.toBeUndefined()
  })

  it('admits a successor once the leader releases', async () => {
    const path = await lockPath()
    const first = await CronLeadership.take(path)
    await first?.release()
    await take(path)
  })

  it('treats release as idempotent', async () => {
    const path = await lockPath()
    const leadership = await take(path)
    await leadership.release()
    await leadership.release()
    await expect(CronLeadership.take(path)).resolves.toBeDefined()
  })

  it('propagates a failure that is not contention', async () => {
    // A lock path under a regular file cannot be created, and that is a real
    // failure rather than "another process is the leader". Which code the
    // platform reports for it differs, so the assertion names both.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-lease-'))
    roots.push(dir)
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x')
    await expect(CronLeadership.take(join(blocker, LEADER_LOCK_FILENAME)))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/) as string })
  })
})
