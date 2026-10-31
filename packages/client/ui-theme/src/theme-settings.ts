/** Theme preferences and palette declarations shared by the Host and browser halves. */

import z from '@deepseek-ai/schemastery'

/** Base palettes carried by the global stylesheets; every other theme builds on one of them. */
export const BUILTIN_SCHEMES = ['light', 'dark'] as const

/** Theme ids this package ships; the picklist the Host schema and the browser registry agree on. */
export const BUILTIN_THEME_IDS = ['light', 'dark', 'graph-glass', 'mono-accent', 'strata-dark'] as const

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['system', ...BUILTIN_THEME_IDS, 'custom'] as const

/** Preference id selecting the user-synthesized custom theme. */
export const CUSTOM_THEME_ID = 'custom'

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the custom theme's base palette mode. */
export const CUSTOM_SCHEME_FIELD = 'customScheme'

/** Field carrying the custom theme's canvas color. */
export const CUSTOM_CANVAS_FIELD = 'customCanvas'

/** Field carrying the custom theme's accent color. */
export const CUSTOM_ACCENT_FIELD = 'customAccent'

/** Field carrying the saved custom-theme presets. */
export const CUSTOM_PRESETS_FIELD = 'customPresets'

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

/** Base palette mode of the custom theme when the settings document has none. */
export const DEFAULT_CUSTOM_SCHEME: ThemeColorScheme = 'light'

/** Canvas color of the custom theme when the settings document has none. */
export const DEFAULT_CUSTOM_CANVAS = '#ffffff'

/** Accent color of the custom theme when the settings document has none. */
export const DEFAULT_CUSTOM_ACCENT = '#ff6900'

/** Largest number of saved custom-theme presets. */
export const CUSTOM_PRESETS_MAX = 16

/** Largest accepted preset name length, in code points. */
export const CUSTOM_PRESET_NAME_MAX = 24

/** One saved custom theme: a display name plus the three synthesis inputs. */
export interface CustomThemePreset {
  /** Display name, unique among the saved presets. */
  name: string
  /** Base palette the preset synthesizes over. */
  scheme: ThemeColorScheme
  /** Canvas color (`#rrggbb`). */
  canvas: string
  /** Accent color (`#rrggbb`). */
  accent: string
}

/** Hex color accepted for custom theme colors: `#rgb` or `#rrggbb`. */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Whether one value is an accepted custom theme color.
 * @param value - candidate color.
 * @returns true for `#rgb` or `#rrggbb`.
 */
export function isHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value)
}

/**
 * Canonicalize a validated hex color: lowercase, three-digit forms expanded to six.
 * @param value - a color that passed {@link isHexColor}.
 * @returns the canonical `#rrggbb` form.
 */
export function normalizeHexColor(value: string): string {
  if (!isHexColor(value)) throw new Error(`"${value}" is not a hex color; expected #rgb or #rrggbb`)
  if (value.length === 4) {
    return `#${value.charAt(1).repeat(2)}${value.charAt(2).repeat(2)}${value.charAt(3).repeat(2)}`.toLowerCase()
  }
  return value.toLowerCase()
}

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 10

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 22

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

/** Independently configurable font roles. */
export const FONT_ROLES = ['text', 'code', 'terminal'] as const

/** One configurable font role: interface text, code, or the sidebar terminal. */
export type FontRole = typeof FONT_ROLES[number]

/** Settings field, body variable, and accepted integer px range of one role's font size. */
export interface FontSizeSpec {
  /** Settings field carrying the size. */
  field: string
  /** Body variable carrying the size in px. */
  variable: string
  /** Smallest accepted size. */
  min: number
  /** Largest accepted size. */
  max: number
  /** Size when the user-settings document has no override. */
  default: number
}

/**
 * Font sizes by role. `text` is the conversation content size; `code` is the
 * code-block size (inline code stays 1px larger); `terminal` is the sidebar
 * terminal cell font size.
 */
export const FONT_SIZE_SPECS = {
  text: { field: FONT_SIZE_FIELD, variable: '--dsh-content-font-size', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, default: DEFAULT_FONT_SIZE },
  code: { field: 'codeFontSize', variable: '--dsh-code-font-size', min: 10, max: 16, default: 11 },
  terminal: { field: 'terminalFontSize', variable: '--dsh-terminal-font-size', min: 10, max: 20, default: 13 },
} as const satisfies Record<FontRole, FontSizeSpec>

/** Integer px font sizes by role. */
export type FontSizes = Readonly<Record<FontRole, number>>

/** Default font sizes by role. */
export const DEFAULT_FONT_SIZES: FontSizes = Object.freeze({
  text: FONT_SIZE_SPECS.text.default, code: FONT_SIZE_SPECS.code.default, terminal: FONT_SIZE_SPECS.terminal.default,
})

/** Settings field carrying each role's font-family list. */
export const FONT_FAMILY_FIELDS = {
  text: 'textFontFamily',
  code: 'codeFontFamily',
  terminal: 'terminalFontFamily',
} as const satisfies Record<FontRole, string>

/**
 * Body variable carrying one role's normalized font list; the token sheet
 * places it ahead of that role's built-in stack.
 * @param kind - font role.
 * @returns the CSS custom property name.
 */
