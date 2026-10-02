/** Theme preferences and palette declarations shared by the Host and browser halves. */

import z from '@deepseek-ai/schemastery'

/** Base palettes carried by the global stylesheets; every other theme builds on one of them. */
export const BUILTIN_SCHEMES = ['light', 'dark'] as const

/** Theme ids this package ships; the picklist the Host schema and the browser registry agree on. */
export const BUILTIN_THEME_IDS = ['light', 'dark', 'graph-glass', 'mono-accent', 'strata-dark'] as const

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['system', ...BUILTIN_THEME_IDS] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** One built-in theme id. */
export type BuiltinThemeId = typeof BUILTIN_THEME_IDS[number]

/** Theme preference persisted by the product Appearance gallery. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Palette mode one theme builds on. */
export type ThemeColorScheme = typeof BUILTIN_SCHEMES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 12

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 17

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_FONT_SIZE = 14

/** Theme token dictionary: `--dsw-alias-*` and `--dsh-theme-*` overrides keyed by variable name. */
export type ThemeTokens = Record<string, string>

/**
 * One override-layer token value: both palette modes are mandatory (repeat
 * the same value when the token is scheme-invariant) so an override never
 * goes illegible when the user switches to the other scheme.
 */
export interface ThemeTokenModes {
  /** Value applied while the light base palette is active. */
  light: string
  /** Value applied while the dark base palette is active. */
  dark: string
}

/** Override-layer dictionary: token names to per-mode value pairs. */
export type ThemeTokenOverrides = Record<string, ThemeTokenModes>

/** One selectable theme: id, base palette, and alias-token overrides. */
export interface ThemeDefinition {
  /** Theme id (the setTheme argument for concrete themes). */
  id: string
  /**
   * Which base palette this theme builds on. The presenter switches
   * `body[data-ds-dark-theme]` from this field — never from the id.
   */
  colorScheme: ThemeColorScheme
  /** Alias-layer overrides applied as inline CSS variables over the base palette. */
  tokens: ThemeTokens
}

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: z.number().step(1).min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(DEFAULT_FONT_SIZE),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
