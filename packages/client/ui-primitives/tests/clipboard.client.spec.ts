// @vitest-environment jsdom
/** Clipboard read: the async API only, with a refused or missing host surfaced as a rejection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readClipboard } from '../src/clipboard.ts'

const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

/** Install one host clipboard shape for the duration of a case. */
function installClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

afterEach(() => {
  if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', prior)
})

describe('readClipboard', () => {
  it('returns the text the host clipboard holds', async () => {
    installClipboard({ readText: vi.fn(async () => 'annotation json') })
    await expect(readClipboard()).resolves.toBe('annotation json')
  })

  it('rejects when the host exposes no read API', async () => {
    installClipboard(undefined)
    await expect(readClipboard()).rejects.toThrow('no clipboard read API')
  })

  it('propagates a refused read', async () => {
    installClipboard({ readText: vi.fn(async () => { throw new Error('permission denied') }) })
    await expect(readClipboard()).rejects.toThrow('permission denied')
  })
})
