import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CronService } from '@deepseek-ai/dsh-cron'
import type { CronJob, CronRunRecord } from '@deepseek-ai/dsh-cron'

/** The smallest provider: it answers nothing, which is all this test needs. */
class ProbeCron extends CronService {
  list(): readonly CronJob[] {
    return []
  }

  get(): CronJob | undefined {
    return undefined
  }

  async create(): Promise<CronJob> {
    throw new Error('the probe stores nothing')
  }

  async update(): Promise<CronJob> {
    throw new Error('the probe stores nothing')
  }

  async remove(): Promise<boolean> {
    return false
  }

  async runNow(): Promise<CronRunRecord> {
    throw new Error('the probe runs nothing')
  }
}

describe('CronService', () => {
  it('is implementable and constructs its provider', () => {
    // Weak evidence on purpose: this pins that the definition's constructor runs
    // and that a provider can satisfy it. Whether the service is published under
    // `cron` is the composition's behaviour, pinned by the real-composition test.
    const ctx = new Context()
    const probe = new ProbeCron(ctx)
    expect(probe).toBeInstanceOf(CronService)
    expect(probe.list()).toEqual([])
    expect(probe.get()).toBeUndefined()
    // Cordis publishes the service under its key, wrapped rather than as the raw
    // instance, so the key being served is what this pins.
    expect(ctx.get('cron')).toBeDefined()
  })
})
