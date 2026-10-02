/**
 * Host scheduled-task Remote owner: the management writes, their stable
 * refusals, and the follow generations a browser consumes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  CronExpressionError,
  CronService,
  CronServiceError,
  parseCronExpression,
} from '@deepseek-ai/dsh-cron'
import type { CronJob, CronJobId, CronRunRecord } from '@deepseek-ai/dsh-cron'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import CronController from '../src/index.ts'
import { CronCommands } from '../src/commands.ts'
import { CronFeed, cronJobView } from '../src/feed.ts'
import type { CronFollowBaseline, CronFollowFrame, CronViewCreateRequest } from '../src/types.ts'

const roots: Context[] = []

/** An identity no case stores, stated as the wire's own opaque identity type. */
const missingId = brandString<CronJobId>('missing')

/** The identity whose frame ends one bounded collection in {@link framesAfter}. */
const SENTINEL = brandString<CronJobId>('sentinel')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * One stored task, varying only the fields a case states.
 * @param overrides - the fields this fixture varies.
 * @returns the record.
 */
function cronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: brandString<CronJobId>('cron-1'),
    expression: '0 9 * * *',
    timeZone: 'UTC',
    enabled: true,
    target: { kind: 'session', sessionId: 'session-1' },
    prompt: 'check the build',
    overlapPolicy: 'skip',
    misfirePolicy: 'skip',
    maxRunMs: 1_000,
    createdAt: 0,
    updatedAt: 0,
    nextDueAt: 32_400_000,
    recentRuns: [],
    ...overrides,
  }
}

/** One bounded run record. */
function run(outcome: CronRunRecord['outcome'] = 'completed'): CronRunRecord {
  return { startedAt: 10, finishedAt: 20, outcome }
}

/**
 * The capability under test: the real expression and zone domain over an
 * in-memory table, with leadership switchable so a spec can put the process
 * outside the scheduler without a second process.
 */
class FakeCron extends CronService {
  readonly rows = new Map<CronJobId, CronJob>()
  /** Whether this process holds the scheduler lease. */
  leading = true
  /** Set to make `runNow` answer with a run already in flight. */
  running = false
  /** Set to make any verb fail with a failure the closed code set does not describe. */
  failing: Error | undefined
  private next = 0

  list(): readonly CronJob[] {
    this.requireLeader()
    return [...this.rows.values()]
  }

  get(id: CronJobId): CronJob | undefined {
    this.requireLeader()
    return this.rows.get(id)
  }

  async create(request: Parameters<CronService['create']>[0]): Promise<CronJob> {
    this.requireLeader()
    const rule = this.resolve(request.expression, request.timeZone)
    const now = 100
    this.next += 1
    const job = cronJob({
      id: brandString<CronJobId>(`cron-${this.next}`),
      expression: request.expression,
      timeZone: rule,
      target: request.target,
      prompt: request.prompt,
      overlapPolicy: request.overlapPolicy ?? 'skip',
      misfirePolicy: request.misfirePolicy ?? 'skip',
      maxRunMs: request.maxRunMs ?? 5_000,
      createdAt: now,
      updatedAt: now,
    })
    this.rows.set(job.id, job)
    return job
  }

  async update(id: CronJobId, update: Parameters<CronService['update']>[1]): Promise<CronJob> {
    this.requireLeader()
    const current = this.rows.get(id)
    if (current === undefined) throw new CronServiceError('cron_not_found', `no cron job is stored under '${id}'`)
    const expression = update.expression ?? current.expression
    const timeZone = update.timeZone ?? current.timeZone
    const next: CronJob = {
      ...current,
      expression,
      timeZone: this.resolve(expression, timeZone),
      enabled: update.enabled ?? current.enabled,
      target: update.target ?? current.target,
      prompt: update.prompt ?? current.prompt,
      overlapPolicy: update.overlapPolicy ?? current.overlapPolicy,
      misfirePolicy: update.misfirePolicy ?? current.misfirePolicy,
      maxRunMs: update.maxRunMs ?? current.maxRunMs,
      updatedAt: 200,
    }
    this.rows.set(id, next)
    return next
  }

  async remove(id: CronJobId): Promise<boolean> {
    this.requireLeader()
    return this.rows.delete(id)
  }

