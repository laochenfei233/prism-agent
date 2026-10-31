// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjections, type BootCustomPalette } from '../src/boot-theme.ts'
import type { FontFamilies, FontSizes, ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(
  preference?: ThemePreference,
  fontSizes?: FontSizes,
  fontFamilies?: FontFamilies,
  custom?: BootCustomPalette,
): void {
  for (const row of bootThemeInjections(preference, fontSizes, fontFamilies, custom)) {
    if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.dsThemeSource
  document.body.removeAttribute(DARK_ATTRIBUTE)
  for (const name of ['--dsh-content-font-size', '--dsh-code-font-size', '--dsh-terminal-font-size']) document.body.style.removeProperty(name)
  for (const kind of ['text', 'code', 'terminal']) document.body.style.removeProperty(`--dsh-font-family-${kind}`)
})

describe('theme bootstrap row', () => {
  it('colors the body with head CSS before applying body state', () => {
    mockSystemDark(false)
    const [head, body] = bootThemeInjections('dark')
    expect(head).toMatchObject({ kind: 'style' })
    expect(body).toMatchObject({ kind: 'script', placement: 'body' })
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    const [head] = bootThemeInjections('light')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}')
    executeBootstrap('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, true],
    [false, false],
  ] as const)('resolves system=%s for the body palette', (matches, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('uses a media query for the system canvas palette', () => {
    const [head] = bootThemeInjections('system')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(
      ':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}'
      + '@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}',
    )
  })

  it('paints a designed theme canvas and resolves its own palette, not the OS one', () => {
    mockSystemDark(true)
    const [head] = bootThemeInjections('graph-glass')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#f2f3f5;--dsh-boot-bg:#f2f3f5}')
    executeBootstrap('graph-glass')
    expect(document.documentElement.dataset.dsThemeSource).toBe('graph-glass')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)

    mockSystemDark(false)
    executeBootstrap('strata-dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('paints the stored custom canvas and palette mode, ignoring the OS scheme', () => {
    mockSystemDark(true)
    const [head] = bootThemeInjections('custom', undefined, undefined, { canvas: '#1b3a57', dark: true })
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:dark}body{background-color:#1b3a57;--dsh-boot-bg:#1b3a57}')
    executeBootstrap('custom', undefined, undefined, { canvas: '#1b3a57', dark: true })
    expect(document.documentElement.dataset.dsThemeSource).toBe('custom')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('falls back to the custom defaults when no custom palette is resolved', () => {
    mockSystemDark(false)
    const [head] = bootThemeInjections('custom')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#ffffff;--dsh-boot-bg:#ffffff}')
    executeBootstrap('custom')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the durable font sizes and their defaults', () => {
    mockSystemDark(false)
    executeBootstrap('light', { text: 22, code: 15, terminal: 18 })
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('22px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('15px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('18px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('11px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('13px')
  })

  it('writes normalized durable font lists and leaves empty lists unset', () => {
    mockSystemDark(false)
    const [, body] = bootThemeInjections('light', undefined, { text: 'Inter', code: '', terminal: 'MesloLGS NF</script>, monospace' })
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    expect(body.text).not.toContain('<')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.body.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    expect(document.body.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    expect(document.body.style.getPropertyValue('--dsh-font-family-terminal')).toBe('"MesloLGS NF/script", monospace')
  })
})
