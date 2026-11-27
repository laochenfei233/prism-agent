/** Carrier detection and view derivation for the About section. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyEndpoint,
  customEndpointsOf,
  deriveButtonState,
  deriveSourceMode,
  deriveSourceView,
  endpointsForMode,
  isValidEndpoint,
  readCarrier,
  withPrimary,
  type DesktopUpdateCarrier,
} from '../src/client/about-bridge.ts'

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

describe('deriveSourceView', () => {
  it('shows the mirror host as display-only text when it is configured', () => {
    const view = deriveSourceView({
      host: 'prism.xyern.com',
      repo: 'laochenfei233/prism-agent',
      releaseUrl: 'https://github.com/laochenfei233/prism-agent/releases',
    })
    expect(view).toEqual({ badgeKey: 'sourceMirror', href: '', label: 'prism.xyern.com' })
  })

  it('keeps the repository link on a bare GitHub configuration', () => {
    const view = deriveSourceView({
      repo: 'laochenfei233/prism-agent',
      releaseUrl: 'https://github.com/laochenfei233/prism-agent/releases',
    })
    expect(view).toEqual({
      badgeKey: 'sourceGitHub',
      href: 'https://github.com/laochenfei233/prism-agent/releases',
      label: 'laochenfei233/prism-agent',
    })
  })

  it('labels a custom selection with its own host and the custom badge', () => {
    const view = deriveSourceView({
      custom: true,
      host: 'updates.example.com',
      repo: '',
      releaseUrl: '',
    })
    expect(view).toEqual({ badgeKey: 'sourceCustom', href: '', label: 'updates.example.com' })
  })

  it('keeps the GitHub badge for a custom list that starts on GitHub', () => {
    const view = deriveSourceView({
      custom: true,
      host: '',
      repo: 'laochenfei233/prism-agent',
      releaseUrl: 'https://github.com/laochenfei233/prism-agent/releases',
    })
    expect(view).toEqual({
      badgeKey: 'sourceGitHub',
      href: 'https://github.com/laochenfei233/prism-agent/releases',
      label: 'laochenfei233/prism-agent',
    })
  })

  it('falls back to the unavailable state without recognizable facts', () => {
    expect(deriveSourceView(undefined)).toEqual({ badgeKey: 'sourceGitHub', href: '', label: '' })
    expect(deriveSourceView({})).toEqual({ badgeKey: 'sourceGitHub', href: '', label: '' })
    expect(deriveSourceView({ repo: '', releaseUrl: '' })).toEqual({ badgeKey: 'sourceGitHub', href: '', label: '' })
  })
})

describe('source panel helpers', () => {
  it('validates absolute http(s) endpoints with a host', () => {
    expect(isValidEndpoint('https://example.com/updates/latest.json')).toBe(true)
    expect(isValidEndpoint('http://192.168.1.2:8080/latest.json')).toBe(true)
    expect(isValidEndpoint('ftp://example.com/latest.json')).toBe(false)
    expect(isValidEndpoint('example.com/latest.json')).toBe(false)
    expect(isValidEndpoint('https://')).toBe(false)
    expect(isValidEndpoint('')).toBe(false)
  })

  it('moves the chosen endpoint to the front without duplicating it', () => {
    expect(withPrimary(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(withPrimary(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
    expect(withPrimary(['a'], 'a')).toEqual(['a'])
  })
})

describe('source modes', () => {
  const MIRROR = 'https://cdn.xyern.com/prism-agent/updates/latest.json'
  const GITHUB = 'https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json'
  const DEFAULTS = [MIRROR, GITHUB]
  const CUSTOM = 'https://mirror.example.com/prism/latest.json'

  it('classifies endpoints into the three families', () => {
    expect(classifyEndpoint(MIRROR)).toBe('mirror')
    expect(classifyEndpoint(GITHUB)).toBe('github')
    expect(classifyEndpoint(CUSTOM)).toBe('custom')
    expect(classifyEndpoint('not a url')).toBe('custom')
  })

  it('derives the mode from the first endpoint', () => {
    expect(deriveSourceMode(DEFAULTS)).toBe('mirror')
    expect(deriveSourceMode([GITHUB])).toBe('github')
    expect(deriveSourceMode([CUSTOM, GITHUB])).toBe('custom')
    expect(deriveSourceMode([])).toBe('mirror')
  })

  it('builds the endpoint list per mode with the GitHub fallback behind custom', () => {
    expect(endpointsForMode('mirror', DEFAULTS, [])).toEqual(DEFAULTS)
    expect(endpointsForMode('github', DEFAULTS, [CUSTOM])).toEqual([GITHUB])
    expect(endpointsForMode('custom', DEFAULTS, [CUSTOM])).toEqual([CUSTOM, GITHUB])
    expect(endpointsForMode('custom', DEFAULTS, [])).toEqual([GITHUB])
  })

  it('lists only the custom endpoints of an active list', () => {
    expect(customEndpointsOf([CUSTOM, GITHUB, CUSTOM])).toEqual([CUSTOM, CUSTOM])
    expect(customEndpointsOf(DEFAULTS)).toEqual([])
  })
})