  async runNow(id: CronJobId): Promise<CronRunRecord> {
    this.requireLeader()
    if (!this.rows.has(id)) throw new CronServiceError('cron_not_found', `no cron job is stored under '${id}'`)
    if (this.running) throw new CronServiceError('cron_run_in_progress', `cron job '${id}' already has a run in flight`)
    return run()
  }

  private requireLeader(): void {
    if (this.failing !== undefined) throw this.failing
    if (!this.leading) throw new CronServiceError('cron_not_leader', 'this process does not hold the cron scheduler lease')
  }

  private resolve(expression: string, timeZone: string): string {
    try {
      parseCronExpression(expression)
    } catch (error: unknown) {
      throw new CronServiceError('cron_invalid_expression', (error as CronExpressionError).message)
    }
    const canonical = canonicalClientTimeZone(timeZone)
    if (canonical === undefined) {
      throw new CronServiceError('cron_invalid_time_zone', `'${timeZone}' is not an IANA zone this platform resolves`)
    }
    return canonical
  }
}

/** A Host context carrying the fake capability and a Remote-ready controller. */
function bench(): { ctx: Context; cron: FakeCron; controller: CronController; commands: CronCommands } {
  const ctx = new Context()
  roots.push(ctx)
  const cron = new FakeCron(ctx)
  // Constructing the controller is its registration: the Cordis Service base
  // publishes it under its own key through the owning fiber.
  const controller = new CronController(ctx)
  return { ctx, cron, controller, commands: new CronCommands(ctx) }
}

/** The request every create case starts from. */
function createRequest(overrides: Partial<CronViewCreateRequest> = {}): CronViewCreateRequest {
  return {
    expression: '0 9 * * 1-5',
    timeZone: 'Europe/Berlin',
    target: {
      kind: 'new-session',
      workspacePath: '/work',
      agentPreset: 'default',
      permissionPreset: 'ask',
      model: null,
    },
    prompt: 'run the report',
    ...overrides,
  }
}

/** Read the next frame of one generation, refusing a stream that ended early. */
async function nextFrame(iterator: AsyncIterator<CronFollowFrame>): Promise<CronFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('scheduled-task stream ended before the expected frame')
  return next.value
}

/** Emit one committed domain change, the way the storage domain does after durability. */
function emitChange(ctx: Context, change: Partial<DomainChanged> & { readonly operation: 'put' | 'deleted' }): void {
  ctx.emit('domain/changed', {
    domain: 'cron',
    table: 'jobs',
    key: '',
    ...change,
  } as DomainChanged)
}

/**
 * Collect every frame one generation delivers for a synchronous commit.
 *
 * A follow generation stays open by design, so a bounded read needs a definite
 * last frame: after the action's own writes this emits one sentinel commit and
 * reads until that sentinel arrives. An action that publishes nothing therefore
 * yields an empty list instead of a read that never settles.
 * @param ctx - the Host context whose domain events the feed observes.
 * @param iterator - the open generation.
 * @param act - the synchronous action that commits the writes under test.
 * @returns the frames that action produced, in order, excluding the sentinel.
 */
async function framesAfter(
  ctx: Context,
  iterator: AsyncIterator<CronFollowFrame>,
  act: () => void,
): Promise<CronFollowFrame[]> {
  act()
  emitChange(ctx, {
    key: String(SENTINEL),
    operation: 'put',
    value: cronJob({ id: SENTINEL, prompt: 'sentinel' }),
  })
  const collected: CronFollowFrame[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) return collected
    if (next.value.type === 'upsert' && next.value.job.jobId === SENTINEL) return collected
    collected.push(next.value)
  }
}

