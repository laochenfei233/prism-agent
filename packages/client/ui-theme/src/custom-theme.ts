/**
 * Custom-theme synthesis: the user picks a base scheme, a canvas color, and an
 * accent color; this module derives the alias-token overrides that recolor the
 * chosen base palette.
 *
 * The result is a partial override layer, not a complete palette: only tokens
 * that must follow the user's colors are derived. Label ramps, state ramps,
 * and interactive surfaces fall through to the base stylesheet, whose proven
 * values guarantee legibility. Two documented assumptions follow from that:
 * the canvas should sit in the scheme's lightness band (light band for light,
 * dark band for dark), and the accent spends like `mono-accent` — one hue on
 * brand, links, primary and info buttons, the business state, and the selected
 * sidebar row — while the error ramp keeps the platform red.
 */

import { CUSTOM_THEME_ID, isHexColor, type CustomThemeInputs, type ThemeColorScheme, type ThemeTokens } from './theme-settings.ts'

/** The synthesized override layer plus the base palette it must layer over. */
export interface CustomThemeDefinition {
  /** The custom preference id. */
  id: typeof CUSTOM_THEME_ID
  /** Base palette the tokens layer over. */
  colorScheme: ThemeColorScheme
  /** Derived alias-token overrides. */
  tokens: ThemeTokens
}

/** 8-bit RGB channels. */
interface Rgb {
  /** Red channel (0..255). */
  r: number
  /** Green channel (0..255). */
  g: number
  /** Blue channel (0..255). */
  b: number
}

/** HSL color: hue in degrees (0..360), saturation and lightness (0..1). */
interface Hsl {
  /** Hue in degrees (0..360). */
  h: number
  /** Saturation (0..1). */
  s: number
  /** Lightness (0..1). */
  l: number
}

/** Highest saturation derived surfaces keep; above it they stop reading as neutral. */
const NEUTRAL_SATURATION = 0.08

/** Canvas-lightness deltas for the raised-surface steps, light and dark base. */
const LIGHT_LAYER_DELTAS = [0.03, 0.06, 0.09] as const
const DARK_LAYER_DELTAS = [0.05, 0.1, 0.15] as const

/** Lightness ceiling for light-base surface steps, so a near-white canvas still yields distinct steps. */
const LIGHT_LAYER_CEILING = 0.99

/** Border alphas over the neutral ink; the graph-paper ramp for light base, the base-dark ramp for dark base. */
const BORDER_ALPHAS = {
  light: [0.07, 0.11, 0.15, 0.2],
  dark: [0.06, 0.12, 0.16, 0.2],
} as const

/** Parse a validated hex color (`#rgb` or `#rrggbb`) into channels. */
function parseHex(value: string): Rgb {
  const channel = (index: number): number => {
    const pair = value.length === 4 ? value.charAt(index + 1).repeat(2) : value.slice(index * 2 + 1, index * 2 + 3)
    return Number.parseInt(pair, 16)
  }
  return { r: channel(0), g: channel(1), b: channel(2) }
}

/** Convert 8-bit RGB to HSL. */
function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  const degrees = Math.round(h * 60)
  return { h: degrees < 0 ? degrees + 360 : degrees, s, l }
}

/** Convert HSL to 8-bit RGB. */
function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const sextant = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((sextant % 2) - 1))
  const m = l - c / 2
  const channel = (value: number): number => Math.round((value + m) * 255)
  if (sextant < 1) return { r: channel(c), g: channel(x), b: channel(0) }
  if (sextant < 2) return { r: channel(x), g: channel(c), b: channel(0) }
  if (sextant < 3) return { r: channel(0), g: channel(c), b: channel(x) }
  if (sextant < 4) return { r: channel(0), g: channel(x), b: channel(c) }
  if (sextant < 5) return { r: channel(x), g: channel(0), b: channel(c) }
  return { r: channel(c), g: channel(0), b: channel(x) }
}

/** Format 8-bit RGB as a lowercase hex color. */
function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * WCAG 2.x relative luminance of a color.
 * @param rgb - 8-bit channels.
 * @returns luminance (0..1).
 */
function relativeLuminance(rgb: Rgb): number {
  const linearize = (channel: number): number => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b)
}

/**
 * Format a color with an alpha channel in the stylesheets' space-separated form.
 * @param rgb - 8-bit channels.
 * @param alpha - opacity (0..1).
 * @returns e.g. `rgb(15 23 42 / 7%)`.
 */
function cssRgb(rgb: Rgb, alpha: number): string {
  const percent = Math.round(alpha * 1000) / 10
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${percent}%)`
}

/**
 * The text color that stays readable on the accent: near-black for light
 * accents, white for everything else.
 * @param accent - accent color (`#rgb`/`#rrggbb`).
 * @returns the inverted-label color.
 */
function readableInvert(accent: string): string {
  return relativeLuminance(parseHex(accent)) > 0.45 ? '#17171a' : '#ffffff'
}

