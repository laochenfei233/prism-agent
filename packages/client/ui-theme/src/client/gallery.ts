/**
 * Appearance gallery projection: one row per selectable preference, carrying
 * the three colors its preview paints. The projection reads the registry
 * snapshot only, so a theme another plugin registers appears in the gallery
 * without this package knowing about it.
 */

import type { ThemeColorScheme, ThemeDefinition } from '../theme-settings.ts'

/** One selectable row of the Appearance gallery. */
export interface ThemeGalleryEntry {
  /** Preference id passed back to the theme service. */
  id: string
  /** Canvas color or gradient the preview paints behind everything. */
  base: string
  /** Raised-surface color or gradient the preview paints its panels with. */
  surface: string
  /** Accent color or gradient the preview spends on its single highlighted block. */
  accent: string
}

/** Colors standing in for a theme that overrides no surface tokens (the bare base palettes). */
const FALLBACK_PREVIEW: Record<ThemeColorScheme, Omit<ThemeGalleryEntry, 'id'>> = {
  light: { base: '#ffffff', surface: '#f5f6f7', accent: '#0f1115' },
  dark: { base: '#151517', surface: '#232324', accent: '#f9fafb' },
}

/** `system` preview: one half per base palette, so the row shows both outcomes. */
const SYSTEM_PREVIEW: ThemeGalleryEntry = {
  id: 'system',
  base: 'linear-gradient(90deg, #ffffff 0 50%, #151517 50% 100%)',
  surface: 'linear-gradient(90deg, #f5f6f7 0 50%, #232324 50% 100%)',
  accent: 'linear-gradient(90deg, #0f1115 0 50%, #f9fafb 50% 100%)',
}

/** Token names the preview reads off a theme definition. */
const PREVIEW_TOKENS = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-brand-primary'] as const

/**
 * Project the registry into gallery rows: `system` first, then every registered
 * theme in registration order.
 * @param themes - registered themes from the current snapshot.
 * @returns gallery rows in display order.
 */
export function projectThemeGallery(themes: readonly ThemeDefinition[]): ThemeGalleryEntry[] {
  return [SYSTEM_PREVIEW, ...themes.map((theme) => {
    const fallback = FALLBACK_PREVIEW[theme.colorScheme]
    const [base, surface, accent] = PREVIEW_TOKENS.map(name => theme.tokens[name])
    return {
      id: theme.id,
      base: base ?? fallback.base,
      surface: surface ?? fallback.surface,
      accent: accent ?? fallback.accent,
    }
  })]
}
