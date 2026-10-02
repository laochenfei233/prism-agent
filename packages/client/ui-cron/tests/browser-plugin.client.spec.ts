/**
 * ui-cron plugin halves: the browser entry's dictionary and header-slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal), the command face it injects, and the inert node entry.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { CronJobId, CronSnapshot } from '@deepseek-ai/dsh-api-cron-controller/client'
import { apply, inject } from '../src/client/index.ts'
import type { CronPanelInjected } from '../src/client/CronPanel.tsx'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const Empty = () => null

/** One snapshot the stubbed service publishes. */
const snapshot: CronSnapshot = { items: [], phase: 'connecting', error: null }

/** Commands the stubbed scheduled-task service was asked to run. */
const calls: string[] = []
/** The refusal the stubbed service answers with, when one is scripted. */
let refusal: { code: string; message: string } | undefined
/** Set to make the stubbed service fail with something that is not a refusal. */
let defect: Error | undefined

/** Answer the scripted failure, or nothing. */
function scripted(): void {
  if (defect !== undefined) throw defect
  if (refusal !== undefined) throw Object.assign(new Error(refusal.message), { rpcError: refusal })
}

/** Slot ledger reader: entry ids currently registered in the header list. */
function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.actions')
    .map(entry => entry.options.id)
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  ctx.provide('cronJobs', {
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    create: async (request: { readonly prompt: string }) => {
      calls.push(`create:${request.prompt}`)
      scripted()
      return { jobId: 'cron-1' }
    },
    update: async () => {
      calls.push('update')
      scripted()
      return { jobId: 'cron-1' }
    },
    setEnabled: async (_jobId: CronJobId, enabled: boolean) => {
      calls.push(`setEnabled:${String(enabled)}`)
      scripted()
      return { jobId: 'cron-1' }
    },
    remove: async (jobId: CronJobId) => {
      calls.push(`remove:${String(jobId)}`)
      scripted()
    },
    runNow: async (jobId: CronJobId) => {
      calls.push(`runNow:${String(jobId)}`)
      scripted()
    },
  } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  return ctx
}

function declareHeader(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, Empty)
}

beforeEach(() => {
  calls.length = 0
  refusal = undefined
  defect = undefined
})

/** The inject face the registered entry publishes. */
function injectedFace(ctx: Context): CronPanelInjected {
  const entry = ctx.slots
    .entries('conversation.session.header.actions')
    .find(candidate => candidate.options.id === 'cron-panel')
  const face = entry?.inject as (() => CronPanelInjected) | undefined
  if (face === undefined) throw new Error('cron-panel entry registered no inject face')
  return face()
}

describe('ui-cron browser half', () => {
  it('declares only the services used by registration', () => {
    expect(inject).toEqual(['cronJobs', 'slots', 'locale'])
  })

  it('waits for the header declaration, orders after jobs, and tears down', async () => {
    const ctx = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(headerEntryIds(ctx)).toEqual([])

    const header = declareHeader(ctx)
    ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'job-list', order: 20,
    }, Empty)
    expect(headerEntryIds(ctx)).toEqual(['job-list', 'cron-panel'])

    await fiber.dispose()
    expect(headerEntryIds(ctx)).toEqual(['job-list'])
    header()
    await ctx.fiber.dispose()
  })

  it('publishes the scheduled-task source and the command face over the service', async () => {
    const ctx = await baseContext()
    declareHeader(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    calls.length = 0
    refusal = undefined
    const face = injectedFace(ctx)
    expect(face.hooks.cron.getSnapshot()).toBe(snapshot)

    const request = {
      expression: '0 9 * * *',
      timeZone: 'UTC',
      prompt: 'run the report',
      target: { kind: 'session' as const, sessionId: 'session-1' },
      maxRunMs: 2_500,
      overlapPolicy: 'skip' as const,
      misfirePolicy: 'skip' as const,
    }
    await expect(face.create(request)).resolves.toBeNull()
    await expect(face.update({ ...request, jobId: 'cron-1' as CronJobId })).resolves.toBeNull()
    // A draft that stated no ceiling sends none, so the capability's default
    // stays in force instead of a number the form never carried.
    await expect(face.create({
      expression: request.expression,
      timeZone: request.timeZone,
      prompt: request.prompt,
      target: request.target,
      overlapPolicy: request.overlapPolicy,
      misfirePolicy: request.misfirePolicy,
    })).resolves.toBeNull()
    await expect(face.setEnabled('cron-1' as CronJobId, false)).resolves.toBeNull()
    await expect(face.remove('cron-1' as CronJobId)).resolves.toBeNull()
    await expect(face.runNow('cron-1' as CronJobId)).resolves.toBeNull()
    expect(calls).toEqual([
      'create:run the report',
      'update',
      'create:run the report',
      'setEnabled:false',
      'remove:cron-1',
      'runNow:cron-1',
    ])
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('reduces a refused command to its stable reason and rethrows a defect', async () => {
    const ctx = await baseContext()
    declareHeader(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    refusal = { code: 'cron/not-leader', message: 'another process leads' }
    const face = injectedFace(ctx)
    await expect(face.create({
      expression: '0 9 * * *',
      timeZone: 'UTC',
      prompt: 'p',
      target: { kind: 'session', sessionId: 's' },
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
    })).resolves.toBe('another process leads (cron/not-leader)')
    await expect(face.runNow('cron-1' as CronJobId)).resolves.toBe('another process leads (cron/not-leader)')

    // A failure that carries no code is not a refusal this surface may render.
    refusal = undefined
    defect = new Error('the carrier is gone')
    await expect(face.remove('cron-1' as CronJobId)).rejects.toThrow('the carrier is gone')
    defect = undefined
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('registers both dictionaries and releases them with its fiber', async () => {
    const ctx = await baseContext()
    declareHeader(ctx)
    ctx.locale.setLocale('zh')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const translate = ctx.locale.bind(NS)
    expect(translate('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(translate('list.aria')).toBe(en['list.aria'])
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())

    await fiber.dispose()
    expect(translate('list.aria')).not.toBe(en['list.aria'])
    await ctx.fiber.dispose()
  })
})

describe('ui-cron node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})
