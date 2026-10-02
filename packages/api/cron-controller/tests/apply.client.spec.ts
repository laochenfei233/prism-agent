/**
 * Scheduled-task Client plugin wiring: `apply` builds the service and the
 * reconnecting follow control over the injected Remote namespace, routes each
 * command through it, and releases the generation with its fiber.
 *
 * The stub stands in for the Gateway's own `$stream`: it answers the namespace,
 * hands back one scripted physical generation, and captures the options object
 * so a case can report a carrier loss the way the real supervisor does. What it
 * must honour is the snapshot protocol `RemoteSnapshotStream` consumes — one
 * generation number per physical connection, an opening baseline, then deltas.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  RemoteStreamCarrierError,
  type RemoteStreamItem,
  type RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { apply, type CronRemote } from '../src/client/index.ts'
import type { CronFollowFrame, CronJobId, CronJobView, CronViewValue } from '../src/types.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One stored task as a browser reads it. */
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

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** The generated namespace: it answers each verb and is the generation source. */
class StubRemote implements CronRemote {
  readonly calls: string[] = []
  /** The frames the namespace's follow generation delivers, in commit order. */
  frames: readonly CronFollowFrame[] = []
  /** The failure that generation ends on, absent for one that stays open. */
  terminal: RemoteError | undefined

  async create(): Promise<{ ok: true; value: CronViewValue }> {
    this.calls.push('create')
    return ok({ job: view() })
  }

  async update(request: { readonly jobId: CronJobId }): Promise<{ ok: true; value: CronViewValue }> {
    this.calls.push(`update:${request.jobId}`)
    return ok({ job: view({ updatedAt: 5 }) })
  }

  async delete(request: { readonly jobId: CronJobId }): Promise<{ ok: true; value: CronViewValue }> {
    this.calls.push(`delete:${request.jobId}`)
    return ok({ job: view() })
  }

  async runNow(request: { readonly jobId: CronJobId }): Promise<{ ok: false; error: RemoteError<'cron/not-leader'> }> {
    this.calls.push(`runNow:${request.jobId}`)
    return { ok: false, error: new RemoteError('cron/not-leader', 'another process leads', {}) }
  }

  /**
   * One physical generation of the logical follow stream.
   * @param signal - the generation's cancellation lifetime.
   * @returns the frames this generation delivers, then the failure it ends on.
   */
  follow(signal?: AbortSignal): AsyncIterable<CronFollowFrame> & { restart: () => void; dispose: () => Promise<void> } {
    const { frames, terminal } = this
    return {
      restart: () => {},
      dispose: async () => {},
      async *[Symbol.asyncIterator]() {
        signal?.throwIfAborted()
        for (const value of frames) yield value
        if (terminal !== undefined) throw terminal
      },
    }
  }
}

/** One scripted generation: the frames it delivers, how it ends, and what it did. */
interface ScriptLog {
  /** The frames the generation delivers, in commit order. */
  readonly frames: readonly CronFollowFrame[]
  /** The failure the generation ends on, absent for a generation that stays open. */
  readonly terminal?: RemoteError
  /** Accepted baselines and disposal, in order. */
  readonly events: string[]
}

/** The plugin under a stub carrier, plus the supervisor controls a case drives. */
interface Bench {
  readonly ctx: Context
  readonly remote: StubRemote
  /** Report a carrier loss on the live generation, as the supervisor does. */
  loseCarrier: () => void
  /** Classify a generation end, as the supervisor does. */
  classifyEnd: (accepted: boolean) => Error
}

/**
 * Boot the plugin over one scripted generation.
 *
 * The stub's `$stream` mirrors the Gateway's supervisor: it opens the
 * generation through the plugin's own `open` callback and re-emits each frame
 * annotated with the physical generation that delivered it, so the plugin sees
 * the same call it makes in production.
 * @param log - the frames to deliver and where to record the lifecycle.
 * @returns the context, the stubbed namespace, and the supervisor controls.
 */
