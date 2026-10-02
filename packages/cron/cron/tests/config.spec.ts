import { describe, expect, it } from 'vitest'
import { Config, resolveCronConfig } from '@deepseek-ai/dsh-cron'

describe('cron Config', () => {
  it('requires a leader lock path and defaults the retry delay', () => {
    const parsed = Config({ leaderLockPath: '/var/lib/dsh/leader.lock' })
    expect(parsed.leaderLockPath).toBe('/var/lib/dsh/leader.lock')
    expect(parsed.leaderRetryMs).toBe(30_000)
    expect(parsed.maxRunsPerJob).toBe(20)
    expect(parsed.defaultMaxRunMs).toBe(600_000)
  })

  it('rejects a config without a leader lock path', () => {
    expect(() => Config({})).toThrow()
  })

  it('rejects a blank leader lock path', () => {
    expect(() => Config({ leaderLockPath: '' })).toThrow()
  })

  it('rejects a retry delay that is not a positive integer', () => {
    expect(() => Config({ leaderLockPath: 'lock', leaderRetryMs: 0 })).toThrow()
    expect(() => Config({ leaderLockPath: 'lock', leaderRetryMs: 1.5 })).toThrow()
  })
})

describe('resolveCronConfig', () => {
  it('states every default the schema would have applied', () => {
    expect(resolveCronConfig({ leaderLockPath: 'lock' })).toEqual({
      leaderLockPath: 'lock',
      leaderRetryMs: 30_000,
      maxRunsPerJob: 20,
      defaultMaxRunMs: 600_000,
    })
  })

  it('keeps every value a caller stated', () => {
    expect(resolveCronConfig({
      leaderLockPath: 'elsewhere/leader.lock',
      leaderRetryMs: 250,
      maxRunsPerJob: 3,
      defaultMaxRunMs: 5_000,
    })).toEqual({
      leaderLockPath: 'elsewhere/leader.lock',
      leaderRetryMs: 250,
      maxRunsPerJob: 3,
      defaultMaxRunMs: 5_000,
    })
  })
})
