/**
 * Built-in theme palettes. `light` and `dark` carry no overrides — the global
 * stylesheets already define both base palettes — while the three designed
 * themes layer a complete alias-token set over one of them.
 *
 * Two app-owned tokens carry decoration the alias layer cannot express as a
 * color: `--dsh-theme-canvas-image` tiles the whole frame, and
 * `--dsh-theme-center-image` tiles the main content column beneath its cards.
 * `ui-layout`'s frame consumes both; without an override they fall back to
 * `none`.
 */

import type { ThemeDefinition } from './theme-settings.ts'

/** One built-in theme plus the canvas color painted before the stylesheets load. */
export interface BuiltinTheme extends ThemeDefinition {
  /** `color-scheme` and canvas color the Host boot script publishes for this theme. */
  bootBackground: string
}

/** Main frame texture of the graph-paper theme: a 44px square, drawn to the window edge. */
const GRAPH_PAPER_CANVAS = [
  'repeating-linear-gradient(to right, rgb(15 23 42 / 5.5%) 0 1px, transparent 1px 44px)',
  'repeating-linear-gradient(to bottom, rgb(15 23 42 / 5.5%) 0 1px, transparent 1px 44px)',
].join(', ')

/**
 * `graph-glass` — 方格纸玻璃卡. A 44px graph-paper canvas runs to every window
 * edge with no outer frame, and every surface above it is a translucent white
 * glass card, so the grid stays faintly visible through panels, sidebar, and
 * popovers. Ink stays near-neutral; the theme is carried by material, not hue.
 */
const GRAPH_GLASS = Object.freeze({
  id: 'graph-glass',
  colorScheme: 'light' as const,
  bootBackground: '#f2f3f5',
  tokens: Object.freeze({
    '--dsh-theme-canvas-image': GRAPH_PAPER_CANVAS,
    '--dsw-alias-bg-base': '#f2f3f5',
    '--dsw-alias-bg-layer-1': 'rgb(255 255 255 / 72%)',
    '--dsw-alias-bg-layer-2': 'rgb(255 255 255 / 58%)',
    '--dsw-alias-bg-layer-3': 'rgb(255 255 255 / 86%)',
    '--dsw-alias-bg-overlay': 'rgb(255 255 255 / 88%)',
    '--dsw-alias-bg-module-platform': 'rgb(255 255 255 / 62%)',
    '--dsw-alias-bg-multi-select': 'rgb(255 255 255 / 74%)',
    '--dsw-alias-bg-skeleton': 'rgb(15 23 42 / 5%)',
    '--dsw-alias-border-l1': 'rgb(15 23 42 / 7%)',
    '--dsw-alias-border-l2': 'rgb(15 23 42 / 11%)',
    '--dsw-alias-border-l3': 'rgb(15 23 42 / 15%)',
    '--dsw-alias-border-l4': 'rgb(15 23 42 / 20%)',
    '--dsw-alias-brand-primary': '#111827',
    '--dsw-alias-brand-primary-invert': '#f8fafc',
    '--dsw-alias-brand-text': '#111827',
    '--dsw-alias-label-primary': '#0f172a',
    '--dsw-alias-label-primary-inverted': '#ffffff',
    '--dsw-alias-label-primary-foreground': '#ffffff',
    '--dsw-alias-label-secondary': '#475569',
    '--dsw-alias-label-tertiary': '#64748b',
    '--dsw-alias-label-caption': '#94a3b8',
    '--dsw-alias-label-dimmed': 'rgb(15 23 42 / 18%)',
    '--dsw-alias-link': '#1d4ed8',
    '--dsw-alias-button-primary-fill': '#111827',
    '--dsw-alias-button-primary-hover': '#374151',
    '--dsw-alias-button-primary-dimmed': 'rgb(17 24 39 / 10%)',
    '--dsw-alias-interactive-bg-hover': 'rgb(15 23 42 / 5%)',
    '--dsw-alias-interactive-bg-active': 'rgb(15 23 42 / 9%)',
    '--dsw-alias-interactive-bg-hover-solid': 'rgb(255 255 255 / 66%)',
    '--dsw-alias-markdown-code-block': 'rgb(255 255 255 / 66%)',
    '--dsw-alias-markdown-code-block-banner': 'rgb(255 255 255 / 48%)',
    '--dsw-alias-markdown-inline-code': 'rgb(15 23 42 / 5%)',
    '--dsw-alias-markdown-citation': 'rgb(255 255 255 / 70%)',
    '--dsw-alias-markdown-tag': 'rgb(15 23 42 / 6%)',
    '--dsw-alias-scrollbar-bg-l1': 'rgb(15 23 42 / 14%)',
    '--dsw-alias-scrollbar-bg-l2': 'rgb(15 23 42 / 14%)',
    '--dsw-alias-scrollbar-hover-l1': 'rgb(15 23 42 / 26%)',
    '--dsw-alias-scrollbar-hover-l2': 'rgb(15 23 42 / 26%)',
    '--dsw-alias-toast-bg': 'rgb(17 24 39 / 92%)',
    '--dsw-alias-tooltip-bg': 'rgb(17 24 39 / 94%)',
    '--dsw-alias-state-business-primary': '#111827',
    '--dsw-alias-state-business-tertiary': 'rgb(17 24 39 / 8%)',
    '--dsw-alias-state-idle-primary': 'rgb(15 23 42 / 22%)',
    '--dsw-specific-sidebar-fill': 'rgb(255 255 255 / 55%)',
    '--dsw-specific-sidebar-nav-item-hover': 'rgb(15 23 42 / 5%)',
    '--dsw-specific-sidebar-nav-item-active': 'rgb(15 23 42 / 8%)',
    '--dsw-specific-sidebar-nav-item-active-accent': 'rgb(17 24 39 / 12%)',
    '--dsw-specific-input-major': 'rgb(255 255 255 / 78%)',
    '--dsw-specific-login-input': 'rgb(255 255 255 / 82%)',
    '--dsw-specific-bubble': 'rgb(255 255 255 / 70%)',
    '--dsw-specific-bubble-highlight': 'rgb(255 255 255 / 92%)',
    '--dsw-specific-menu': 'rgb(255 255 255 / 80%)',
    '--dsw-specific-selector': 'rgb(255 255 255 / 62%)',
    '--dsw-specific-tip': 'rgb(255 255 255 / 76%)',
  }),
})