describe('CronController management verbs', () => {
  it('stores a stated task and answers with its decoded projection', async () => {
    const { controller } = bench()
    const created = await controller.create(createRequest())
    expect(created.job).toMatchObject({
      jobId: 'cron-1',
      expression: '0 9 * * 1-5',
      timeZone: 'Europe/Berlin',
      enabled: true,
      prompt: 'run the report',
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
      maxRunMs: 5_000,
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: null,
      },
    })
  })

  it('carries every stated field and its own run ceiling into the capability', async () => {
    const { controller, cron } = bench()
    await controller.create(createRequest({
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: { provider: 'deepseek', model: 'chat' },
      },
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      maxRunMs: 2_500,
    }))
    const stored = [...cron.rows.values()][0]
    expect(stored).toMatchObject({
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      maxRunMs: 2_500,
      target: { model: { provider: 'deepseek', model: 'chat' } },
    })
  })

  it('replaces only the stated fields of one task', async () => {
    const { controller, cron } = bench()
    const created = await controller.create(createRequest())
    expect(cron.rows.get(created.job.jobId)).toBeDefined()

    const updated = await controller.update({ jobId: created.job.jobId, prompt: 'run the report again' })
    expect(updated.job).toMatchObject({ prompt: 'run the report again', expression: '0 9 * * 1-5' })
    expect(updated.job.jobId).toBe(created.job.jobId)

    const target = {
      kind: 'session' as const,
      sessionId: 'session-9',
    }
    const retargeted = await controller.update({ jobId: created.job.jobId, target, enabled: false, maxRunMs: 750 })
    expect(retargeted.job).toMatchObject({ target: { kind: 'session', sessionId: 'session-9' }, enabled: false, maxRunMs: 750 })

    // The two policies are stated fields like any other, so an edit can carry
    // them, and an edit that states none leaves the stored ones in place.
    const repolicied = await controller.update({
      jobId: created.job.jobId,
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
    })
    expect(repolicied.job).toMatchObject({ overlapPolicy: 'queue-one', misfirePolicy: 'run-once-late' })
    const untouched = await controller.update({ jobId: created.job.jobId, prompt: 'unchanged policies' })
    expect(untouched.job).toMatchObject({ overlapPolicy: 'queue-one', misfirePolicy: 'run-once-late' })
  })

  it('changes the rule of one task and re-derives what it means', async () => {
    const { controller, cron } = bench()
    const created = await controller.create(createRequest())
    const revised = await controller.update({
      jobId: created.job.jobId,
      expression: '*/30 * * * *',
      timeZone: 'Asia/Tokyo',
    })
    expect(revised.job).toMatchObject({ expression: '*/30 * * * *', timeZone: 'Asia/Tokyo' })
    expect(cron.rows.get(created.job.jobId)).toMatchObject({
      expression: '*/30 * * * *',
      timeZone: 'Asia/Tokyo',
    })
  })

  it('refuses a run ceiling that is not a whole positive number of milliseconds', async () => {
    const { commands } = bench()
    await expect(commands.create(createRequest({ maxRunMs: 1.5 })))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(commands.create(createRequest({ maxRunMs: Number.NaN })))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(commands.update({ jobId: missingId, maxRunMs: 0.5 }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('answers a removal refused after the read as a missing task', async () => {
    const { controller, cron } = bench()
    const created = await controller.create(createRequest())
    // Another writer can remove the row between this controller's read and its
    // removal, so the lost race is reported as the missing task it now is.
    const remove = vi.spyOn(cron, 'remove').mockResolvedValueOnce(false)
    await expect(controller.delete({ jobId: created.job.jobId }))
      .rejects.toMatchObject({ code: 'cron/not-found' })
    remove.mockRestore()
  })

  it('removes one task and answers with the row it showed', async () => {
    const { controller } = bench()
    const created = await controller.create(createRequest())
    await expect(controller.delete({ jobId: created.job.jobId }))
      .resolves.toMatchObject({ job: { jobId: created.job.jobId } })
    await expect(controller.delete({ jobId: created.job.jobId }))
      .rejects.toMatchObject({ code: 'cron/not-found' })
  })

  it('runs one task once without changing its stored schedule', async () => {
    const { controller, cron } = bench()
    const created = await controller.create(createRequest())
    await expect(controller.runNow({ jobId: created.job.jobId }))
      .resolves.toEqual({ run: run() })
    expect(cron.rows.get(created.job.jobId)).toMatchObject({ nextDueAt: 32_400_000 })
    await expect(controller.runNow({ jobId: missingId }))
      .rejects.toMatchObject({ code: 'cron/not-found' })
  })

  it('maps every declared capability refusal to its stable Remote code', async () => {
    const { controller, cron, commands } = bench()
    await expect(controller.create(createRequest({ expression: 'not a rule' })))
      .rejects.toMatchObject({ code: 'cron/invalid-expression' })
    await expect(controller.create(createRequest({ timeZone: 'Mars/Olympus' })))
      .rejects.toMatchObject({ code: 'cron/invalid-time-zone' })
    await expect(controller.update({ jobId: missingId, prompt: 'x' }))
      .rejects.toMatchObject({ code: 'cron/not-found' })
    await expect(controller.update({ jobId: missingId, prompt: 'x', maxRunMs: 0 }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.create(createRequest({ maxRunMs: 0 })))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })

    cron.running = true
    const created = await controller.create(createRequest())
    await expect(controller.runNow({ jobId: created.job.jobId }))
      .rejects.toMatchObject({ code: 'cron/run-in-progress' })

    // The unary verbs carry the same leader refusal the follow baseline does.
    cron.leading = false
    await expect(commands.create(createRequest())).rejects.toMatchObject({ code: 'cron/not-leader' })
    await expect(commands.update({ jobId: created.job.jobId, prompt: 'x' })).rejects.toMatchObject({ code: 'cron/not-leader' })
    await expect(commands.delete({ jobId: created.job.jobId })).rejects.toMatchObject({ code: 'cron/not-leader' })
    await expect(commands.runNow({ jobId: created.job.jobId })).rejects.toMatchObject({ code: 'cron/not-leader' })
  })

  it('puts every refusal code outside the wire vocabulary through unclassified', async () => {
    const { commands, cron } = bench()
    const failure = new Error('the store is unreachable')
    cron.failing = failure
    await expect(commands.create(createRequest())).rejects.toBe(failure)
    await expect(commands.update({ jobId: missingId, prompt: 'x' })).rejects.toBe(failure)
    await expect(commands.delete({ jobId: missingId })).rejects.toBe(failure)
    await expect(commands.runNow({ jobId: missingId })).rejects.toBe(failure)

    // A refusal carrying a code this package never declared is not a state a
    // caller can branch on, so it stays unclassified rather than acquiring a
    // wire code the client would have to keep stable.
    cron.failing = Object.assign(new Error('a refusal from another owner'), { code: 'some_other_code' })
    await expect(commands.create(createRequest())).rejects.toMatchObject({ code: 'some_other_code' })
  })

  it('refuses every management verb while this process leads no scheduler', async () => {
    const { controller, cron } = bench()
    const created = await controller.create(createRequest())
    cron.leading = false
    await expect(controller.create(createRequest())).rejects.toMatchObject({ code: 'cron/not-leader' })
    await expect(controller.update({ jobId: created.job.jobId, prompt: 'x' })).rejects.toMatchObject({ code: 'cron/not-leader' })
    await expect(controller.delete({ jobId: created.job.jobId })).rejects.toMatchObject({ code: 'cron/not-leader' })
    await expect(controller.runNow({ jobId: created.job.jobId })).rejects.toMatchObject({ code: 'cron/not-leader' })
  })
})

describe('CronController follow', () => {
  it('opens with the complete current list, then a committed task write once', async () => {
    const { ctx, controller, cron } = bench()
    await controller.create(createRequest())
    const feed = new CronFeed(ctx)
    expect(feed.baseline()).toMatchObject({ items: [{ jobId: 'cron-1' }] })

    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(nextFrame(iterator)).resolves.toMatchObject({
        type: 'baseline',
        value: { items: [{ jobId: 'cron-1' }] },
      })

      // A write this process did not make still reaches an open generation,
      // exactly once per committed record.
      const stored = cronJob({ id: brandString<CronJobId>('cron-2'), prompt: 'nightly' })
      cron.rows.set(stored.id, stored)
      emitChange(ctx, { key: String(stored.id), operation: 'put', value: stored })
      await expect(nextFrame(iterator)).resolves.toMatchObject({
        type: 'upsert',
        job: { jobId: 'cron-2', prompt: 'nightly' },
      })

      // Its removal publishes the removal its identity earned.
      cron.rows.delete(stored.id)
      emitChange(ctx, { key: String(stored.id), operation: 'deleted' })
      await expect(nextFrame(iterator)).resolves.toEqual({ type: 'remove', jobId: 'cron-2' })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('replaces the published list from a new generation baseline', async () => {
    const { controller } = bench()
    await controller.create(createRequest())
    const abort = new AbortController()
    const first = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(first)

    // A reconnect opens a second generation whose baseline is the whole truth,
    // so a consumer never depends on increments it missed while disconnected.
    await controller.create(createRequest({ prompt: 'second task' }))
    const second = controller.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(nextFrame(second)).resolves.toMatchObject({
        type: 'baseline',
        value: { items: [{ jobId: 'cron-1' }, { jobId: 'cron-2' }] },
      })
    } finally {
      abort.abort()
      await first.return?.()
      await second.return?.()
    }
  })

  it('answers a non-leading process with the leader refusal instead of an empty list', async () => {
    const { ctx, cron } = bench()
    // Leadership is not a construction requirement: a follower builds the feed
    // and opens generations, and the refusal belongs to the baseline it serves.
    const feed = new CronFeed(ctx)
    cron.leading = false
    expect(feed.baseline()).toEqual<CronFollowBaseline>({
      listError: {
        code: 'cron/not-leader',
        message: 'this process does not hold the cron scheduler lease',
      },
    })

    const abort = new AbortController()
    const iterator = feed.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await nextFrame(iterator)
      expect(frame).toMatchObject({ type: 'baseline', value: { listError: { code: 'cron/not-leader' } } })
      expect(frame).not.toMatchObject({ value: { items: [] } })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('closes every open generation when its fiber is disposed', async () => {
    const { ctx, controller } = bench()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    // Constructing the controller above is what published it, so disposing this
    // fiber is what has to withdraw the service and close its generations.
    const closing = iterator.next()
    await ctx.fiber.dispose()
    roots.splice(roots.indexOf(ctx), 1)
    await expect(closing).resolves.toEqual({ done: true, value: undefined })
  })

  it('ignores unrelated domains, tables, and identities outside the published list', async () => {    const { ctx, controller } = bench()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    // The collected frames are the assertion: an event outside the cron jobs
    // table, a global write, a removal of an identity no baseline published,
    // and a value that states no projectable task must each produce no frame.
    // The final commit is what proves the generation is still live and ordered.
    const stored = cronJob({ id: brandString<CronJobId>('cron-3') })
    const frames = await framesAfter(ctx, iterator, () => {
      ctx.emit('domain/changed', { domain: 'workspace', table: 'jobs', key: 'cron-9', operation: 'put', value: cronJob() })
      ctx.emit('domain/changed', { domain: 'cron', table: '', key: '', operation: 'put', value: { nextJobNumber: 2 } })
      ctx.emit('domain/changed', { domain: 'cron', table: 'other', key: 'cron-9', operation: 'put', value: cronJob() })
      ctx.emit('domain/changed', { domain: 'cron', table: 'jobs', key: 'cron-9', operation: 'deleted' })
      // A committed value that states no identity is not a task this stream can
      // project, so it publishes nothing rather than a fabricated row.
      ctx.emit('domain/changed', { domain: 'cron', table: 'jobs', key: 'cron-9', operation: 'put', value: { prompt: 'no id' } })
      ctx.emit('domain/changed', { domain: 'cron', table: 'jobs', key: 'cron-9', operation: 'put', value: null })
      ctx.emit('domain/changed', { domain: 'cron', table: 'jobs', key: 'cron-9', operation: 'put', value: { id: 'cron-9', expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'other' } } })
      emitChange(ctx, { key: 'cron-3', operation: 'put', value: stored })
    })
    expect(frames).toEqual([{ type: 'upsert', job: cronJobView(stored) }])

    // The identity is now published, so its own removal is this feed's to report.
    const removed = await framesAfter(ctx, iterator, () => {
      emitChange(ctx, { key: 'cron-3', operation: 'deleted' })
    })
    expect(removed).toEqual([{ type: 'remove', jobId: 'cron-3' }])
    abort.abort()
    await iterator.return?.()
  })
})

describe('CronFeed committed-value narrowing', () => {
  /** One complete committed record, as the storage domain delivers it. */
  function committed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      id: 'cron-7',
      expression: '0 9 * * 1-5',
      timeZone: 'Europe/Berlin',
      enabled: false,
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: { provider: 'deepseek', model: 'chat' },
      },
      prompt: 'run the report',
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      maxRunMs: 2_500,
      createdAt: 10,
      updatedAt: 20,
      nextDueAt: 30,
      recentRuns: [
        { startedAt: 1, finishedAt: 2, outcome: 'completed' },
        { startedAt: 3, finishedAt: 4, outcome: 'timeout' },
      ],
      ...overrides,
    }
  }

  /** Read the frames one committed value produces on an open generation. */
  async function framesFor(value: unknown): Promise<CronFollowFrame[]> {
    const { ctx, controller } = bench()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    try {
      return await framesAfter(ctx, iterator, () => {
        emitChange(ctx, { key: 'cron-7', operation: 'put', value })
      })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  }

  it('projects every stored field of a complete committed record', async () => {
    const frames = await framesFor(committed())
    expect(frames).toEqual([{
      type: 'upsert',
      job: {
        jobId: 'cron-7',
        expression: '0 9 * * 1-5',
        timeZone: 'Europe/Berlin',
        enabled: false,
        target: {
          kind: 'new-session',
          workspacePath: '/work',
          agentPreset: 'default',
          permissionPreset: 'ask',
          model: { provider: 'deepseek', model: 'chat' },
        },
        prompt: 'run the report',
        overlapPolicy: 'queue-one',
        misfirePolicy: 'run-once-late',
        maxRunMs: 2_500,
        createdAt: 10,
        updatedAt: 20,
        nextDueAt: 30,
        recentRuns: [
          { startedAt: 1, finishedAt: 2, outcome: 'completed' },
          { startedAt: 3, finishedAt: 4, outcome: 'timeout' },
        ],
      },
    }])
  })

  it.each([
    ['createdAt', 'not a number'],
    ['updatedAt', 1.5],
    ['nextDueAt', null],
    ['maxRunMs', 0],
    ['maxRunMs', Number.NaN],
  ])('publishes nothing for a record whose %s is not a stored number', async (field, value) => {
    // A substituted instant or ceiling would show the operator a schedule the
    // store never held, so the generation keeps its last good projection.
    await expect(framesFor(committed({ [field]: value }))).resolves.toEqual([])
  })

  it('carries no run history a record does not state', async () => {
    // An entry that is not a run is dropped, and an unusable history is empty,
    // rather than defaulted into work the store never recorded. Each entry
    // fails exactly one guard, because each guard short-circuits on its first
    // operand: an entry missing its instants never reaches the outcome check.
    const frames = await framesFor(committed({
      recentRuns: [
        null,
        'not a run',
        { startedAt: 'x', finishedAt: 1, outcome: 'failed' },
        { startedAt: 1, finishedAt: 'x', outcome: 'failed' },
        { startedAt: 1, finishedAt: 2 },
        { startedAt: 1, finishedAt: 2, outcome: 'bogus' },
      ],
    }))
    expect(frames).toMatchObject([{ type: 'upsert', job: { recentRuns: [] } }])

    // A history that does state runs carries them, so the projection is not
    // simply dropping every entry it is handed.
    const kept = await framesFor(committed({
      recentRuns: [
        { startedAt: 1, finishedAt: 2, outcome: 'completed' },
        { startedAt: 3, finishedAt: 4, outcome: 'bogus' },
      ],
    }))
    expect(kept).toMatchObject([{
      type: 'upsert',
      job: { recentRuns: [{ startedAt: 1, finishedAt: 2, outcome: 'completed' }] },
    }])

    const absent = await framesFor(committed({ recentRuns: 'no history' }))
    expect(absent).toMatchObject([{ type: 'upsert', job: { recentRuns: [] } }])
  })

  it('states the documented defaults for the fields a surface may omit', async () => {
    const frames = await framesFor({
      id: 'cron-8',
      expression: '0 9 * * *',
      timeZone: 'UTC',
      target: { kind: 'session', sessionId: 'session-1' },
      createdAt: 0,
      updatedAt: 0,
      nextDueAt: 0,
      maxRunMs: 1,
    })
    // A record that states no enabled flag, prompt, or policy is projected with
    // the values its own schema would have stored.
    expect(frames).toMatchObject([{
      type: 'upsert',
      job: {
        enabled: false,
        prompt: '',
        overlapPolicy: 'skip',
        misfirePolicy: 'skip',
        recentRuns: [],
        target: { kind: 'session', sessionId: 'session-1' },
      },
    }])
  })

  it('publishes nothing for a destination that states no usable target', async () => {
    await expect(framesFor(committed({ target: { kind: 'session', sessionId: '' } }))).resolves.toEqual([])
    await expect(framesFor(committed({ target: { kind: 'new-session', workspacePath: '/work' } }))).resolves.toEqual([])
    await expect(framesFor(committed({ target: { kind: 'new-session', workspacePath: '/work', agentPreset: 'd', permissionPreset: 'ask', model: { provider: 'deepseek' } } })))
      .resolves.toMatchObject([{ type: 'upsert', job: { target: { kind: 'new-session', model: null } } }])
  })

  it.each([
    ['a destination that states no kind', { workspacePath: '/work' }],
    ['a destination that is text', 'session'],
    ['a destination that is absent', null],
    ['a destination whose workspace is not text', { kind: 'new-session', workspacePath: 1, agentPreset: 'd', permissionPreset: 'ask' }],
    ['a destination whose agent preset is not text', { kind: 'new-session', workspacePath: '/work', agentPreset: 2, permissionPreset: 'ask' }],
    ['a destination whose permission preset is not text', { kind: 'new-session', workspacePath: '/work', agentPreset: 'd', permissionPreset: 3 }],
  ])('publishes nothing for %s', async (_label, target) => {
    await expect(framesFor(committed({ target }))).resolves.toEqual([])
  })

  it.each([
    ['states none', null],
    ['is not a selection', 'deepseek'],
    ['names no provider', { model: 'chat' }],
    ['names no model', { provider: 'deepseek' }],
    ['names a provider that is not text', { provider: 1, model: 'chat' }],
  ])('treats a model selection that %s as no selection', async (_label, model) => {
    // The selection is optional on the stored record, so a value that is not one
    // means the task names no provider rather than that it is not a task.
    const frames = await framesFor(committed({
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'd',
        permissionPreset: 'ask',
        model,
      },
    }))
    expect(frames).toMatchObject([{ type: 'upsert', job: { target: { kind: 'new-session', model: null } } }])
  })

  it.each([
    ['expression', 42],
    ['timeZone', null],
  ])('publishes nothing for a record whose %s is not text', async (field, value) => {
    await expect(framesFor(committed({ [field]: value }))).resolves.toEqual([])
  })

  it.each([
    ['a number', 42],
    ['text', 'not a record'],
    ['nothing', undefined],
  ])('publishes nothing for a committed value that is %s', async (_label, value) => {
    // The domain event carries an untyped value, so a write that is not a record
    // at all is skipped rather than read field by field.
    await expect(framesFor(value)).resolves.toEqual([])
  })

  it('reports a capability failure that is not the leader refusal as a failed generation', () => {
    const { ctx, cron } = bench()
    // Construction never requires leadership, and a refusal outside the leader
    // code is not a state this stream can report, so the read throws it on.
    const feed = new CronFeed(ctx)
    const failure = new Error('the store is unreachable')
    cron.failing = failure
    expect(() => feed.baseline()).toThrow(failure)
  })
})