function bench(log: ScriptLog): Bench {
  const ctx = new Context()
  roots.push(ctx)
  const remote = new StubRemote()
  remote.frames = log.frames
  remote.terminal = log.terminal
  let options: RemoteStreamOptions<CronFollowFrame> | undefined
  ctx.provide('remote', {
    cron: remote,
    $stream: (streamOptions: RemoteStreamOptions<CronFollowFrame>) => {
      options = streamOptions
      return {
        restart: () => {},
        dispose: async () => { log.events.push('disposed') },
        async *[Symbol.asyncIterator]() {
          const signal = new AbortController().signal
          // One physical connection carries the whole scripted sequence, so
          // every frame shares one generation number: the number changes only
          // when a reconnect opens a new baseline.
          for await (const value of streamOptions.open(signal)) {
            const item: RemoteStreamItem<CronFollowFrame> = {
              generation: 0,
              value,
              accept: () => { log.events.push('accepted') },
              signal,
            }
            yield item
          }
        },
      }
    },
  } as never)
  apply(ctx)
  return {
    ctx,
    remote,
    loseCarrier: () => {
      options?.carrierFailed?.(new RemoteStreamCarrierError('the socket went away'))
    },
    classifyEnd: (accepted) => {
      const classify = options?.ended
      if (classify === undefined) throw new Error('the plugin opened no generation')
      return classify(accepted)
    },
  }
}

/**
 * One script that keeps its generation open after the frames.
 * @param frames - the frames the generation delivers.
 * @param terminal - the failure it ends on, absent for a generation that stays open.
 * @returns the script log.
 */
function script(frames: readonly CronFollowFrame[], terminal?: RemoteError): ScriptLog {
  return { frames, events: [], ...terminal === undefined ? {} : { terminal } }
}

describe('cron controller client apply', () => {
  it('provides the service and applies one generation through the injected namespace', async () => {
    const { ctx, remote } = bench(script([
      { type: 'baseline', value: { items: [view()] } },
      { type: 'upsert', job: view({ jobId: 'cron-2' as CronJobId, updatedAt: 4 }) },
      { type: 'remove', jobId: 'cron-1' as CronJobId },
    ]))

    await vi.waitFor(() => {
      expect(ctx.cronJobs.state.getSnapshot()).toEqual({
        items: [view({ jobId: 'cron-2' as CronJobId, updatedAt: 4 })],
        phase: 'ready',
        error: null,
      })
    })
    // Every command routes through the injected namespace.
    await expect(ctx.cronJobs.remove('cron-1' as CronJobId)).resolves.toBeUndefined()
    await expect(ctx.cronJobs.create({
      expression: '0 9 * * *', timeZone: 'UTC', target: { kind: 'session', sessionId: 's' }, prompt: 'p',
    })).resolves.toMatchObject({ jobId: 'cron-1' })
    await expect(ctx.cronJobs.setEnabled('cron-1' as CronJobId, false)).resolves.toMatchObject({ updatedAt: 5 })
    await expect(ctx.cronJobs.runNow('cron-1' as CronJobId)).rejects.toThrow('another process leads')
    expect(remote.calls).toEqual(['delete:cron-1', 'create', 'update:cron-1', 'runNow:cron-1'])
  })

  it('classifies a generation end after its baseline as retryable and one before it as a defect', () => {
    const { classifyEnd } = bench(script([]))
    // The distinction decides whether the client retries the carrier or reports
    // a terminal protocol failure, so both arms are asserted.
    expect(classifyEnd(true)).toBeInstanceOf(RemoteStreamCarrierError)
    const beforeOpening = classifyEnd(false)
    expect(beforeOpening).not.toBeInstanceOf(RemoteStreamCarrierError)
    expect(beforeOpening.message).toContain('before its opening snapshot')
  })

  it('keeps the published rows and reconnects when the supervisor reports a carrier loss', async () => {
    const { ctx, loseCarrier } = bench(script([{ type: 'baseline', value: { items: [view()] } }]))

    await vi.waitFor(() => {
      expect(ctx.cronJobs.state.getSnapshot()).toMatchObject({ phase: 'ready', items: [view()] })
    })
    loseCarrier()
    await vi.waitFor(() => {
      expect(ctx.cronJobs.state.getSnapshot().phase).toBe('connecting')
    })
    // A lost carrier is retryable, so the rows it already published stay
    // visible and no terminal failure is reported.
    expect(ctx.cronJobs.state.getSnapshot().items).toEqual([view()])
    expect(ctx.cronJobs.state.getSnapshot().error).toBeNull()
  })

  it('publishes a terminal generation failure and releases the generation with its fiber', async () => {
    const log = script(
      [{ type: 'baseline', value: { items: [view()] } }],
      new RemoteError('gateway/internal', 'the carrier closed the generation', {}),
    )
    const { ctx } = bench(log)

    await vi.waitFor(() => {
      expect(ctx.cronJobs.state.getSnapshot().phase).toBe('error')
    })
    expect(ctx.cronJobs.state.getSnapshot().error).toMatchObject({ code: 'gateway/internal' })

    await ctx.fiber.dispose()
    roots.splice(roots.indexOf(ctx), 1)
    // Disposal is what releases the carrier, so the plugin owns no stream after
    // its fiber unloads.
    expect(log.events).toContain('disposed')
  })
})
