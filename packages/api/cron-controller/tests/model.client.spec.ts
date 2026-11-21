/**
 * Client scheduled-task state model, command facade, and the reconnecting
 * stream's frame dispatch.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteStream, type RemoteStreamItem, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  ClientCronModel, CronCommandError, CronJobs, createCronStateStream, inject,
  type CronRemote, type CronSnapshot, type CronStreamFactory,
} from '../src/client/index.ts'
import type {
  CronFollowFrame, CronJobId, CronJobView, CronRunRecord, CronViewCreateRequest, CronViewJobRequest,
  CronViewRunNowValue, CronViewUpdateRequest, CronViewValue,
} from '../src/types.ts'

/** One stored task as a browser reads it, varying only the stated fields. */
function view(overrides: Partial<CronJobView> = {}): CronJobView {
  return {
    jobId: 'cron-1' as CronJobId,
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

const RUN: CronRunRecord = { startedAt: 10, finishedAt: 20, outcome: 'completed' }

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failure(code: 'cron/not-leader' | 'cron/not-found' = 'cron/not-leader'): RemoteFailure {
  return new RemoteError(code, 'refused', {})
}

/** The generated namespace under test, with each verb scriptable. */
class FakeRemote implements CronRemote {
  /**
   * @param frames - the frames one scripted follow generation delivers, in
   * commit order; a case that never opens one leaves it absent.
   */
  constructor(private readonly frames?: readonly CronFollowFrame[]) {}

  createResult: RemoteResult<CronViewValue> = ok({ job: view() })
  updateResult: RemoteResult<CronViewValue> = ok({ job: view({ prompt: 'updated', updatedAt: 5 }) })
  /** Scripted removal failure; absent means the Host answers with the removed row. */
  deleteFailure: RemoteFailure | undefined
  runNowResult: RemoteResult<CronViewRunNowValue> = ok({ run: RUN })
  readonly requests: string[] = []

  async create(request: CronViewCreateRequest): Promise<RemoteResult<CronViewValue>> {
    this.requests.push(`create:${request.prompt}`)
    return this.createResult
  }

  async update(request: CronViewUpdateRequest): Promise<RemoteResult<CronViewValue>> {
    this.requests.push(`update:${request.jobId}`)
    return this.updateResult
  }

  async delete(request: CronViewJobRequest): Promise<RemoteResult<CronViewValue>> {
    this.requests.push(`delete:${request.jobId}`)
    const failed = this.deleteFailure
    if (failed !== undefined) return { ok: false, error: failed }
    // The Host answers a removal with the row it removed, so the echo names the
    // requested identity.
    return ok({ job: view({ jobId: request.jobId as CronJobId }) })
  }

  async runNow(request: CronViewJobRequest): Promise<RemoteResult<CronViewRunNowValue>> {
    this.requests.push(`runNow:${request.jobId}`)
    return this.runNowResult
  }

  /**
   * One scripted physical generation: the frames this namespace carries, in the
   * order the Host committed them.
   * @returns the generation's downlink.
   */
  follow(): RemoteStreamHandle<CronFollowFrame, never> {
    const frames = this.frames
    if (frames === undefined) throw new Error('these specs drive the model through its follow sink')
    return {
      send(): never { throw new Error('a scripted follow generation sends nothing') },
      end(): never { throw new Error('a scripted follow generation ends nothing') },
      dispose(): void {},
      async *[Symbol.asyncIterator]() {
        for (const value of frames) {
          yield value
          await Promise.resolve()
        }
      },
    }
  }
}

/**
 * One scripted physical generation, delivered as the Gateway stream class the
 * factory's type declares: the frames the namespace's own opener yields,
 * annotated with the one generation number a scripted connection carries.
 */
class ScriptedStream<Item> extends RemoteStream<Item> {
  /**
   * @param open - the generation's frame source: the domain opener the factory supplied.
   */
  constructor(private readonly open: (signal: AbortSignal) => AsyncIterable<Item>) {
    // The class's own supervisor never runs on a scripted stream, so its
    // classification is unreachable: this stream ends with its script.
    super({ generation: createSnapshotStore(undefined) }, {
      name: 'scripted stream',
      open,
      ended: () => new Error('a scripted stream ends only with its case'),
    })
  }

  override [Symbol.asyncIterator](): AsyncIterator<RemoteStreamItem<Item>> {
    return this.script()
  }

  /** The one generation this stream delivers, in the order its opener commits the frames. */
  private async *script(): AsyncGenerator<RemoteStreamItem<Item>> {
    // One physical connection carries the whole scripted sequence, so every
    // frame shares one generation number: the number changes only when a
    // reconnect opens a new baseline.
    const signal = new AbortController().signal
    for await (const value of this.open(signal)) {
      yield { generation: 0, value, accept: () => {}, signal }
      await Promise.resolve()
    }
  }
}

/**
 * The factory the state stream opens: the namespace's scripted generation and
 * the Gateway stream class it delivers through.
 * @param frames - the frames the one follow generation delivers, in commit order.
 * @returns the factory and namespace a state-stream case binds.
 */
function scriptedRemote(frames: readonly CronFollowFrame[]): CronStreamFactory & { readonly cron: CronRemote } {
  return {
    cron: new FakeRemote(frames),
    $stream: <Item>(options: RemoteStreamOptions<Item>) => new ScriptedStream<Item>(options.open),
  }
}

/** A snapshot read after each step, so no case depends on microtask timing. */
function snapshot(model: ClientCronModel): CronSnapshot {
  return model.getSnapshot()
}

describe('ClientCronModel', () => {
  it('opens in a connecting phase with nothing published', () => {
    const model = new ClientCronModel(new FakeRemote())
    expect(snapshot(model)).toEqual({ items: [], phase: 'connecting', error: null })
  })

  it('publishes a complete baseline and its readiness', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [view()] })
    expect(snapshot(model)).toEqual({ items: [view()], phase: 'ready', error: null })
  })

  it('reports the leader refusal as a business state rather than an empty list', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [view()] })
    model.replaceBaseline({ listError: { code: 'cron/not-leader', message: 'another process leads' } })
    expect(snapshot(model)).toEqual({ items: [], phase: 'unavailable', error: null })
  })

  it('merges an increment, replaces a known row, and drops a removed one', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [] })
    model.upsertView(view())
    expect(snapshot(model).items).toEqual([view()])

    model.upsertView(view({ prompt: 'newer', updatedAt: 7 }))
    expect(snapshot(model).items).toEqual([view({ prompt: 'newer', updatedAt: 7 })])

    model.removeView(view().jobId)
    expect(snapshot(model).items).toEqual([])
  })

  it('keeps the newest Host projection when an older frame arrives late', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [] })
    model.upsertView(view({ prompt: 'newer', updatedAt: 7 }))
    model.upsertView(view({ prompt: 'stale', updatedAt: 3 }))
    expect(snapshot(model).items).toEqual([view({ prompt: 'newer', updatedAt: 7 })])
  })

  it('never revives a removed identity from a delayed frame or a later baseline', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [view()] })
    model.removeView(view().jobId)
    model.upsertView(view({ updatedAt: 99 }))
    model.replaceBaseline({ items: [view({ updatedAt: 99 })] })
    expect(snapshot(model).items).toEqual([])
  })

  it('publishes one notification per changed snapshot, and none for a no-op removal', async () => {
    const model = new ClientCronModel(new FakeRemote())
    // The subscriber attaches after the baseline, so every count below is a
    // change the operation under test produced and nothing else.
    model.replaceBaseline({ items: [] })
    await Promise.resolve()
    let notified = 0
    model.subscribe(() => { notified += 1 })

    // Removing an identity the projection never held changes no fact. It does
    // mark that identity removed, which is why every later step uses a fresh
    // one: a removed identity must never come back.
    model.removeView(view().jobId)
    await Promise.resolve()
    expect(notified).toBe(0)
    expect(model.getSnapshot().items).toEqual([])

    const fresh = view({ jobId: 'cron-2' as CronJobId })
    model.upsertView(fresh)
    await Promise.resolve()
    expect(notified).toBe(1)
    expect(model.getSnapshot().items).toEqual([fresh])

    // Re-stating a published identity is still a change: the Host is the
    // authority on the row, so its newer projection replaces the published one.
    const renamed = view({ jobId: 'cron-2' as CronJobId, prompt: 'renamed', updatedAt: 4 })
    model.upsertView(renamed)
    await Promise.resolve()
    expect(notified).toBe(2)
    expect(model.getSnapshot().items).toEqual([renamed])

    // Dropping a published row changes it once more.
    model.removeView(fresh.jobId)
    await Promise.resolve()
    expect(notified).toBe(3)
    expect(model.getSnapshot().items).toEqual([])
  })

  it('coalesces a burst into one publication and drops the dispatch an immediate change supersedes', async () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [view(), view({ jobId: 'cron-2' as CronJobId })] })
    await Promise.resolve()
    let notified = 0
    model.subscribe(() => { notified += 1 })

    // Two changes in one turn publish once: the second joins the dispatch the
    // first already scheduled.
    model.upsertView(view({ prompt: 'a', updatedAt: 1 }))
    model.upsertView(view({ prompt: 'b', updatedAt: 2 }))
    await Promise.resolve()
    expect(notified).toBe(1)
    expect(model.getSnapshot().items[0]).toMatchObject({ prompt: 'b' })

    // A removal echoes immediately, which supersedes the dispatch scheduled for
    // the change beside it, so that dispatch publishes nothing of its own.
    // The removal request carries a wire string, so the identity is stated as
    // the wire would carry it.
    const pending = model.remove({ jobId: 'cron-2' })
    model.upsertView(view({ prompt: 'c', updatedAt: 3 }))
    await pending
    await Promise.resolve()
    expect(notified).toBe(2)
    // The removal echo names the requested row, so the identity the user
    // removed is the one the projection drops, and the change published beside
    // it survives.
    expect(model.getSnapshot().items).toEqual([view({ prompt: 'c', updatedAt: 3 })])
  })

  it('keeps the published rows visible while a lost carrier reconnects', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [view()] })
    model.handleCarrierFailure()
    expect(snapshot(model)).toEqual({ items: [view()], phase: 'connecting', error: null })
  })

  it('publishes a terminal stream failure and refuses a non-Remote one', () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [] })
    model.handleStreamFailure(failure())
    expect(snapshot(model)).toMatchObject({ phase: 'error', error: { code: 'cron/not-leader' } })
    expect(() => { model.handleStreamFailure(new Error('not a Remote failure')) })
      .toThrow('not a Remote failure')
  })

  it('notifies subscribers once per state change and stops on unsubscribe', async () => {
    const model = new ClientCronModel(new FakeRemote())
    let notified = 0
    const unsubscribe = model.subscribe(() => { notified += 1 })
    model.replaceBaseline({ items: [] })
    await Promise.resolve()
    expect(notified).toBe(1)
    // A snapshot read is stable until the fact moves.
    const first = model.getSnapshot()
    expect(model.getSnapshot()).toBe(first)
    unsubscribe()
    model.upsertView(view())
    await Promise.resolve()
    expect(notified).toBe(1)
  })

  it('merges each successful mutation echo and leaves a refused one unmerged', async () => {
    const remote = new FakeRemote()
    const model = new ClientCronModel(remote)
    model.replaceBaseline({ items: [] })

    await expect(model.create({
      expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'session', sessionId: 's' }, prompt: 'p',
    })).resolves.toMatchObject({ ok: true })
    expect(snapshot(model).items).toEqual([view()])

    await expect(model.update({ jobId: view().jobId, prompt: 'updated' })).resolves.toMatchObject({ ok: true })
    expect(snapshot(model).items).toEqual([view({ prompt: 'updated', updatedAt: 5 })])

    await expect(model.runNow({ jobId: view().jobId })).resolves.toEqual(ok({ run: RUN }))
    // A run reaches the row through the store's own write, so the reply echoes nothing.
    expect(snapshot(model).items).toEqual([view({ prompt: 'updated', updatedAt: 5 })])

    remote.createResult = { ok: false, error: failure('cron/not-found') }
    await expect(model.create({
      expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'session', sessionId: 's' }, prompt: 'p',
    })).resolves.toMatchObject({ ok: false })
    expect(snapshot(model).items).toEqual([view({ prompt: 'updated', updatedAt: 5 })])
  })

  it('drops a removed row immediately and routes the removal to the namespace', async () => {
    const remote = new FakeRemote()
    const model = new ClientCronModel(remote)
    model.replaceBaseline({ items: [view()] })
    await expect(model.remove({ jobId: view().jobId })).resolves.toMatchObject({ ok: true })
    expect(snapshot(model).items).toEqual([])
    expect(remote.requests).toEqual([`delete:${String(view().jobId)}`])
  })
})