describe('cronJobView', () => {
  it('projects every stored field into a detached Remote value', () => {
    const stored = cronJob({
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: { provider: 'deepseek', model: 'chat' },
      },
      recentRuns: [run('failed'), run('timeout')],
    })
    const view = cronJobView(stored)
    expect(view).toEqual({
      jobId: 'cron-1',
      expression: '0 9 * * *',
      timeZone: 'UTC',
      enabled: true,
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: { provider: 'deepseek', model: 'chat' },
      },
      prompt: 'check the build',
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
      maxRunMs: 1_000,
      createdAt: 0,
      updatedAt: 0,
      nextDueAt: 32_400_000,
      recentRuns: [run('failed'), run('timeout')],
    })
    // The projection is detached: a caller that edits it cannot change the store.
    expect(view.target).not.toBe(stored.target)
    expect(view.recentRuns).not.toBe(stored.recentRuns)
  })

  it('states an absent model selection as an explicit null', () => {
    const view = cronJobView(cronJob({
      target: { kind: 'new-session', workspacePath: '/work', agentPreset: 'default', permissionPreset: 'ask' },
    }))
    expect(view.target).toMatchObject({ kind: 'new-session', model: null })
  })

  it('reads a stored session destination through unchanged', () => {
    const view = cronJobView(cronJob())
    expect(view.target).toEqual({ kind: 'session', sessionId: 'session-1' })
  })
})

describe('CronController construction', () => {
  it('publishes itself under the Host controller key and its own Remote namespace', async () => {
    const { ctx, controller } = bench()
    // A Cordis service is reached through a proxy, so instance identity proves
    // nothing a consumer relies on. These assert the observable facts instead:
    // the key resolves to a service that serves the verbs over this process's
    // capability, and the Remote binding names the cron namespace.
    expect(typeof ctx.cronController.create).toBe('function')
    expect(typeof ctx.cronController.follow).toBe('function')
    expect(controller.typertRemote.namespace).toBe('cron')
    // The published key is this controller: a write through it lands in the
    // capability this test harness owns.
    await expect(ctx.cronController.create(createRequest())).resolves.toMatchObject({ job: { jobId: 'cron-1' } })
  })
})
