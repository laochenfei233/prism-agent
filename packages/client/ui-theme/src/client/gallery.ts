/**
 * Appearance gallery projection: one row per selectable preference, carrying
 * the colors, textures, and preview composition its miniature paints. The
 * projection reads the registry snapshot only, so a theme another plugin
 * registers appears in the gallery without this package knowing about it —
 * unknown ids render the plain miniature.
 */

import type { ThemeColorScheme, ThemeDefinition } from '../theme-settings.ts'

/** Preview composition one gallery row paints. Unknown themes fall back to `plain`. */
export type PreviewMotif =
  | 'plain'
  | 'split'
  | 'sheet'
  | 'night'
  | 'grid'
  | 'beacon'
  | 'strata'
  | 'grain'
  | 'plan'
  | 'crt'
  | 'ink'
  | 'fern'
  | 'bespoke'

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
  /** Tiled frame texture the theme carries (`--dsh-theme-canvas-image`), if any. */
  canvasImage?: string
  /** Tiled content-column texture the theme carries (`--dsh-theme-center-image`), if any. */
  centerImage?: string
  /** Which preview composition the row paints. */
  motif: PreviewMotif
}

/** Colors standing in for a theme that overrides no surface tokens (the bare base palettes). */
const FALLBACK_PREVIEW: Record<ThemeColorScheme, Omit<ThemeGalleryEntry, 'id' | 'motif'>> = {
  light: { base: '#ffffff', surface: '#f5f6f7', accent: '#0f1115' },
  dark: { base: '#151517', surface: '#232324', accent: '#f9fafb' },
}

/** `system` preview: one half per base palette, so the row shows both outcomes. */
const SYSTEM_PREVIEW: ThemeGalleryEntry = {
  id: 'system',
  base: 'linear-gradient(90deg, #ffffff 0 50%, #151517 50% 100%)',
  surface: 'linear-gradient(90deg, #f5f6f7 0 50%, #232324 50% 100%)',
  accent: 'linear-gradient(90deg, #0f1115 0 50%, #f9fafb 50% 100%)',
  motif: 'split',
}

/** Token names the preview reads off a theme definition. */
const PREVIEW_TOKENS = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-brand-primary'] as const

/** Preview composition per known preference id; this package owns the map for its own themes. */
const THEME_MOTIFS: Readonly<Record<string, PreviewMotif>> = {
  system: 'split',
  light: 'sheet',
  dark: 'night',
  'graph-glass': 'grid',
  'mono-accent': 'beacon',
  'strata-dark': 'strata',
  paper: 'grain',
  blueprint: 'plan',
  phosphor: 'crt',
  sumi: 'ink',
  sage: 'fern',
  custom: 'bespoke',
}

/**
 * The preview composition for one preference id.
 * @param id - preference id.
 * @returns the motif; ids this package does not know render `plain`.
 */
export function themeMotif(id: string): PreviewMotif {
  return THEME_MOTIFS[id] ?? 'plain'
}

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
    const canvasImage = theme.tokens['--dsh-theme-canvas-image']
    const centerImage = theme.tokens['--dsh-theme-center-image']
    return {
      id: theme.id,
      base: base ?? fallback.base,
      surface: surface ?? fallback.surface,
      accent: accent ?? fallback.accent,
      ...(canvasImage !== undefined ? { canvasImage } : {}),
      ...(centerImage !== undefined ? { centerImage } : {}),
      motif: themeMotif(theme.id),
    }
  })]
}
