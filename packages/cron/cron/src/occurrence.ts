/**
 * Occurrence resolution: the next instant one parsed expression fires at, in an
 * explicit IANA zone.
 *
 * Candidate readings are enumerated with plain calendar arithmetic over UTC day
 * numbers, and the zone enters at exactly one point — {@link resolveLocalInstants}
 * — which reports a skipped or repeated hour as data. A reading the zone skipped
 * is therefore passed over rather than guessed at, and a reading the zone
 * repeated contributes both instants so the earliest one that follows the
 * reference instant wins.
 * @module @deepseek-ai/dsh-cron/occurrence
 */

import { MAX_FOUR_DIGIT_YEAR_MS, MIN_FOUR_DIGIT_YEAR_MS, localCalendarEpoch, resolveLocalInstants } from '@deepseek-ai/dsh-util-time'
import type { LocalCalendarTime } from '@deepseek-ai/dsh-util-time'
import { matchesCronDay } from './expression.ts'
import type { CronExpression } from './expression.ts'

/** Milliseconds in one day, the step of the candidate-day scan. */
const DAY_MS = 86_400_000

/**
 * Largest real UTC offset, +14:00. A reading further than this before the
 * reference instant cannot resolve to an instant after it, in any zone.
 */
const MAX_ZONE_OFFSET_MS = 14 * 3_600_000

/**
 * How many days the search walks before answering `undefined`. Leap days recur
 * within four years, except across a skipped century leap year such as 2100,
 * where the gap is eight.
 */
export const MAX_SEARCH_DAYS = 366 * 9

/**
 * Resolve the first instant strictly after `afterEpoch` at which the expression
 * fires in the zone.
 * @param expression - a parsed expression.
 * @param timeZone - the IANA zone the rule is stated in; the caller canonicalizes it.
 * @param afterEpoch - the reference instant; the answer is strictly later.
 * @returns the next instant, or `undefined` when the rule does not fire within {@link MAX_SEARCH_DAYS}.
 */
export function nextCronOccurrence(expression: CronExpression, timeZone: string, afterEpoch: number): number | undefined {
  const firstDay = Math.floor(afterEpoch / DAY_MS) - 1
  const floor = afterEpoch - MAX_ZONE_OFFSET_MS
  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset += 1) {
    const day = new Date((firstDay + offset) * DAY_MS)
    const year = day.getUTCFullYear()
    const month = day.getUTCMonth() + 1
    const dayOfMonth = day.getUTCDate()
    if (!expression.months.includes(month)) continue
    if (!matchesCronDay(expression, dayOfMonth, day.getUTCDay())) continue
    const found = firstInstantOnDay(expression, timeZone, { year, month, day: dayOfMonth }, floor, afterEpoch)
    if (found !== undefined) return found
  }
  return undefined
}

/** One candidate calendar day, named the way the shared reading type names it. */
interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/**
 * The earliest instant this day contributes that is strictly after the
 * reference. Readings ascend, so the instants do too, and the first qualifying
 * one is the day's answer.
 */
function firstInstantOnDay(
  expression: CronExpression,
  timeZone: string,
  date: CalendarDate,
  floor: number,
  afterEpoch: number,
): number | undefined {
  for (const hour of expression.hours) {
    for (const minute of expression.minutes) {
      const reading: LocalCalendarTime = { ...date, hour, minute, second: 0, millisecond: 0 }
      if (localCalendarEpoch(reading) <= floor) continue
      for (const instant of resolveLocalInstants(reading, timeZone).instants) {
        if (instant > afterEpoch && instant >= MIN_FOUR_DIGIT_YEAR_MS && instant <= MAX_FOUR_DIGIT_YEAR_MS) return instant
      }
    }
  }
  return undefined
}
