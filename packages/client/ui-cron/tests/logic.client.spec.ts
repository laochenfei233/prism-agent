/**
 * Pure derivations the scheduled-task panel renders, exercised as functions of
 * their inputs alone.
 */

import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CronJobView } from '@deepseek-ai/dsh-api-cron-controller/client'
import {
  draftFor, draftRequest, formatDuration, formatInZone, newDraft, runSummary, viewerTimeZone,
} from '../src/client/logic.ts'
import { en, NS } from '../src/client/locales.ts'

const t = ((key: keyof typeof en, params?: Record<string, string | number>) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
}) as TranslateNS<typeof NS>

function job(overrides: Partial<CronJobView> = {}): CronJobView {
  return {
    jobId: 'cron-1' as CronJobView['jobId'],
    expression: '0 9 * * 1-5',
    timeZone: 'Europe/Berlin',
    enabled: true,
    target: {
      kind: 'new-session',
      workspacePath: '/work',
      agentPreset: 'default',
      permissionPreset: 'ask',
      model: null,
    },
    prompt: 'run the report',
    overlapPolicy: 'skip',
    misfirePolicy: 'skip',
    maxRunMs: 1_000,
    createdAt: 0,
    updatedAt: 0,
    nextDueAt: 0,
    recentRuns: [],
    ...overrides,
  }
}

describe('runSummary', () => {
  it('reports a settled run and clamps a record that runs backwards', () => {
    expect(runSummary({ startedAt: 10, finishedAt: 40, outcome: 'completed' }))
      .toEqual({ outcome: 'completed', finishedAt: 40, durationMs: 30 })
    expect(runSummary({ startedAt: 40, finishedAt: 10, outcome: 'interrupted' }))
      .toEqual({ outcome: 'interrupted', finishedAt: 10, durationMs: 0 })
  })
})

describe('formatDuration', () => {
  it('chooses the widest whole unit pair and never renders a negative span', () => {
    expect(formatDuration(3_000, t)).toBe('3s')
    expect(formatDuration(63_000, t)).toBe('1m 3s')
    expect(formatDuration(3_663_000, t)).toBe('1h 1m')
    expect(formatDuration(-5, t)).toBe('0s')
  })
})

describe('formatInZone', () => {
  it('renders an instant in the zone its task states', () => {
    const midnight = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(formatInZone(midnight, 'UTC', 'en-US')).toContain('2026')
    expect(formatInZone(midnight, 'UTC', 'en-US'))
      .not.toBe(formatInZone(midnight, 'Asia/Tokyo', 'en-US'))
  })
})

describe('viewerTimeZone', () => {
  it('answers with a zone the platform resolves', () => {
    expect(typeof viewerTimeZone()).toBe('string')
    expect(viewerTimeZone()).not.toBe('')
  })
})

describe('newDraft', () => {
  it('creates an empty draft in the viewer zone with a stated workspace', () => {
    const draft = newDraft('/work')
    expect(draft).toMatchObject({
      jobId: undefined,
      expression: '',
      timeZone: viewerTimeZone(),
      prompt: '',
      targetKind: 'new-session',
      workspacePath: '/work',
      agentPreset: '',
      permissionPreset: '',
      sessionId: '',
      maxRunMs: '',
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
    })
    expect(newDraft().workspacePath).toBe('')
  })
})

describe('draftFor', () => {
  it('reads a new-session target into the form', () => {
    expect(draftFor(job())).toEqual({
      jobId: 'cron-1',
      expression: '0 9 * * 1-5',
      timeZone: 'Europe/Berlin',
      prompt: 'run the report',
      targetKind: 'new-session',
      workspacePath: '/work',
      agentPreset: 'default',
      permissionPreset: 'ask',
      sessionId: '',
      maxRunMs: '1000',
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
    })
  })

  it('reads a session target into the form and blanks the new-session fields', () => {
    const draft = draftFor(job({ target: { kind: 'session', sessionId: 'session-9' } }))
    expect(draft).toMatchObject({
      targetKind: 'session',
      sessionId: 'session-9',
      workspacePath: '',
      agentPreset: '',
      permissionPreset: '',
    })
  })
})

describe('draftRequest', () => {
  it('states a new-session create without a ceiling when the form left it blank', () => {
    const request = draftRequest({
      ...newDraft(' /work '),
      expression: ' 0 9 * * * ',
      timeZone: ' UTC ',
      prompt: 'run the report',
      agentPreset: ' default ',
      permissionPreset: ' ask ',
    })
    expect(request).toEqual({
      expression: '0 9 * * *',
      timeZone: 'UTC',
      prompt: 'run the report',
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: null,
      },
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
    })
    expect('jobId' in request).toBe(false)
    expect('maxRunMs' in request).toBe(false)
  })

  it('states a session edit with the target identity and a numeric ceiling', () => {
    const request = draftRequest({
      ...newDraft(),
      jobId: 'cron-7' as CronJobView['jobId'],
      targetKind: 'session',
      sessionId: ' session-9 ',
      maxRunMs: '2500',
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
    })
    expect(request).toEqual({
      jobId: 'cron-7',
      expression: '',
      timeZone: viewerTimeZone(),
      prompt: '',
      target: { kind: 'session', sessionId: 'session-9' },
      maxRunMs: 2_500,
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
    })
  })
})
