import { describe, expect, it } from 'vitest'
import { synthesizeCustomTheme, synthesizeThemeTokens } from '../src/custom-theme.ts'
import {
  customInputsOf, DEFAULT_CUSTOM_ACCENT, DEFAULT_CUSTOM_CANVAS, DEFAULT_CUSTOM_SCHEME, isHexColor,
  normalizeHexColor, ThemeSettingsSchema, type ThemeSettings,
} from '../src/theme-settings.ts'

/** The schema is the durable wire validator; tests feed it raw partial documents. */
const parseSection = ThemeSettingsSchema as (input: object) => ThemeSettings

const settings = (overrides: Partial<ThemeSettings>): ThemeSettings => ({
  preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
  textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
  customScheme: DEFAULT_CUSTOM_SCHEME, customCanvas: DEFAULT_CUSTOM_CANVAS, customAccent: DEFAULT_CUSTOM_ACCENT,
  ...overrides,
})

describe('isHexColor', () => {
  it('accepts three- and six-digit hex and rejects everything else', () => {
    expect(isHexColor('#fff')).toBe(true)
    expect(isHexColor('#FF6900')).toBe(true)
    expect(isHexColor('ff6900')).toBe(false)
    expect(isHexColor('#12345')).toBe(false)
    expect(isHexColor('orange')).toBe(false)
  })
})

describe('normalizeHexColor', () => {
  it('expands three-digit forms and lowercases both forms', () => {
    expect(normalizeHexColor('#F9a')).toBe('#ff99aa')
    expect(normalizeHexColor('#FF6900')).toBe('#ff6900')
  })

  it('throws on a non-hex value', () => {
    expect(() => { normalizeHexColor('orange') }).toThrow('"orange" is not a hex color; expected #rgb or #rrggbb')
  })
})

describe('ThemeSettingsSchema custom fields', () => {
  it('defaults the custom fields so older documents load unchanged', () => {
    const section = parseSection({})
    expect(section.customScheme).toBe('light')
    expect(section.customCanvas).toBe('#ffffff')
    expect(section.customAccent).toBe('#ff6900')
    expect(section.preference).toBe('system')
  })

  it('accepts a custom preference with hex colors and rejects malformed ones', () => {
    const section = parseSection({ customScheme: 'dark', customCanvas: '#112233', customAccent: '#f60' })
    expect(section.customScheme).toBe('dark')
    expect(section.customCanvas).toBe('#112233')
    expect(section.customAccent).toBe('#f60')
    expect(() => { parseSection({ customCanvas: 'orange' }) }).toThrow()
    expect(() => { parseSection({ customAccent: '#12345' }) }).toThrow()
  })
})

describe('customInputsOf', () => {
  it('canonicalizes both colors and passes the scheme through', () => {
    const inputs = customInputsOf(settings({ customScheme: 'dark', customCanvas: '#F9a', customAccent: '#FF6900' }))
    expect(inputs).toEqual({ scheme: 'dark', canvas: '#ff99aa', accent: '#ff6900' })
  })
})