describe('CronJobs service', () => {
  /**The service over one scripted namespace. */
  function service(remote = new FakeRemote()): { jobs: CronJobs; remote: FakeRemote } {
    return { jobs: new CronJobs(new Context(), new ClientCronModel(remote)), remote }
  }

  it('exposes the observable state as its own source', () => {
    const { jobs } = service()
    expect(jobs.state.getSnapshot()).toEqual({ items: [], phase: 'connecting', error: null })
    let notified = 0
    const unsubscribe = jobs.state.subscribe(() => { notified += 1 })
    jobs.state.getSnapshot()
    unsubscribe()
    expect(notified).toBe(0)
  })

  it('answers with the stored task and routes each verb to its own method', async () => {
    const { jobs, remote } = service()
    await expect(jobs.create({
      expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'session', sessionId: 's' }, prompt: 'p',
    })).resolves.toEqual(view())
    await expect(jobs.update({ jobId: view().jobId, prompt: 'updated' }))
      .resolves.toEqual(view({ prompt: 'updated', updatedAt: 5 }))
    await expect(jobs.setEnabled(view().jobId, false)).resolves.toEqual(view({ prompt: 'updated', updatedAt: 5 }))
    await expect(jobs.remove(view().jobId)).resolves.toBeUndefined()
    await expect(jobs.runNow(view().jobId)).resolves.toBeUndefined()
    expect(remote.requests).toEqual([
      'create:p',
      `update:${String(view().jobId)}`,
      `update:${String(view().jobId)}`,
      `delete:${String(view().jobId)}`,
      `runNow:${String(view().jobId)}`,
    ])
  })

  it('reports the stable Host reason and the refused command for every verb', async () => {
    const remote = new FakeRemote()
    remote.createResult = { ok: false, error: failure('cron/not-leader') }
    remote.updateResult = { ok: false, error: failure('cron/not-found') }
    remote.deleteFailure = failure('cron/not-found')
    remote.runNowResult = { ok: false, error: failure('cron/not-leader') }
    const { jobs } = service(remote)

    await expect(jobs.create({
      expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'session', sessionId: 's' }, prompt: 'p',
    })).rejects.toThrow(CronCommandError)
    await expect(jobs.update({ jobId: view().jobId })).rejects.toMatchObject({
      operation: 'update',
      rpcError: { code: 'cron/not-found' },
    })
    await expect(jobs.setEnabled(view().jobId, true)).rejects.toMatchObject({ operation: 'enable' })
    await expect(jobs.remove(view().jobId)).rejects.toMatchObject({ operation: 'delete' })
    await expect(jobs.runNow(view().jobId)).rejects.toMatchObject({ operation: 'run' })
    await expect(jobs.create({
      expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'session', sessionId: 's' }, prompt: 'p',
    })).rejects.toMatchObject({ operation: 'create', rpcError: { code: 'cron/not-leader' } })
  })
})

