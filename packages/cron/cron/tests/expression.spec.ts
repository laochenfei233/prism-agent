import { describe, expect, it } from 'vitest'
import { CronExpressionError, matchesCronDay, parseCronExpression } from '@deepseek-ai/dsh-cron'

/** The five fields of an expression, in order. */
function fields(source: string): readonly (readonly number[])[] {
  const parsed = parseCronExpression(source)
  return [parsed.minutes, parsed.hours, parsed.daysOfMonth, parsed.months, parsed.daysOfWeek]
}

describe('parseCronExpression', () => {
  it('expands every shipped macro to its five fields', () => {
    expect(fields('@hourly')).toEqual([[0], Array.from({ length: 24 }, (_, hour) => hour), expect.any(Array), expect.any(Array), expect.any(Array)])
    expect(parseCronExpression('@daily').minutes).toEqual([0])
    expect(parseCronExpression('@daily').hours).toEqual([0])
    expect(parseCronExpression('@midnight').hours).toEqual([0])
    expect(parseCronExpression('@weekly').daysOfWeek).toEqual([0])
    expect(parseCronExpression('@monthly').daysOfMonth).toEqual([1])
    expect(parseCronExpression('@yearly').months).toEqual([1])
    expect(parseCronExpression('@annually').daysOfMonth).toEqual([1])
    // The macro spelling is not preserved on the parsed value; the text is.
    expect(parseCronExpression('@daily').source).toBe('@daily')
    expect(parseCronExpression(' @DAILY ').source).toBe('@DAILY')
  })

  it('reads stars, values, ranges, steps, and lists', () => {
    expect(parseCronExpression('* * * * *').minutes).toHaveLength(60)
    expect(parseCronExpression('5 * * * *').minutes).toEqual([5])
    expect(parseCronExpression('10-13 * * * *').minutes).toEqual([10, 11, 12, 13])
    expect(parseCronExpression('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCronExpression('10-20/3 * * * *').minutes).toEqual([10, 13, 16, 19])
    expect(parseCronExpression('0,30 * * * *').minutes).toEqual([0, 30])
    expect(parseCronExpression('0 9,17 * * *').hours).toEqual([9, 17])
  })

  it('reads a single value with a step as running to the field end', () => {
    // Vixie's cron and the widely used parsers read `5/15` as `5-59/15`.
    expect(parseCronExpression('5/15 * * * *').minutes).toEqual([5, 20, 35, 50])
    expect(parseCronExpression('0 22/2 * * *').hours).toEqual([22])
    expect(parseCronExpression('0 0 25/10 * *').daysOfMonth).toEqual([25])
  })

  it('accepts three-letter month and weekday names in any case', () => {
    expect(parseCronExpression('0 0 1 JAN *').months).toEqual([1])
    expect(parseCronExpression('0 0 1 dec *').months).toEqual([12])
    expect(parseCronExpression('0 0 * * mon-fri').daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCronExpression('0 0 * * SUN').daysOfWeek).toEqual([0])
    expect(parseCronExpression('0 0 * MAR-JUN *').months).toEqual([3, 4, 5, 6])
  })

  it('folds the second Sunday spelling onto the first', () => {
    // Vixie accepts 7 as Sunday, and a range may not run backwards, so 5-7 is
    // the Fri-to-Sun spelling rather than a rejection.
    expect(parseCronExpression('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parseCronExpression('0 0 * * 5-7').daysOfWeek).toEqual([0, 5, 6])
    expect(parseCronExpression('0 0 * * 0,7').daysOfWeek).toEqual([0])
  })

  it('normalizes lists into ascending, duplicate-free order', () => {
    expect(parseCronExpression('30,5,30,0 * * * *').minutes).toEqual([0, 5, 30])
    expect(parseCronExpression('*/20,0,40 * * * *').minutes).toEqual([0, 20, 40])
  })

  it('records which day fields were restricted', () => {
    expect(parseCronExpression('0 0 * * *')).toMatchObject({ dayOfMonthRestricted: false, dayOfWeekRestricted: false })
    expect(parseCronExpression('0 0 1 * *')).toMatchObject({ dayOfMonthRestricted: true, dayOfWeekRestricted: false })
    expect(parseCronExpression('0 0 * * 1')).toMatchObject({ dayOfMonthRestricted: false, dayOfWeekRestricted: true })
    expect(parseCronExpression('0 0 1 * 1')).toMatchObject({ dayOfMonthRestricted: true, dayOfWeekRestricted: true })
    // A stepped star still covers the whole field, but it was written, so the
    // field counts as restricted exactly as an operator would read it.
    expect(parseCronExpression('0 0 */2 * *').daysOfMonth).toEqual(Array.from({ length: 16 }, (_, index) => 1 + index * 2))
  })

  it('rejects text that is not a five-field expression or a macro', () => {
    for (const source of ['', '* * * *', '* * * * * *', '0 0 1 1', '@nope']) {
      expect(() => parseCronExpression(source)).toThrow(CronExpressionError)
    }
  })

  it('names the field that failed and why', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['60 * * * *', 'minute'],
      ['* 24 * * *', 'hour'],
      ['* * 32 * *', 'day-of-month'],
      ['* * 0 * *', 'day-of-month'],
      ['* * * 13 *', 'month'],
      ['* * * * 8', 'day-of-week'],
      ['* * * * FOO', 'day-of-week'],
      ['5-1 * * * *', 'minute'],
      ['*/0 * * * *', 'minute'],
      ['1,2, * * * *', 'minute'],
      ['1/2/3 * * * *', 'minute'],
      ['1-2-3 * * * *', 'minute'],
    ]
    for (const [source, field] of cases) {
      const error = (() => {
        try {
          parseCronExpression(source)
          return undefined
        } catch (thrown: unknown) {
          return thrown
        }
      })()
      expect(error, source).toBeInstanceOf(CronExpressionError)
      expect((error as CronExpressionError).field, source).toBe(field)
      expect((error as CronExpressionError).code, source).toBe('invalid_expression')
    }
  })
})

describe('matchesCronDay', () => {
  it('fires every day when neither day field is restricted', () => {
    const expression = parseCronExpression('0 0 * * *')
    expect(matchesCronDay(expression, 1, 0)).toBe(true)
    expect(matchesCronDay(expression, 31, 6)).toBe(true)
  })

  it('uses only the restricted field when one is a star', () => {
    const byMonth = parseCronExpression('0 0 15 * *')
    expect(matchesCronDay(byMonth, 15, 3)).toBe(true)
    expect(matchesCronDay(byMonth, 16, 3)).toBe(false)
    const byWeek = parseCronExpression('0 0 * * 1')
    expect(matchesCronDay(byWeek, 15, 1)).toBe(true)
    expect(matchesCronDay(byWeek, 15, 2)).toBe(false)
  })

  it('admits the union when both day fields are restricted', () => {
    // 2026-06-01 is a Monday: the expression fires on the first of the month and
    // on every Monday, not only on a Monday that is also the first.
    const expression = parseCronExpression('0 0 1 * 1')
    expect(matchesCronDay(expression, 1, 3)).toBe(true)
    expect(matchesCronDay(expression, 8, 1)).toBe(true)
    expect(matchesCronDay(expression, 8, 3)).toBe(false)
  })
})
