/**
 * Five-field cron expression parsing and day matching.
 *
 * The grammar is POSIX crontab with the Vixie extensions every cron daemon
 * accepts: a star, a single value, an inclusive range, a stepped range, a
 * stepped star, a single value with a step, comma lists of those, three-letter
 * month and weekday names, and the `@hourly` family of macros. There is no
 * seconds field, so the smallest period is one minute, and no Quartz `?`, `L`,
 * `W`, or `#`, because those spell a different calendar language whose
 * interactions with a five-field expression are not what an operator expects.
 *
 * When both day fields are restricted the union of their matches fires, which
 * is the Vixie rule; intersecting them silently drops the runs an operator
 * wrote. Restricting one of the two leaves the other unrestricted rather than
 * requiring both.
 * @module @deepseek-ai/dsh-cron
 */

/** Which part of an expression a parse failure names. */
export type CronField = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week'

/** A cron expression that failed to parse, with the field that caused it. */
export class CronExpressionError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'invalid_expression' as const

  /**
   * @param field - the field whose text could not be parsed.
   * @param reason - what is wrong with that field's text.
   */
  constructor(readonly field: CronField, reason: string) {
    super(`${field}: ${reason}`)
    this.name = 'CronExpressionError'
  }
}

/** One parsed five-field expression. Every list is ascending and duplicate-free. */
export interface CronExpression {
  /** The exact text this expression was parsed from. */
  readonly source: string
  /** Matching minutes, 0-59. */
  readonly minutes: readonly number[]
  /** Matching hours, 0-23. */
  readonly hours: readonly number[]
  /** Matching days of the month, 1-31. */
  readonly daysOfMonth: readonly number[]
  /** Matching months, 1-12. */
  readonly months: readonly number[]
  /** Matching days of the week, 0-6 with 0 for Sunday. */
  readonly daysOfWeek: readonly number[]
  /** Whether the day-of-month field was written as anything but `*`. */
  readonly dayOfMonthRestricted: boolean
  /** Whether the day-of-week field was written as anything but `*`. */
  readonly dayOfWeekRestricted: boolean
}

interface FieldSpec {
  readonly field: CronField
  readonly min: number
  readonly max: number
  /** Names accepted in place of numbers, mapped to their values. */
  readonly names?: ReadonlyMap<string, number>
  /** Values that are accepted and folded onto another one, such as 7 for Sunday. */
  readonly aliases?: ReadonlyMap<number, number>
}

const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
  ['JAN', 1], ['FEB', 2], ['MAR', 3], ['APR', 4], ['MAY', 5], ['JUN', 6],
  ['JUL', 7], ['AUG', 8], ['SEP', 9], ['OCT', 10], ['NOV', 11], ['DEC', 12],
])

const WEEKDAY_NAMES: ReadonlyMap<string, number> = new Map([
  ['SUN', 0], ['MON', 1], ['TUE', 2], ['WED', 3], ['THU', 4], ['FRI', 5], ['SAT', 6],
])

/** Vixie's cron accepts 7 as a second spelling of Sunday. */
const WEEKDAY_ALIASES: ReadonlyMap<number, number> = new Map([[7, 0]])

