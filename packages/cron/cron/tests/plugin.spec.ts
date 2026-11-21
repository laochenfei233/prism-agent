import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  CronLeadership, CronServiceError, LEADER_LOCK_FILENAME,
  apply as cronApply, Config as cronConfig, inject as cronInject, name as cronName,
} from '@deepseek-ai/dsh-cron'
import type { CronJobId, CronJobRequest } from '@deepseek-ai/dsh-cron'

/** A request whose rule has an occurrence at any instant. */
const REQUEST: CronJobRequest = {
  expression: '*/5 * * * *',
  timeZone: 'UTC',
  target: { kind: 'session', sessionId: 'session-1' },
  prompt: 'check the build',
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** A fresh storage root. */
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cron-plugin-'))
  roots.push(root)
  return root
}

/** The storage stack, timer service, and Agent registry the cron plugin injects. */
async function backend(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TimerService)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
  return ctx
}

/**
 * Mount the cron plugin over a fresh storage root.
 * @param root - the storage root every context of the test shares.
 * @param lockPath - the leadership lock file.
 * @param leaderRetryMs - the takeover retry delay.
 * @returns the mounted context.
 */
async function mount(root: string, lockPath: string, leaderRetryMs = 30_000): Promise<Context> {
  const ctx = await backend(root)
  await ctx.plugin({ name: cronName, inject: cronInject, apply: cronApply, Config: cronConfig }, {
    leaderLockPath: lockPath,
    leaderRetryMs,
  })
  return ctx
}

describe('cron plugin', () => {
  it('publishes the management service and stores jobs durably', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, join(root, LEADER_LOCK_FILENAME))

    expect(ctx.get('cron')).toBeDefined()
    const job = await ctx.cron.create(REQUEST)
    expect(ctx.cron.list().map(stored => stored.id)).toEqual([job.id])
    expect(ctx.cron.get(job.id)).toEqual(job)

    // The domain persists through the backend before the write resolves, so the
    // unit document already holds the record.
    const document = await readFile(join(root, 'cron.json'), 'utf8')
    expect(document).toContain(job.id)
  })

  it('serves nothing while another live process leads, then takes over its jobs', async () => {
    const root = await freshRoot()
    const lockPath = join(root, LEADER_LOCK_FILENAME)
    const leader = await mount(root, lockPath)
    const job = await leader.cron.create(REQUEST)

    const follower = await mount(root, lockPath, 20)
    expect(() => follower.cron.list()).toThrow(CronServiceError)
    expect(() => follower.cron.list()).toThrow(/does not hold the cron scheduler lease/)

    await leader.fiber.dispose()
    contexts.splice(contexts.indexOf(leader), 1)
    // The kernel lock is released with the leader's fiber, and the follower's
    // retry opens the domain fresh — which is how it reads the leader's jobs.
    await vi.waitFor(() => {
      expect(follower.cron.list().map(stored => stored.id)).toEqual([job.id])
    }, { timeout: 5_000 })
    expect(follower.cron.get(job.id)).toEqual(job)
  })

  it('releases the lease when the plugin is disposed', async () => {
    const root = await freshRoot()
    const lockPath = join(root, LEADER_LOCK_FILENAME)
    const ctx = await mount(root, lockPath)
    await expect(ctx.cron.create(REQUEST)).resolves.toBeDefined()

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    const successor = await CronLeadership.take(lockPath)
    expect(successor).toBeDefined()
    await successor?.release()
  })

  it('records a failed run when the composed delivery cannot reach its target', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, join(root, LEADER_LOCK_FILENAME))
    const job = await ctx.cron.create(REQUEST)
    const logged: string[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logged.push(String(message.args[0])) } })

    // This composition owns no Session under the target's id and loads no
    // session persistence, so the run reaches nothing: it is recorded as failed
    // rather than as a completed delivery that delivered nothing.
    await expect(ctx.cron.runNow(job.id)).resolves.toMatchObject({ outcome: 'failed' })
    expect(logged).toContainEqual(expect.stringContaining('requires the sessionPersistence service'))
    expect(ctx.cron.get(job.id)?.recentRuns).toHaveLength(1)
    // Running now is not a firing: the stored schedule is untouched.
    expect(ctx.cron.get(job.id)?.nextDueAt).toBe(job.nextDueAt)
  })

  it('records a failed run when no composition composes the declared Session', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, join(root, LEADER_LOCK_FILENAME))
    // A new-session target needs the preset services that compose an Agent; this
    // composition mounts neither, so the run is recorded as failed rather than
    // delivered without the presets the job declared.
    const job = await ctx.cron.create({
      ...REQUEST,
      target: {
        kind: 'new-session',
        workspacePath: root,
        agentPreset: 'coding',
        permissionPreset: 'workspace-write',
      },
    })

    await expect(ctx.cron.runNow(job.id)).resolves.toMatchObject({ outcome: 'failed' })
    expect(ctx.agents.list()).toEqual([])
  })

  it('fails the load when the lock path cannot be provisioned', async () => {
    const root = await freshRoot()
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'occupied')
    const ctx = await backend(root)

    await expect(ctx.plugin(
      { name: cronName, inject: cronInject, apply: cronApply, Config: cronConfig },
      { leaderLockPath: join(blocker, LEADER_LOCK_FILENAME) },
    )).rejects.toThrow()
  })

  it('reports a stored job this build cannot schedule instead of dropping it silently', async () => {
    const root = await freshRoot()
    const id = brandString<CronJobId>('cron-1')
    // A record the durable schema admits and this build cannot turn into a
    // schedule: the expression no longer reads as a rule.
    await writeFile(join(root, 'cron.json'), `${JSON.stringify({
      unit: { name: 'cron', version: 1 },
      global: null,
      tables: {
        jobs: {
          [id]: {
            version: 1,
            id,
            expression: 'every other tuesday',
            timeZone: 'UTC',
            enabled: true,
            target: { kind: 'session', sessionId: 'session-1' },
            prompt: 'check the build',
            overlapPolicy: 'skip',
            misfirePolicy: 'skip',
            maxRunMs: 60_000,
            createdAt: 0,
            updatedAt: 0,
            nextDueAt: 0,
            recentRuns: [],
          },
        },
      },
    }, null, 2)}\n`)

    const ctx = await backend(root)
    const logged: string[] = []
    // An exporter admits messages up to its own level; the default admits INFO
    // and ERROR only, so this one asks for every level.
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logged.push(String(message.args[0])) } })
    await ctx.plugin({ name: cronName, inject: cronInject, apply: cronApply, Config: cronConfig }, {
      leaderLockPath: join(root, LEADER_LOCK_FILENAME),
      leaderRetryMs: 30_000,
    })

    await vi.waitFor(() => {
      expect(logged).toContainEqual(expect.stringContaining('cannot be scheduled'))
    }, { timeout: 2_000 })
    // The occurrence is reported, not silently moved: the stored target stands.
    expect(ctx.cron.get(id)?.nextDueAt).toBe(0)
  })
})
