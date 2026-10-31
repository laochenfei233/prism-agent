/** Carrier detection and view derivation for the About section. */
import { afterEach, describe, expect, it } from 'vitest'
import { deriveButtonState, readCarrier, type DesktopUpdateCarrier } from '../src/client/about-bridge.ts'

/** Installs one carrier-shaped stub on the global for a test. */
function stubCarrier(value: unknown): void {
  (globalThis as { dshDesktop?: unknown }).dshDesktop = value
}

afterEach(() => {
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

describe('readCarrier', () => {
  const full: DesktopUpdateCarrier = {
    status: async () => ({ phase: 'idle' }),
    open: async () => undefined,
    subscribe: () => () => undefined,
  }

  it('returns null when nothing injected the carrier', () => {
    expect(readCarrier()).toBeNull()
  })

  it('returns null for unknown protocol versions', () => {
    stubCarrier({ protocolVersion: 2, updates: full })
    expect(readCarrier()).toBeNull()
    stubCarrier({ updates: full })
    expect(readCarrier()).toBeNull()
  })

  it('returns null when required bridge methods are missing', () => {
    stubCarrier({ protocolVersion: 1, updates: { status: full.status, open: full.open } })
    expect(readCarrier()).toBeNull()
    stubCarrier({ protocolVersion: 1, updates: {} })
    expect(readCarrier()).toBeNull()
    stubCarrier({ protocolVersion: 1 })
    expect(readCarrier()).toBeNull()
  })

  it('accepts the shell carrier without the additive check', () => {
    stubCarrier({ protocolVersion: 1, updates: full })
    expect(readCarrier()).toBe(full)
  })

  it('accepts the carrier with the additive check', () => {
    const extended: DesktopUpdateCarrier = { ...full, check: async () => ({ phase: 'idle' }) }
    stubCarrier({ protocolVersion: 1, updates: extended })
    expect(readCarrier()).toBe(extended)
  })
})

describe('deriveButtonState', () => {
  it('keeps a quiet idle as the plain check action until a check completes', () => {
    expect(deriveButtonState('idle', false)).toBe('idle')
    expect(deriveButtonState('idle', true)).toBe('upToDate')
  })

  it('renders the busy phases as a disabled check and the transfer phases as progress', () => {
    expect(deriveButtonState('checking', false)).toBe('checking')
    expect(deriveButtonState('downloading', false)).toBe('progress')
    expect(deriveButtonState('verifying', false)).toBe('progress')
    expect(deriveButtonState('installing', false)).toBe('progress')
    expect(deriveButtonState('ready', false)).toBe('progress')
  })

  it('offers the update and retry actions', () => {
    expect(deriveButtonState('available', false)).toBe('available')
    expect(deriveButtonState('error', true)).toBe('error')
  })
})
