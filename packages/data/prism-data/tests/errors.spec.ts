/** The route's failure vocabulary: status per code and the message a throw contributes. */

import { describe, expect, it } from 'vitest'
import { DataError, messageOf, statusOf } from '../src/errors.ts'

describe('statusOf', () => {
  it.each([
    ['prism-data/bad-request', 400],
    ['prism-data/target-invalid', 400],
    ['prism-data/busy', 409],
    ['prism-data/target-not-empty', 409],
    ['prism-data/copy-failed', 500],
    ['prism-data/pointer-failed', 500],
  ] as const)('maps %s to %i', (code, status) => {
    expect(statusOf(code)).toBe(status)
  })
})

describe('messageOf', () => {
  it('reads an error message and stringifies anything else', () => {
    expect(messageOf(new DataError('prism-data/busy', 'already running'))).toBe('already running')
    expect(messageOf('boom')).toBe('boom')
  })
})
