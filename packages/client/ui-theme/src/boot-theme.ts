/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference and content font size.
 * Head CSS colors the document canvas before script execution; the body script
 * installs the palette selector and font size that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { BUILTIN_THEMES, bootBackgroundOf } from './builtin-themes.ts'
import { DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, type ThemePreference } from './theme-settings.ts'

/** Palette mode a preference resolves to before any media query is consulted. */
function schemeOf(preference: ThemePreference): 'light' | 'dark' {
  return BUILTIN_THEMES.find(theme => theme.id === preference)?.colorScheme ?? 'light'
}

/**
 * CSS that colors the document canvas before any script executes. A fixed
 * preference paints its own theme's canvas color; `system` paints the light
 * canvas and lets the media query swap in the dark one.
 * @param preference - persisted preference.
 * @returns the head style text.
 */
function bootThemeStyle(preference: ThemePreference): string {
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
 * @returns the body script text.
 */
function bootThemeBodyScript(preference: ThemePreference, fontSize: number): string {
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const darkIds = ${DARK_THEME_IDS}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'system' ? systemDark : darkIds.includes(preference)
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', ${JSON.stringify(`${fontSize}px`)})
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector and font
 * size before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSize - Current Host-backed content font size in px.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSize) },
  ]
}