/** The single accent `mono-accent` spends; every other chromatic token folds to neutral. */
const MONO_ACCENT = '#ff6900'

/**
 * `mono-accent` — 单强调色. One dark, near-black surface ramp carries the whole
 * page, and exactly one hue (the Prism orange) is spent on the data worth
 * looking at: primary buttons, links, the selected navigation row, and the
 * business state. The success and warning ramps fold onto the neutral ramp on
 * purpose — they are decoration here, not signal. The error ramp keeps the
 * platform red: a destructive affordance that reads as ordinary ink is a
 * safety regression, so it is the one deliberate exception to the single-hue
 * rule.
 */
const MONO_ACCENT_THEME = Object.freeze({
  id: 'mono-accent',
  colorScheme: 'dark' as const,
  bootBackground: '#0b0b0c',
  tokens: Object.freeze({
    '--dsw-alias-bg-base': '#0b0b0c',
    '--dsw-alias-bg-layer-1': '#131315',
    '--dsw-alias-bg-layer-2': '#1a1a1d',
    '--dsw-alias-bg-layer-3': '#212126',
    '--dsw-alias-bg-overlay': '#212126',
    '--dsw-alias-bg-module-platform': '#1a1a1d',
    '--dsw-alias-bg-multi-select': '#1a1a1d',
    '--dsw-alias-bg-skeleton': 'rgb(255 255 255 / 6%)',
    '--dsw-alias-border-l1': 'rgb(255 255 255 / 7%)',
    '--dsw-alias-border-l2': 'rgb(255 255 255 / 12%)',
    '--dsw-alias-border-l3': 'rgb(255 255 255 / 16%)',
    '--dsw-alias-border-l4': 'rgb(255 255 255 / 20%)',
    '--dsw-alias-brand-primary': MONO_ACCENT,
    '--dsw-alias-brand-primary-invert': '#0b0b0c',
    '--dsw-alias-brand-text': MONO_ACCENT,
    '--dsw-alias-label-primary': '#f4f4f5',
    '--dsw-alias-label-primary-inverted': '#0b0b0c',
    '--dsw-alias-label-primary-foreground': '#0b0b0c',
    '--dsw-alias-label-secondary': '#a1a1aa',
    '--dsw-alias-label-tertiary': '#8b8b93',
    '--dsw-alias-label-caption': '#5f5f66',
    '--dsw-alias-label-dimmed': 'rgb(255 255 255 / 14%)',
    '--dsw-alias-link': MONO_ACCENT,
    '--dsw-alias-button-primary-fill': MONO_ACCENT,
    '--dsw-alias-button-primary-hover': '#ff7d24',
    '--dsw-alias-button-primary-dimmed': 'rgb(255 105 0 / 18%)',
    '--dsw-alias-button-info-fill': MONO_ACCENT,
    '--dsw-alias-button-info-hover': '#ff7d24',
    '--dsw-alias-interactive-bg-hover': 'rgb(255 255 255 / 6%)',
    '--dsw-alias-interactive-bg-active': 'rgb(255 255 255 / 10%)',
    '--dsw-alias-interactive-bg-hover-solid': '#1a1a1d',
    '--dsw-alias-interactive-bg-hover-accent': 'rgb(255 105 0 / 16%)',
    '--dsw-alias-markdown-code-block': '#131315',
    '--dsw-alias-markdown-code-block-banner': '#1a1a1d',
    '--dsw-alias-markdown-inline-code': 'rgb(255 255 255 / 7%)',
    '--dsw-alias-markdown-citation': '#1a1a1d',
    '--dsw-alias-markdown-tag': 'rgb(255 255 255 / 8%)',
    '--dsw-alias-scrollbar-bg-l1': '#2a2a2e',
    '--dsw-alias-scrollbar-bg-l2': '#2a2a2e',
    '--dsw-alias-scrollbar-hover-l1': '#3d3d43',
    '--dsw-alias-scrollbar-hover-l2': '#3d3d43',
    '--dsw-alias-toast-bg': '#212126',
    '--dsw-alias-tooltip-bg': '#26262b',
    '--dsw-alias-state-business-primary': MONO_ACCENT,
    '--dsw-alias-state-business-tertiary': 'rgb(255 105 0 / 14%)',
    '--dsw-alias-state-error-primary': 'rgb(242 90 90)',
    '--dsw-alias-state-error-secondary': 'rgb(242 90 90)',
    '--dsw-alias-state-idle-primary': '#3f3f46',
    '--dsw-alias-state-success-primary': '#a1a1aa',
    '--dsw-alias-state-success-secondary': '#8b8b93',
    '--dsw-alias-state-success-tertiary': 'rgb(255 255 255 / 8%)',
    '--dsw-alias-state-warn-primary': '#d4d4d8',
    '--dsw-alias-state-warn-secondary': '#a1a1aa',
    '--dsw-alias-state-warn-tertiary': 'rgb(255 255 255 / 8%)',
    '--dsw-alias-state-warn-label': '#a1a1aa',
    '--dsw-alias-code-diff-added': 'rgb(255 255 255 / 6%)',
    '--dsw-alias-code-diff-deleted': 'rgb(242 90 90 / 12%)',
    '--dsw-specific-sidebar-fill': '#111113',
    '--dsw-specific-sidebar-nav-item-hover': 'rgb(255 255 255 / 5%)',
    '--dsw-specific-sidebar-nav-item-active': 'rgb(255 105 0 / 14%)',
    '--dsw-specific-sidebar-nav-item-active-accent': MONO_ACCENT,
    '--dsw-specific-input-major': '#131315',
    '--dsw-specific-login-input': '#131315',
    '--dsw-specific-bubble': '#1a1a1d',
    '--dsw-specific-bubble-highlight': '#212126',
    '--dsw-specific-menu': 'rgb(26 26 29 / 94%)',
    '--dsw-specific-selector': '#1a1a1d',
    '--dsw-specific-tip': '#1a1a1d',
  }),
})