export function fontFamilyVariable(kind: FontRole): string {
  return `--dsh-font-family-${kind}`
}

/** Normalized CSS font-family lists by role; `''` selects the built-in stack. */
export type FontFamilies = Readonly<Record<FontRole, string>>

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
  /** Code-block font size in px (integer within the {@link FONT_SIZE_SPECS} `code` range). */
  codeFontSize: number
  /** Sidebar terminal font size in px (integer within the {@link FONT_SIZE_SPECS} `terminal` range). */
  terminalFontSize: number
  /** Interface and body text fonts placed before the built-in stack; `''` keeps the built-in stack. */
  textFontFamily: string
  /** Code fonts placed before the built-in code stack; `''` keeps the built-in stack. */
  codeFontFamily: string
  /** Sidebar terminal fonts placed before the built-in terminal stack; `''` keeps the built-in stack. */
  terminalFontFamily: string
  /** Base palette mode of the synthesized custom theme. */
  customScheme: ThemeColorScheme
  /** Canvas color of the synthesized custom theme (`#rgb`/`#rrggbb`). */
  customCanvas: string
  /** Accent color of the synthesized custom theme (`#rgb`/`#rrggbb`). */
  customAccent: string
  /** Saved custom-theme presets, unique by name. */
  customPresets: CustomThemePreset[]
}

/**
 * Integer px schema for one role's font size.
 * @param spec - the role's range and default.
 * @returns the validated number schema.
 */
export function fontSizeSchema(spec: FontSizeSpec): z<number> {
  return z.number().step(1).min(spec.min).max(spec.max).default(spec.default)
}

/**
 * Collect every role's size from a settings section.
 * @param section - accepted theme settings.
 * @returns integer px sizes by role.
 */
export function sectionFontSizes(section: ThemeSettings): FontSizes {
  return Object.freeze({ text: section.fontSize, code: section.codeFontSize, terminal: section.terminalFontSize })
}

/** The three user-chosen inputs the custom theme synthesizes from. */
export interface CustomThemeInputs {
  /** Base palette the synthesized tokens layer over. */
  scheme: ThemeColorScheme
  /** Canvas color (`#rrggbb`). */
  canvas: string
  /** Accent color (`#rrggbb`). */
  accent: string
}

/**
 * Collect the custom theme inputs from a settings section.
 * @param section - accepted theme settings.
 * @returns the scheme, canvas, and accent inputs (colors canonicalized).
 */
export function customInputsOf(section: ThemeSettings): CustomThemeInputs {
  return {
    scheme: section.customScheme,
    canvas: normalizeHexColor(section.customCanvas),
    accent: normalizeHexColor(section.customAccent),
  }
}

/**
 * Whether one value is an accepted size for a role.
 * @param role - font role.
 * @param px - candidate size.
 * @returns true for an integer within the role's range.
 */
export function isFontSize(role: FontRole, px: number): boolean {
  const spec = FONT_SIZE_SPECS[role]
  return Number.isInteger(px) && px >= spec.min && px <= spec.max
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: fontSizeSchema(FONT_SIZE_SPECS.text),
  [FONT_SIZE_SPECS.code.field]: fontSizeSchema(FONT_SIZE_SPECS.code),
  [FONT_SIZE_SPECS.terminal.field]: fontSizeSchema(FONT_SIZE_SPECS.terminal),
  [FONT_FAMILY_FIELDS.text]: z.string().default(''),
  [FONT_FAMILY_FIELDS.code]: z.string().default(''),
  [FONT_FAMILY_FIELDS.terminal]: z.string().default(''),
  [CUSTOM_SCHEME_FIELD]: z.union([...BUILTIN_SCHEMES]).default(DEFAULT_CUSTOM_SCHEME),
  [CUSTOM_CANVAS_FIELD]: z.string().pattern(HEX_COLOR_PATTERN).default(DEFAULT_CUSTOM_CANVAS),
  [CUSTOM_ACCENT_FIELD]: z.string().pattern(HEX_COLOR_PATTERN).default(DEFAULT_CUSTOM_ACCENT),
  [CUSTOM_PRESETS_FIELD]: z.array(z.object({
    name: z.string(),
    scheme: z.union([...BUILTIN_SCHEMES]),
    canvas: z.string().pattern(HEX_COLOR_PATTERN),
    accent: z.string().pattern(HEX_COLOR_PATTERN),
  })).default([]),
})

/** CSS Fonts generic and system family keywords, which must stay unquoted. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
])

/**
 * Normalize user input into a CSS font-family list. Names are comma separated;
 * quotes, backslashes, angle brackets, and control characters are dropped, and
 * every non-generic name is double-quoted, so the result is always a valid list
 * safe to embed in inline CSS and boot scripts. Normalizing a result returns it unchanged.
 * @param value - user-entered or stored font list.
 * @returns the normalized list, or `''` when no family name remains.
 */
export function normalizeFontFamily(value: string): string {
  return value.split(',')
    .map(name => name.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(name => name !== '')
    .map(name => GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`)
    .join(', ')
}

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