describe('synthesizeThemeTokens', () => {
  it('derives the light-base surfaces from a white canvas', () => {
    const tokens = synthesizeThemeTokens({ scheme: 'light', canvas: '#ffffff', accent: '#ff6900' })
    expect(tokens['--dsw-alias-bg-base']).toBe('#ffffff')
    // White canvas: the neutral steps clamp to the light ceiling and collapse to one near-white step.
    expect(tokens['--dsw-alias-bg-layer-1']).toBe('#fcfcfc')
    expect(tokens['--dsw-alias-bg-layer-2']).toBe('#fcfcfc')
    expect(tokens['--dsw-alias-bg-layer-3']).toBe('#fcfcfc')
    expect(tokens['--dsw-alias-bg-overlay']).toBe('#fcfcfc')
    expect(tokens['--dsw-alias-bg-module-platform']).toBe('#fcfcfc')
    expect(tokens['--dsw-alias-bg-multi-select']).toBe('#fcfcfc')
    expect(tokens['--dsw-alias-bg-skeleton']).toBe('rgb(38 38 38 / 5%)')
    expect(tokens['--dsw-alias-border-l1']).toBe('rgb(38 38 38 / 7%)')
    expect(tokens['--dsw-alias-border-l2']).toBe('rgb(38 38 38 / 11%)')
    expect(tokens['--dsw-alias-border-l3']).toBe('rgb(38 38 38 / 15%)')
    expect(tokens['--dsw-alias-border-l4']).toBe('rgb(38 38 38 / 20%)')
  })

  it('spends the accent like mono-accent and keeps platform red out of it', () => {
    const tokens = synthesizeThemeTokens({ scheme: 'light', canvas: '#ffffff', accent: '#ff6900' })
    expect(tokens['--dsw-alias-brand-primary']).toBe('#ff6900')
    expect(tokens['--dsw-alias-brand-text']).toBe('#ff6900')
    expect(tokens['--dsw-alias-link']).toBe('#ff6900')
    expect(tokens['--dsw-alias-button-primary-fill']).toBe('#ff6900')
    expect(tokens['--dsw-alias-button-primary-hover']).toBe('#d65900')
    expect(tokens['--dsw-alias-button-primary-dimmed']).toBe('rgb(255 105 0 / 10%)')
    expect(tokens['--dsw-alias-button-info-fill']).toBe('#ff6900')
    expect(tokens['--dsw-alias-button-info-hover']).toBe('#d65900')
    expect(tokens['--dsw-alias-interactive-bg-hover-accent']).toBe('rgb(255 105 0 / 16%)')
    expect(tokens['--dsw-alias-state-business-primary']).toBe('#ff6900')
    expect(tokens['--dsw-alias-state-business-tertiary']).toBe('rgb(255 105 0 / 8%)')
    expect(tokens['--dsw-specific-sidebar-nav-item-active']).toBe('rgb(255 105 0 / 10%)')
    expect(tokens['--dsw-specific-sidebar-nav-item-active-accent']).toBe('#ff6900')
    // Orange reads dark, so text on it stays white; no token touches the error ramp.
    expect(tokens['--dsw-alias-brand-primary-invert']).toBe('#ffffff')
    expect(tokens['--dsw-alias-label-primary-inverted']).toBe('#ffffff')
    expect(tokens['--dsw-alias-label-primary-foreground']).toBe('#ffffff')
    expect(tokens['--dsw-alias-state-error-primary']).toBeUndefined()
  })

  it('derives the dark-base surfaces from a black canvas and lightens the accent hover', () => {
    const tokens = synthesizeThemeTokens({ scheme: 'dark', canvas: '#000000', accent: '#ff6900' })
    expect(tokens['--dsw-alias-bg-base']).toBe('#000000')
    expect(tokens['--dsw-alias-bg-layer-1']).toBe('#0d0d0d')
    expect(tokens['--dsw-alias-bg-layer-2']).toBe('#1a1a1a')
    expect(tokens['--dsw-alias-bg-layer-3']).toBe('#262626')
    expect(tokens['--dsw-alias-bg-skeleton']).toBe('rgb(235 235 235 / 6%)')
    expect(tokens['--dsw-alias-border-l1']).toBe('rgb(235 235 235 / 6%)')
    expect(tokens['--dsw-alias-border-l4']).toBe('rgb(235 235 235 / 20%)')
    expect(tokens['--dsw-alias-button-primary-hover']).toBe('#ff8833')
    expect(tokens['--dsw-alias-button-primary-dimmed']).toBe('rgb(255 105 0 / 18%)')
    expect(tokens['--dsw-alias-state-business-tertiary']).toBe('rgb(255 105 0 / 14%)')
    expect(tokens['--dsw-specific-sidebar-nav-item-active']).toBe('rgb(255 105 0 / 14%)')
  })

  it('inverts labels to ink on light accents', () => {
    const tokens = synthesizeThemeTokens({ scheme: 'light', canvas: '#ffffff', accent: '#ffff00' })
    expect(tokens['--dsw-alias-brand-primary-invert']).toBe('#17171a')
    expect(tokens['--dsw-alias-label-primary-inverted']).toBe('#17171a')
  })

  it('canonically recolors three-digit inputs', () => {
    const tokens = synthesizeThemeTokens({ scheme: 'light', canvas: '#fff', accent: '#F60' })
    expect(tokens['--dsw-alias-bg-base']).toBe('#ffffff')
    expect(tokens['--dsw-alias-brand-primary']).toBe('#ff6600')
  })

  it('covers every hue sextant of the color math through green, yellow, cyan, blue, and magenta inputs', () => {
    const green = synthesizeThemeTokens({ scheme: 'light', canvas: '#00ff00', accent: '#ffff00' })
    expect(green['--dsw-alias-bg-base']).toBe('#00ff00')
    expect(green['--dsw-alias-brand-primary']).toBe('#ffff00')
    const blue = synthesizeThemeTokens({ scheme: 'dark', canvas: '#0000ff', accent: '#00ffff' })
    expect(blue['--dsw-alias-bg-base']).toBe('#0000ff')
    expect(blue['--dsw-alias-brand-primary']).toBe('#00ffff')
    const magenta = synthesizeThemeTokens({ scheme: 'light', canvas: '#ff00ff', accent: '#808080' })
    expect(magenta['--dsw-alias-bg-base']).toBe('#ff00ff')
    expect(magenta['--dsw-alias-brand-primary-invert']).toBe('#ffffff')
  })

  it('throws a teaching error on colors outside the hex forms', () => {
    expect(() => { synthesizeThemeTokens({ scheme: 'light', canvas: 'orange', accent: '#ff6900' }) })
      .toThrow('custom theme colors must be hex (#rgb or #rrggbb), got "orange" / "#ff6900"')
    expect(() => { synthesizeThemeTokens({ scheme: 'light', canvas: '#ffffff', accent: '#12345' }) })
      .toThrow('custom theme colors must be hex')
  })
})

describe('synthesizeCustomTheme', () => {
  it('carries the custom id and the chosen scheme with the derived tokens', () => {
    const inputs = { scheme: 'dark' as const, canvas: '#000000', accent: '#ff6900' }
    const theme = synthesizeCustomTheme(inputs)
    expect(theme.id).toBe('custom')
    expect(theme.colorScheme).toBe('dark')
    expect(theme.tokens).toEqual(synthesizeThemeTokens(inputs))
  })
})