/**
 * `strata-dark` — 暗底明度分层. Depth comes only from lightness: four neutral
 * steps from the page well up to raised cards, with no hue anywhere. Empty main
 * regions are hatched by `--dsh-theme-center-image` so a panel with nothing in
 * it reads as deliberately blank rather than unloaded; the stripes stay under
 * the opaque card surfaces and show only in the gaps. Like `mono-accent`, the
 * error ramp keeps the platform red as the one exception to a colourless page.
 */
const STRATA_DARK = Object.freeze({
  id: 'strata-dark',
  colorScheme: 'dark' as const,
  bootBackground: '#0e0e10',
  tokens: Object.freeze({
    '--dsh-theme-center-image': 'repeating-linear-gradient(45deg, rgb(255 255 255 / 3.5%) 0 6px, transparent 6px 14px)',
    '--dsw-alias-bg-base': '#0e0e10',
    '--dsw-alias-bg-layer-1': '#17171a',
    '--dsw-alias-bg-layer-2': '#1f1f23',
    '--dsw-alias-bg-layer-3': '#28282d',
    '--dsw-alias-bg-overlay': '#28282d',
    '--dsw-alias-bg-module-platform': '#1f1f23',
    '--dsw-alias-bg-multi-select': '#1f1f23',
    '--dsw-alias-bg-skeleton': 'rgb(255 255 255 / 6%)',
    '--dsw-alias-border-l1': 'rgb(255 255 255 / 8%)',
    '--dsw-alias-border-l2': 'rgb(255 255 255 / 14%)',
    '--dsw-alias-border-l3': 'rgb(255 255 255 / 18%)',
    '--dsw-alias-border-l4': 'rgb(255 255 255 / 22%)',
    '--dsw-alias-brand-primary': '#e4e4e7',
    '--dsw-alias-brand-primary-invert': '#0e0e10',
    '--dsw-alias-brand-text': '#e4e4e7',
    '--dsw-alias-label-primary': '#f4f4f5',
    '--dsw-alias-label-primary-inverted': '#0e0e10',
    '--dsw-alias-label-primary-foreground': '#0e0e10',
    '--dsw-alias-label-secondary': '#a1a1aa',
    '--dsw-alias-label-tertiary': '#8b8b93',
    '--dsw-alias-label-caption': '#5f5f66',
    '--dsw-alias-label-dimmed': 'rgb(255 255 255 / 16%)',
    '--dsw-alias-link': '#d4d4d8',
    '--dsw-alias-button-primary-fill': '#e4e4e7',
    '--dsw-alias-button-primary-hover': '#ffffff',
    '--dsw-alias-button-primary-dimmed': 'rgb(255 255 255 / 12%)',
    '--dsw-alias-button-info-fill': '#d4d4d8',
    '--dsw-alias-button-info-hover': '#f4f4f5',
    '--dsw-alias-interactive-bg-hover': 'rgb(255 255 255 / 7%)',
    '--dsw-alias-interactive-bg-active': 'rgb(255 255 255 / 11%)',
    '--dsw-alias-interactive-bg-hover-solid': '#1f1f23',
    '--dsw-alias-markdown-code-block': '#17171a',
    '--dsw-alias-markdown-code-block-banner': '#1f1f23',
    '--dsw-alias-markdown-inline-code': 'rgb(255 255 255 / 7%)',
    '--dsw-alias-markdown-citation': '#1f1f23',
    '--dsw-alias-markdown-tag': 'rgb(255 255 255 / 9%)',
    '--dsw-alias-scrollbar-bg-l1': '#2c2c31',
    '--dsw-alias-scrollbar-bg-l2': '#2c2c31',
    '--dsw-alias-scrollbar-hover-l1': '#41414a',
    '--dsw-alias-scrollbar-hover-l2': '#41414a',
    '--dsw-alias-toast-bg': '#28282d',
    '--dsw-alias-tooltip-bg': '#2c2c33',
    '--dsw-alias-state-business-primary': '#d4d4d8',
    '--dsw-alias-state-business-tertiary': 'rgb(255 255 255 / 10%)',
    '--dsw-alias-state-error-primary': 'rgb(242 90 90)',
    '--dsw-alias-state-error-secondary': 'rgb(242 90 90)',
    '--dsw-alias-state-idle-primary': '#3f3f46',
    '--dsw-alias-state-success-primary': '#a1a1aa',
    '--dsw-alias-state-success-secondary': '#8b8b93',
    '--dsw-alias-state-success-tertiary': 'rgb(255 255 255 / 9%)',
    '--dsw-alias-state-warn-primary': '#d4d4d8',
    '--dsw-alias-state-warn-secondary': '#a1a1aa',
    '--dsw-alias-state-warn-tertiary': 'rgb(255 255 255 / 9%)',
    '--dsw-alias-state-warn-label': '#a1a1aa',
    '--dsw-alias-code-diff-added': 'rgb(255 255 255 / 7%)',
    '--dsw-alias-code-diff-deleted': 'rgb(242 90 90 / 12%)',
    '--dsw-specific-sidebar-fill': '#141417',
    '--dsw-specific-sidebar-nav-item-hover': 'rgb(255 255 255 / 5%)',
    '--dsw-specific-sidebar-nav-item-active': 'rgb(255 255 255 / 10%)',
    '--dsw-specific-sidebar-nav-item-active-accent': 'rgb(255 255 255 / 16%)',
    '--dsw-specific-input-major': '#1f1f23',
    '--dsw-specific-login-input': '#1f1f23',
    '--dsw-specific-bubble': '#1f1f23',
    '--dsw-specific-bubble-highlight': '#28282d',
    '--dsw-specific-menu': 'rgb(31 31 35 / 94%)',
    '--dsw-specific-selector': '#1f1f23',
    '--dsw-specific-tip': '#1f1f23',
  }),
})

/** Built-in themes in gallery order; the first two are the bare base palettes. */
export const BUILTIN_THEMES: readonly BuiltinTheme[] = Object.freeze([
  Object.freeze({ id: 'light', colorScheme: 'light' as const, bootBackground: '#fff', tokens: Object.freeze({}) }),
  Object.freeze({ id: 'dark', colorScheme: 'dark' as const, bootBackground: '#151517', tokens: Object.freeze({}) }),
  GRAPH_GLASS,
  MONO_ACCENT_THEME,
  STRATA_DARK,
])

/**
 * Resolve the canvas color a preference paints before the stylesheets load.
 * @param preference - persisted preference, including `system`.
 * @param systemDark - whether the OS currently prefers a dark color scheme.
 * @returns the boot canvas color for the resolved theme.
 */
export function bootBackgroundOf(preference: string, systemDark: boolean): string {
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  return BUILTIN_THEMES.find(theme => theme.id === resolved)?.bootBackground
    ?? (systemDark ? '#151517' : '#fff')
}
