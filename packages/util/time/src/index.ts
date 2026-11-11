/**
 * Time vocabulary shared by the boundaries that accept a caller's zone or a
 * wall-clock selector, elapsed span, or bounded Cron/RRULE recurrence.
 *
 * The library validates, canonicalizes, parses, and renders one canonical instant
 * format; it produces no model-facing text and owns no failure vocabulary. A refusal that carries a
 * reason is a discriminated result, and each caller maps that reason onto its
 * own domain code and diagnostic. `canonicalClientTimeZone` is the wire-boundary
 * form and answers a name or `undefined`; `formatFourDigitYearInstant` and
 * `resolveLocalInstant` take already-validated values and answer a string or
 * epoch milliseconds directly; `resolveLocalInstants` projects a wall-clock
 * reading in a zone to every instant that reading denotes; `Duration` holds a
 * span in milliseconds with no implicit numeric conversion. Cron and RRule
 * parse distinct recurrence types and compute occurrences from explicit times
 * without task state or timers.
 * @module @deepseek-ai/dsh-util-time
 */

import { canonicalizeTimeZone } from './instant.ts'

export { Duration } from './duration.ts'
export {
  MAX_FOUR_DIGIT_YEAR_MS,
  MIN_FOUR_DIGIT_YEAR_MS,
  canonicalizeTimeZone,
  formatFourDigitYearInstant,
  fourDigitYearEpoch,
  isFourDigitYearInstant,
  parseLocalCalendar,
  parseOffsetInstant,
  resolveLocalInstant,
} from './instant.ts'
export type { InstantRejection, LocalCalendarRejection, LocalCalendarTime, TimeZoneRejection } from './instant.ts'

/** One wall-clock reading with no implied offset. */
export interface LocalCalendarTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly millisecond: number
}

/** The instants one wall-clock reading denotes in one zone. */
export interface LocalInstantCandidates {
  /**
   * Ascending instants whose projection in the zone is exactly the requested
   * reading. One instant is the ordinary case, two mean the zone repeated the
   * reading, and none means the zone skipped it.
   */
  readonly instants: readonly number[]
  /** Whether the reading falls outside the four-digit-year range this vocabulary represents. */
  readonly outOfRange: boolean
}

/** The `longOffset` spelling `Intl` emits, with an optional seconds component. */
const OFFSET_NAME = /^GMT(?:(?<sign>[+-])(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?)?$/

/** Read one required named regular-expression group as a number. */
function groupNumber(groups: Record<string, string | undefined>, name: string): number {
  const value = groups[name]
  /* v8 ignore next -- the fixed OFFSET_NAME pattern always provides every requested group. */
  if (value === undefined) throw new RangeError('zone offset part is missing')
  return Number(value)
}

/** The formatter one zone needs to report both its local fields and its own offset. */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
}

/** Project one instant into a zone's exact local fields and the offset that produced them. */
function project(formatter: Intl.DateTimeFormat, epoch: number): LocalCalendarTime & { offset: number } {
  const values = Object.fromEntries(formatter.formatToParts(epoch).map(part => [part.type, part.value]))
  const zoneName = values['timeZoneName']
  /* v8 ignore next -- a formatter configured with longOffset always emits this part. */
  const offsetMatch = typeof zoneName === 'string' ? OFFSET_NAME.exec(zoneName) : null
  const offsetGroups = offsetMatch?.groups
  /* v8 ignore next -- the formatter requested longOffset, whose part is defined by Intl. */
  if (offsetGroups === undefined) throw new RangeError('zone did not expose a usable UTC offset')
  const direction = offsetGroups['sign'] === '-' ? -1 : 1
  /* v8 ignore next -- some Intl builds spell UTC as bare GMT instead of GMT+00:00. */
  const offset = offsetGroups['sign'] === undefined
    ? 0
    : direction * (
      groupNumber(offsetGroups, 'hour') * 3600
      + groupNumber(offsetGroups, 'minute') * 60
      + Number(offsetGroups['second'] ?? '0')
    ) * 1_000
  return {
    year: Number(values['year']),
    month: Number(values['month']),
    day: Number(values['day']),
    hour: Number(values['hour']),
    minute: Number(values['minute']),
    second: Number(values['second']),
    millisecond: Number(values['fractionalSecond']),
    offset,
  }
}

