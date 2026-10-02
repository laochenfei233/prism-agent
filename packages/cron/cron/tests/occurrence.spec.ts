import { describe, expect, it } from 'vitest'
import { MAX_SEARCH_DAYS, nextCronOccurrence, parseCronExpression } from '@deepseek-ai/dsh-cron'

const utc = (value: string): number => Date.parse(value)

/** The next instant for one expression in one zone, from a UTC reference. */
function next(source: string, timeZone: string, after: string): number | undefined {
  return nextCronOccurrence(parseCronExpression(source), timeZone, utc(after))
}

describe('nextCronOccurrence', () => {
  it('resolves a fixed-offset zone by subtracting its offset', () => {
    // Asia/Shanghai is always +08:00, so 09:00 there is 01:00 UTC.
    expect(next('0 9 * * *', 'Asia/Shanghai', '2026-06-01T00:00:00Z')).toBe(utc('2026-06-01T01:00:00Z'))
    expect(next('0 0 * * *', 'UTC', '2026-06-01T00:00:00Z')).toBe(utc('2026-06-02T00:00:00Z'))
  })

  it('is strictly after the reference instant', () => {
    // The reference is itself an occurrence, so the answer is the next one.
    expect(next('0 9 * * 1', 'Asia/Shanghai', '2026-06-01T01:00:00Z')).toBe(utc('2026-06-08T01:00:00Z'))
    expect(next('* * * * *', 'UTC', '2026-06-01T00:00:30Z')).toBe(utc('2026-06-01T00:01:00Z'))
  })

  it('skips days the weekday rule excludes', () => {
    // 2026-06-06 is a Saturday; the next Monday is 2026-06-08.
    expect(next('0 9 * * 1', 'Asia/Shanghai', '2026-06-06T00:00:00Z')).toBe(utc('2026-06-08T01:00:00Z'))
    expect(next('0 9 * * 1-5', 'Asia/Shanghai', '2026-06-06T00:00:00Z')).toBe(utc('2026-06-08T01:00:00Z'))
  })

  it('follows the zone offset across a daylight-saving boundary', () => {
    // 09:00 New York is 14:00 UTC in January and 13:00 UTC in July.
    expect(next('0 9 * * *', 'America/New_York', '2026-01-15T00:00:00Z')).toBe(utc('2026-01-15T14:00:00Z'))
    expect(next('0 9 * * *', 'America/New_York', '2026-07-01T00:00:00Z')).toBe(utc('2026-07-01T13:00:00Z'))
  })

  it('passes over a reading the zone skipped rather than guessing at it', () => {
    // 2026-03-08 02:30 does not exist in America/New_York, so the next 02:30 on a
    // March 8 is the following year's, which daylight saving has not reached.
    expect(next('30 2 8 3 *', 'America/New_York', '2026-01-01T00:00:00Z')).toBe(utc('2027-03-08T07:30:00Z'))
  })

  it('takes the earlier instant of a repeated reading, then the later one', () => {
    // 2026-11-01 01:30 happens twice in America/New_York, at -04:00 then -05:00.
    expect(next('30 1 1 11 *', 'America/New_York', '2026-10-01T00:00:00Z')).toBe(utc('2026-11-01T05:30:00Z'))
    expect(next('30 1 1 11 *', 'America/New_York', '2026-11-01T05:30:00Z')).toBe(utc('2026-11-01T06:30:00Z'))
  })

  it('walks past a skipped century leap year', () => {
    // 2100 is not a leap year, so after March 2096 the next February 29 is 2104.
    expect(next('0 0 29 2 *', 'UTC', '2096-03-01T00:00:00Z')).toBe(utc('2104-02-29T00:00:00Z'))
  })

  it('answers undefined when the rule never fires', () => {
    // February has no 30th, and the union rule keeps the weekday field out of it.
    expect(next('0 0 30 2 *', 'UTC', '2026-01-01T00:00:00Z')).toBeUndefined()
  })

  it('bounds its own search', () => {
    expect(MAX_SEARCH_DAYS).toBeGreaterThan(366 * 8)
  })
})
