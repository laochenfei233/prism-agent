/** The failure vocabulary both transcription entry points share. */
import { describe, expect, it } from 'vitest'
import { failureOf, OPENAI_API_KEY_ERROR, OPENAI_TIMEOUT_CODE, OpenAiTimeoutError } from '../src/errors.ts'

describe('failureOf', () => {
  it('keeps an Error as it is', () => {
    const original = new Error('kept')
    expect(failureOf(original)).toBe(original)
  })

  it('wraps a value that is not an Error', () => {
    expect(failureOf('stopped')).toEqual(new Error('stopped'))
    expect(failureOf(undefined)).toEqual(new Error('undefined'))
  })
})

describe('the shared vocabulary', () => {
  it('names the deadline and the missing credential', () => {
    expect(OPENAI_TIMEOUT_CODE).toBe('OPENAI_TRANSCRIPTION_TIMEOUT')
    expect(OPENAI_API_KEY_ERROR).toContain('requires an API key')
  })

  it('reports the deadline that elapsed', () => {
    expect(new OpenAiTimeoutError(25)).toMatchObject({ name: 'OpenAiTimeoutError', timeoutMs: 25 })
  })
})
