/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference, font sizes, and
 * font-family lists. Head CSS colors the document canvas before script
 * execution; the body script installs the palette selector and font variables
 * that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { BUILTIN_THEMES, bootBackgroundOf } from './builtin-themes.ts'
import {
  DEFAULT_CUSTOM_CANVAS, DEFAULT_CUSTOM_SCHEME, DEFAULT_FONT_SIZES, DEFAULT_PREFERENCE, FONT_ROLES, FONT_SIZE_SPECS,
  fontFamilyVariable, normalizeFontFamily, type FontFamilies, type FontSizes, type ThemePreference,
} from './theme-settings.ts'

/** Resolved custom-theme values the boot scripts need when the preference is `custom`. */
export interface BootCustomPalette {
  /** Canvas color painted before the stylesheets load. */
  canvas: string
  /** Whether the custom theme builds on the dark base palette. */
  dark: boolean
}

/** Palette mode a preference resolves to before any media query is consulted. */
function schemeOf(preference: ThemePreference): 'light' | 'dark' {
  return BUILTIN_THEMES.find(theme => theme.id === preference)?.colorScheme ?? 'light'
}

/**
 * The custom values a boot run paints with. An unresolved custom palette (a
 * caller without a stored custom theme) equals the schema defaults.
 * @param custom - resolved custom palette from the Host config, if any.
 * @returns the custom canvas and palette mode.
 */
function resolveCustom(custom: BootCustomPalette | undefined): BootCustomPalette {
  return custom ?? { canvas: DEFAULT_CUSTOM_CANVAS, dark: DEFAULT_CUSTOM_SCHEME === 'dark' }
}

/**
 * CSS that colors the document canvas before any script executes. A fixed
 * preference paints its own theme's canvas color (`custom` paints the stored
 * custom canvas); `system` paints the light canvas and lets the media query
 * swap in the dark one.
 * @param preference - persisted preference.
 * @param custom - resolved custom palette for the `custom` preference.
 * @returns the head style text.
 */
function bootThemeStyle(preference: ThemePreference, custom: BootCustomPalette | undefined): string {
  if (preference === 'custom') {
    const resolved = resolveCustom(custom)
    return `:root{color-scheme:${resolved.dark ? 'dark' : 'light'}}body{background-color:${resolved.canvas};--dsh-boot-bg:${resolved.canvas}}`
  }
  if (preference !== 'system') {
    const background = bootBackgroundOf(preference, false)
    const dark = schemeOf(preference) === 'dark'
    return `:root{color-scheme:${dark ? 'dark' : 'light'}}body{background-color:${background};--dsh-boot-bg:${background}}`
  }
  const light = `:root{color-scheme:light}body{background-color:${bootBackgroundOf('light', false)};--dsh-boot-bg:${bootBackgroundOf('light', false)}}`
  const dark = `:root{color-scheme:dark}body{background-color:${bootBackgroundOf('dark', true)};--dsh-boot-bg:${bootBackgroundOf('dark', true)}}`
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/** Preference ids whose base palette is dark, projected into the boot script. */
const DARK_THEME_IDS = JSON.stringify(BUILTIN_THEMES.filter(theme => theme.colorScheme === 'dark').map(theme => theme.id))

/**
 * Build the body script that installs the palette selector and content size.
 * @param preference - persisted preference.
 * @param fontSize - content font size in px.
 * @param custom - resolved custom palette; embeds the dark flag for `custom`.
 * @returns the body script text.
 */
function bootThemeBodyScript(
  preference: ThemePreference,
  fontSizes: FontSizes,
  fontFamilies: FontFamilies,
  custom: BootCustomPalette | undefined,
): string {
  const sizes = FONT_ROLES.map(role =>
    `\n  document.body.style.setProperty(${JSON.stringify(FONT_SIZE_SPECS[role].variable)}, ${JSON.stringify(`${fontSizes[role]}px`)})`).join('')
  const families = FONT_ROLES.flatMap((kind) => {
    const list = normalizeFontFamily(fontFamilies[kind])
    return list === '' ? [] : [`\n  document.body.style.setProperty(${JSON.stringify(fontFamilyVariable(kind))}, ${JSON.stringify(list)})`]
  }).join('')
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const darkIds = ${DARK_THEME_IDS}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'custom'
    ? ${JSON.stringify(resolveCustom(custom).dark)}
    : preference === 'system' ? systemDark : darkIds.includes(preference)
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)${sizes}${families}
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector and font
 * size and font families before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSizes - Current Host-backed font sizes in px by role.
 * @param fontFamilies - Current Host-backed font lists; each is normalized before embedding.
 * @param custom - Resolved custom palette for the `custom` preference; omitted
 *   resolves to the custom schema defaults.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSizes: FontSizes = DEFAULT_FONT_SIZES,
  fontFamilies: FontFamilies = { text: '', code: '', terminal: '' },
  custom: BootCustomPalette | undefined = undefined,
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference, custom) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSizes, fontFamilies, custom) },
  ]
}