/**
 * Clamp saturation to the neutral band and step the lightness up.
 * @param color - base color.
 * @param delta - lightness delta to add.
 * @param ceiling - lightness ceiling.
 * @returns the stepped color.
 */
function stepSurface(color: Hsl, delta: number, ceiling: number): Hsl {
  return { h: color.h, s: Math.min(color.s, NEUTRAL_SATURATION), l: Math.min(color.l + delta, ceiling) }
}

/**
 * Derive the alias-token overrides for one custom theme. Inputs are validated
 * hex values (`#rgb` or `#rrggbb`); every emitted color is canonical lowercase
 * `#rrggbb`.
 * @param inputs - base scheme, canvas, and accent colors.
 * @returns the override tokens to layer over the scheme's base palette.
 */
export function synthesizeThemeTokens(inputs: CustomThemeInputs): ThemeTokens {
  if (!isHexColor(inputs.canvas) || !isHexColor(inputs.accent)) {
    throw new Error(`custom theme colors must be hex (#rgb or #rrggbb), got "${inputs.canvas}" / "${inputs.accent}"`)
  }
  const canvasRgb = parseHex(inputs.canvas)
  const accentRgb = parseHex(inputs.accent)
  const canvas = rgbToHsl(canvasRgb)
  const accent = rgbToHsl(accentRgb)
  const neutral = { h: canvas.h, s: Math.min(canvas.s, NEUTRAL_SATURATION), l: 0.15 }
  const lightInk = { h: canvas.h, s: Math.min(canvas.s, NEUTRAL_SATURATION), l: 0.92 }
  const dark = inputs.scheme === 'dark'
  const layerDeltas = dark ? DARK_LAYER_DELTAS : LIGHT_LAYER_DELTAS
  const ceiling = dark ? 1 : LIGHT_LAYER_CEILING
  const layer = (index: 0 | 1 | 2): string => rgbToHex(hslToRgb(stepSurface(canvas, layerDeltas[index], ceiling)))
  const layer1 = layer(0)
  const layer2 = layer(1)
  const layer3 = layer(2)
  const borderInk = dark ? lightInk : neutral
  const borders = Object.fromEntries(BORDER_ALPHAS[dark ? 'dark' : 'light']
    .map((alpha, index) => [`--dsw-alias-border-l${index + 1}`, cssRgb(hslToRgb(borderInk), alpha)]))
  const hover = dark
    ? rgbToHex(hslToRgb({ ...accent, l: Math.min(accent.l + 0.1, 1) }))
    : rgbToHex(hslToRgb({ ...accent, l: Math.max(accent.l - 0.08, 0) }))
  const invert = readableInvert(inputs.accent)
  return Object.freeze({
    '--dsw-alias-bg-base': rgbToHex(canvasRgb),
    '--dsw-alias-bg-layer-1': layer1,
    '--dsw-alias-bg-layer-2': layer2,
    '--dsw-alias-bg-layer-3': layer3,
    '--dsw-alias-bg-overlay': layer3,
    '--dsw-alias-bg-module-platform': layer2,
    '--dsw-alias-bg-multi-select': layer2,
    '--dsw-alias-bg-skeleton': cssRgb(dark ? hslToRgb(lightInk) : hslToRgb(neutral), dark ? 0.06 : 0.05),
    ...borders,
    '--dsw-alias-brand-primary': rgbToHex(accentRgb),
    '--dsw-alias-brand-primary-invert': invert,
    '--dsw-alias-brand-text': rgbToHex(accentRgb),
    '--dsw-alias-link': rgbToHex(accentRgb),
    '--dsw-alias-button-primary-fill': rgbToHex(accentRgb),
    '--dsw-alias-button-primary-hover': hover,
    '--dsw-alias-button-primary-dimmed': cssRgb(accentRgb, dark ? 0.18 : 0.1),
    '--dsw-alias-button-info-fill': rgbToHex(accentRgb),
    '--dsw-alias-button-info-hover': hover,
    '--dsw-alias-interactive-bg-hover-accent': cssRgb(accentRgb, 0.16),
    '--dsw-alias-state-business-primary': rgbToHex(accentRgb),
    '--dsw-alias-state-business-tertiary': cssRgb(accentRgb, dark ? 0.14 : 0.08),
    '--dsw-specific-sidebar-nav-item-active': cssRgb(accentRgb, dark ? 0.14 : 0.1),
    '--dsw-specific-sidebar-nav-item-active-accent': rgbToHex(accentRgb),
    '--dsw-alias-label-primary-inverted': invert,
    '--dsw-alias-label-primary-foreground': invert,
  })
}

/**
 * Synthesize the custom theme definition from one set of inputs.
 * @param inputs - base scheme, canvas, and accent colors.
 * @returns the theme definition carrying the derived tokens.
 */
export function synthesizeCustomTheme(inputs: CustomThemeInputs): CustomThemeDefinition {
  return { id: CUSTOM_THEME_ID, colorScheme: inputs.scheme, tokens: synthesizeThemeTokens(inputs) }
}