describe('createCronStateStream', () => {
  it('declares the Remote namespaces it binds', () => {
    expect(inject).toEqual(['remote', 'remote.cron'])
  })

  it('decodes one generation into the model in frame order', async () => {
    const model = new ClientCronModel(new FakeRemote())
    const failures: unknown[] = []
    /**
     * The frames one generation delivers, in the order the Host committed them:
     * a complete baseline, a new row, a replacement of the opening row, and a
     * removal. The scripted generation awaits a microtask between frames so the
     * consumer decodes them one at a time instead of racing the model.
     */
    const frames: CronFollowFrame[] = [
      { type: 'baseline', value: { items: [view()] } },
      { type: 'upsert', job: view({ jobId: 'cron-2' as CronJobId, updatedAt: 4 }) },
      { type: 'upsert', job: view({ prompt: 'renamed', updatedAt: 6 }) },
      { type: 'remove', jobId: 'cron-1' as CronJobId },
    ]
    const stream = createCronStateStream(scriptedRemote(frames), {
      accept: model,
      carrierFailed: () => { failures.push('carrier') },
      failed: (error) => { failures.push(error) },
    })
    stream.start()
    await stream.dispose()
    expect(failures).toEqual([])
    // The generation ends with the opening row replaced in place and removed,
    // and the row it introduced still published.
    expect(model.getSnapshot().items).toEqual([view({ jobId: 'cron-2' as CronJobId, updatedAt: 4 })])
  })

  it('replaces the whole projection from a reconnect baseline', async () => {
    const model = new ClientCronModel(new FakeRemote())
    model.replaceBaseline({ items: [view(), view({ jobId: 'cron-2' as CronJobId })] })
    await Promise.resolve()
    let notified = 0
    model.subscribe(() => { notified += 1 })

    const replacement: CronFollowFrame[] = [{ type: 'baseline', value: { items: [view({ updatedAt: 9 })] } }]
    const stream = createCronStateStream(scriptedRemote(replacement), { accept: model, failed: () => {} })
    stream.start()
    await stream.dispose()
    // A reconnect generation replaces the published rows rather than merging
    // into them, which is what keeps a consumer free of missed increments.
    expect(model.getSnapshot().items).toEqual([view({ updatedAt: 9 })])
    await Promise.resolve()
    expect(notified).toBe(1)
  })
})