const FIELDS: readonly FieldSpec[] = [
  { field: 'minute', min: 0, max: 59 },
  { field: 'hour', min: 0, max: 23 },
  { field: 'day-of-month', min: 1, max: 31 },
  { field: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { field: 'day-of-week', min: 0, max: 7, names: WEEKDAY_NAMES, aliases: WEEKDAY_ALIASES },
]

/** The `@`-macros every cron daemon ships, expanded to their five fields. */
const MACROS: ReadonlyMap<string, string> = new Map([
  ['@hourly', '0 * * * *'],
  ['@daily', '0 0 * * *'],
  ['@midnight', '0 0 * * *'],
  ['@weekly', '0 0 * * 0'],
  ['@monthly', '0 0 1 * *'],
  ['@yearly', '0 0 1 1 *'],
  ['@annually', '0 0 1 1 *'],
])

/**
 * Parse one five-field cron expression, or a `@`-macro.
 * @param source - the expression text, as an operator wrote it.
 * @returns the parsed expression with ascending, duplicate-free value lists.
 * @throws {CronExpressionError} when the text names no valid expression.
 */
export function parseCronExpression(source: string): CronExpression {
  const trimmed = source.trim()
  const macro = MACROS.get(trimmed.toLowerCase())
  const fields = (macro ?? trimmed).split(/\s+/).filter(part => part.length > 0)
  if (fields.length !== FIELDS.length) {
    throw new CronExpressionError(
      'minute',
      `expected five space-separated fields or a macro, received ${fields.length}`,
    )
  }
  const values = FIELDS.map((spec, index) => parseField(spec, fields[index] as string))
  return {
    source: trimmed,
    minutes: values[0] as readonly number[],
    hours: values[1] as readonly number[],
    daysOfMonth: values[2] as readonly number[],
    months: values[3] as readonly number[],
    daysOfWeek: values[4] as readonly number[],
    dayOfMonthRestricted: (fields[2] as string) !== '*',
    dayOfWeekRestricted: (fields[4] as string) !== '*',
  }
}

/** Parse one field into its ascending, duplicate-free value list. */
function parseField(spec: FieldSpec, text: string): readonly number[] {
  const matched = new Set<number>()
  for (const term of text.split(',')) {
    if (term.length === 0) throw new CronExpressionError(spec.field, 'empty list term')
    for (const value of parseTerm(spec, term)) matched.add(value)
  }
  return [...matched].sort((left, right) => left - right)
}

/** Parse one list term: a star, a value, a range, or any of those with a step. */
function parseTerm(spec: FieldSpec, term: string): readonly number[] {
  const [rangePart, stepPart, extra] = term.split('/')
  if (extra !== undefined) throw new CronExpressionError(spec.field, `"${term}" has more than one step`)
  let step = 1
  if (stepPart !== undefined) {
    step = Number(stepPart)
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new CronExpressionError(spec.field, `"${term}" has a step that is not a positive integer`)
    }
  }
  const [start, end] = parseRange(spec, rangePart as string, term, stepPart !== undefined)
  const values: number[] = []
  // A range is read against the field's raw domain — `5-7` is Friday through
  // Sunday — so an alias such as Sunday's second spelling is folded only after
  // the range has been expanded.
  for (let value = start; value <= end; value += step) values.push(spec.aliases?.get(value) ?? value)
  return values
}

/**
 * Resolve one term's bounds. A bare `*` spans the field's whole domain; a
 * `*` with a step keeps that domain; a single value is its own range, except
 * with a step, where it runs to the field's end the way Vixie's cron reads it.
 */
function parseRange(spec: FieldSpec, rangePart: string, term: string, hasStep: boolean): readonly [number, number] {
  if (rangePart === '*') return [spec.min, spec.max]
  const bounds = rangePart.split('-')
  if (bounds.length > 2) throw new CronExpressionError(spec.field, `"${term}" has more than one range`)
  const start = parseValue(spec, bounds[0] as string, term)
  if (bounds.length === 1) return [start, hasStep ? spec.max : start]
  const end = parseValue(spec, bounds[1] as string, term)
  if (end < start) throw new CronExpressionError(spec.field, `"${term}" ranges backwards`)
  return [start, end]
}

/** Read one value as a number or a field-local name, within the field's raw domain. */
function parseValue(spec: FieldSpec, text: string, term: string): number {
  const named = spec.names?.get(text.toUpperCase())
  const numeric = named ?? Number(text)
  if (!Number.isSafeInteger(numeric)) throw new CronExpressionError(spec.field, `"${term}" is not a number or name`)
  if (numeric < spec.min || numeric > spec.max) {
    throw new CronExpressionError(spec.field, `"${term}" is outside ${spec.min}-${spec.max}`)
  }
  return numeric
}

/**
 * Whether a calendar day matches one expression's two day fields.
 *
 * Only the restricted fields participate, and two restricted fields admit the
 * union of their matches rather than their intersection.
 * @param expression - the parsed expression.
 * @param dayOfMonth - the calendar day, 1-31.
 * @param dayOfWeek - the weekday, 0-6 with 0 for Sunday.
 * @returns whether the day fires.
 */
export function matchesCronDay(expression: CronExpression, dayOfMonth: number, dayOfWeek: number): boolean {
  const byMonth = expression.daysOfMonth.includes(dayOfMonth)
  const byWeek = expression.daysOfWeek.includes(dayOfWeek)
  if (expression.dayOfMonthRestricted && expression.dayOfWeekRestricted) return byMonth || byWeek
  if (expression.dayOfMonthRestricted) return byMonth
  if (expression.dayOfWeekRestricted) return byWeek
  return true
}