/**
 * Convert one wall-clock reading to the UTC-shaped epoch that carries the same
 * fields, rejecting a reading that names no real calendar time.
 *
 * This is the value a zone projection compares candidates against, not an
 * instant: nothing here decides which offset applies to the reading.
 * @param parts - the wall-clock reading.
 * @returns the epoch whose UTC fields equal the reading.
 * @throws {RangeError} when the reading names no real calendar time.
 */
export function localCalendarEpoch(parts: LocalCalendarTime): number {
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  value.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond)
  const epoch = value.getTime()
  if (!Number.isFinite(epoch)
    || value.getUTCFullYear() !== parts.year
    || value.getUTCMonth() + 1 !== parts.month
    || value.getUTCDate() !== parts.day
    || value.getUTCHours() !== parts.hour
    || value.getUTCMinutes() !== parts.minute
    || value.getUTCSeconds() !== parts.second
    || value.getUTCMilliseconds() !== parts.millisecond) {
    throw new RangeError('the requested reading is not a real calendar time')
  }
  return epoch
}

/**
 * Enumerate the instants one wall-clock reading denotes in one IANA zone.
 *
 * The answer is data, not policy: a reading the zone skipped returns no
 * instants, a reading the zone repeated returns both in ascending order, and
 * the caller decides which one a rule means and what to report when there is
 * none. Zone offsets are sampled around the reading, so a daylight-saving
 * transition inside that window is what produces two instants or none.
 * @param parts - the wall-clock reading, which must name a real calendar time.
 * @param timeZone - the IANA zone the reading is stated in.
 * @returns the ascending instants, and whether the reading is outside the represented range.
 * @throws {RangeError} when the reading names no real calendar time.
 */
export function resolveLocalInstants(parts: LocalCalendarTime, timeZone: string): LocalInstantCandidates {
  const localEpoch = localCalendarEpoch(parts)
  const formatter = zoneFormatter(timeZone)
  const offsets = new Set<number>()
  for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) {
    const sample = Math.min(MAX_FOUR_DIGIT_YEAR_MS, Math.max(MIN_FOUR_DIGIT_YEAR_MS, localEpoch + delta))
    offsets.add(project(formatter, sample).offset)
  }
  const instants: number[] = []
  let outOfRange = false
  for (const offset of offsets) {
    const candidate = localEpoch - offset
    if (candidate < MIN_FOUR_DIGIT_YEAR_MS || candidate > MAX_FOUR_DIGIT_YEAR_MS) {
      outOfRange = true
      continue
    }
    const projected = project(formatter, candidate)
    if (projected.year === parts.year
      && projected.month === parts.month
      && projected.day === parts.day
      && projected.hour === parts.hour
      && projected.minute === parts.minute
      && projected.second === parts.second
      && projected.millisecond === parts.millisecond) {
      instants.push(candidate)
    }
  }
  return { instants: instants.sort((left, right) => left - right), outOfRange }
}

/**
 * Validate and canonicalize one caller-supplied IANA zone at a wire boundary.
 *
 * The canonical name is what a later reader needs: a zone identity is stored on
 * durable records and resolved again by another process, so an alias accepted
 * here would not compare equal to the zone a reader derives.
 * @param value - the caller's reported zone name.
 * @returns the canonical zone, or `undefined` when the name is unusable.
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  const resolved = canonicalizeTimeZone(value)
  return resolved.kind === 'accepted' ? resolved.timeZone : undefined
}

export { Cron, CRON_SEARCH_HORIZON_YEARS } from './cron.ts'
export type { CronFields } from './cron.ts'
export { RRule } from './rrule.ts'
export type { RecurrenceOccurrence, RecurrenceRejection, RecurrenceResult } from './recurrence.ts'
