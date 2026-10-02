import { describe, expect, it } from 'vitest'
import { canonicalClientTimeZone, resolveLocalInstants } from '@deepseek-ai/dsh-util-time'

describe('canonicalClientTimeZone', () => {
  it('accepts UTC and Area/Location names unchanged', () => {
    expect(canonicalClientTimeZone('UTC')).toBe('UTC')
    expect(canonicalClientTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(canonicalClientTimeZone('Europe/London')).toBe('Europe/London')
  })

  it('answers the platform-canonical name rather than the alias asked for', () => {
    // A durable record is compared against the zone a later reader derives, so
    // an alias must not survive the boundary. Which name each alias group
    // resolves to is the runtime's ICU data, not this library's choice.
    const canonical = canonicalClientTimeZone('Asia/Chongqing')
    expect(canonical).not.toBe('Asia/Chongqing')
    expect(canonicalClientTimeZone(canonical ?? '')).toBe(canonical)
  })

  it('refuses blank, padded, abbreviated, and single-segment names', () => {
    for (const value of ['', ' ', ' UTC', 'UTC ', 'CST', 'GMT+8', 'Asia', 'utc']) {
      expect(canonicalClientTimeZone(value)).toBeUndefined()
    }
  })

  it('refuses a well-formed name the platform does not support', () => {
    expect(canonicalClientTimeZone('Not/A_Real_Zone')).toBeUndefined()
  })
})

describe('resolveLocalInstants', () => {
  const reading = (value: string) => ({
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
    hour: Number(value.slice(11, 13)),
    minute: Number(value.slice(14, 16)),
    second: Number(value.slice(17, 19)),
    millisecond: 0,
  })
  const utc = (value: string) => Date.parse(`${value}Z`)

  it('resolves one ordinary reading to its single instant', () => {
    // Fixed-offset zone: nothing about the day matters.
    expect(resolveLocalInstants(reading('2026-07-01T12:00:00'), 'Asia/Shanghai'))
      .toEqual({ instants: [utc('2026-07-01T04:00:00')], outOfRange: false })
    expect(resolveLocalInstants(reading('2026-07-01T12:00:00'), 'UTC'))
      .toEqual({ instants: [utc('2026-07-01T12:00:00')], outOfRange: false })
  })

  it('follows the zone offset across a daylight-saving boundary', () => {
    expect(resolveLocalInstants(reading('2026-01-15T12:00:00'), 'America/New_York'))
      .toEqual({ instants: [utc('2026-01-15T17:00:00')], outOfRange: false })
    expect(resolveLocalInstants(reading('2026-07-01T12:00:00'), 'America/New_York'))
      .toEqual({ instants: [utc('2026-07-01T16:00:00')], outOfRange: false })
  })

  it('reports a reading the zone skipped as no instants', () => {
    // 2026-03-08 02:30 does not exist in America/New_York: the clocks jump 02:00 to 03:00.
    expect(resolveLocalInstants(reading('2026-03-08T02:30:00'), 'America/New_York'))
      .toEqual({ instants: [], outOfRange: false })
  })

  it('reports a reading the zone repeated as both instants, ascending', () => {
    // 2026-11-01 01:30 happens twice in America/New_York: once at -04:00, once at -05:00.
    expect(resolveLocalInstants(reading('2026-11-01T01:30:00'), 'America/New_York'))
      .toEqual({ instants: [utc('2026-11-01T05:30:00'), utc('2026-11-01T06:30:00')], outOfRange: false })
  })

  it('reports a reading whose instant falls outside the represented range', () => {
    // The last representable instant read in a negative-offset zone resolves past it.
    expect(resolveLocalInstants(reading('9999-12-31T23:59:59'), 'America/New_York'))
      .toEqual({ instants: [], outOfRange: true })
  })

  it('refuses a reading that names no real calendar time', () => {
    expect(() => resolveLocalInstants(reading('2026-02-30T12:00:00'), 'UTC'))
      .toThrow(RangeError)
  })
})
