/**
 * Browser theme registry over the `--dsw-*` token stylesheets. The service
 * owns the live theme preference (light/dark/system/custom), resolves `system`
 * through `prefers-color-scheme`, synthesizes `custom` from the stored inputs,
 * and publishes immutable snapshots; it never touches the DOM — ui-layout's
 * presenter consumes the resolved snapshot. The Host settings scope loads and
 * stores the preference in the user-settings document. The plugin also
 * registers the standalone Appearance section — the theme feature owns its own
 * settings surface. Desktop shortcuts adjust text, code, and terminal font
 * sizes together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { NormalizedBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { AppearanceSectionInjected } from './AppearanceSection.tsx'
import { AppearanceSection } from './AppearanceSection.tsx'
import { projectThemeGallery } from './gallery.ts'
import { createAppearanceSectionStore } from './settings-store.ts'
import { installThemeStyles } from './styles.ts'
import { en, zh, type ThemeKey } from './locales.ts'
import { BUILTIN_THEMES } from '../builtin-themes.ts'
import {
  CUSTOM_ACCENT_FIELD, CUSTOM_CANVAS_FIELD, CUSTOM_PRESETS_FIELD, CUSTOM_PRESET_NAME_MAX, CUSTOM_PRESETS_MAX,
  CUSTOM_SCHEME_FIELD, CUSTOM_THEME_ID, codePointLength,
  DEFAULT_CUSTOM_ACCENT, DEFAULT_CUSTOM_CANVAS, DEFAULT_CUSTOM_SCHEME,
  DEFAULT_FONT_SIZES, DEFAULT_PREFERENCE, FONT_FAMILY_FIELDS, FONT_ROLES, FONT_SIZE_SPECS,
  fontFamilyVariable, isFontSize, isHexColor, isThemePreference, normalizeFontFamily, normalizeHexColor,
  sectionFontSizes, THEME_PREFERENCE_FIELD, THEME_SETTINGS_NAMESPACE,
  type CustomThemeInputs, type CustomThemePreset, type FontFamilies, type FontRole, type FontSizes, type ThemeDefinition,
  type ThemePreference, type ThemeSettings, type ThemeTokenModes, type ThemeTokenOverrides, type ThemeTokens,
} from '../theme-settings.ts'
import { synthesizeCustomTheme } from '../custom-theme.ts'

export type { AppearanceSectionComponentProps, AppearanceSectionInjected } from './AppearanceSection.tsx'
export type { AppearanceRowComponentProps, AppearanceRowInjected } from './AppearanceRow.tsx'
export type { CustomThemeGroupProps, CustomThemeGroupInjected } from './CustomThemeGroup.tsx'
export type { FontSettingsGroupProps, FontSettingsInjected } from './FontSettingsGroup.tsx'
export type { AppearanceSectionState } from './settings-store.ts'
export type { ThemeGalleryEntry } from './gallery.ts'
export type { ThemeKey } from './locales.ts'
export type {
  BuiltinThemeId, CustomThemeInputs, CustomThemePreset, ThemeColorScheme, ThemeDefinition, FontFamilies, FontRole, FontSizes,
  ThemePreference, ThemeSettings, ThemeTokenModes, ThemeTokenOverrides, ThemeTokens,
} from '../theme-settings.ts'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.theme'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Appearance settings row's copy. */
    'settings.theme': ThemeKey
  }
}

/** Immutable theme state published on every change. */
export interface ThemeSnapshot {
  /** The persisted preference (may be `system`). */
  preference: ThemePreference
  /** Integer px font sizes by role, each within its `FONT_SIZE_SPECS` range (`text` is the conversation content size). */
  fontSizes: FontSizes
  /** Normalized user font lists by role; `''` selects the role's built-in stack. */
  fontFamilies: FontFamilies
  /** The stored custom theme inputs; the `custom` preference synthesizes its theme from these. */
  custom: CustomThemeInputs
  /** Saved custom-theme presets, unique by name. */
  customPresets: readonly CustomThemePreset[]
  /**
   * The resolved active theme (`system` resolved via prefers-color-scheme,
   * `custom` synthesized from the stored inputs) with override layers folded
   * into its tokens (seq order, later layers win per-token; each value picked
   * for the active color scheme).
   */
  active: ThemeDefinition
  /** Registered themes in registration order, then the synthesized custom theme. */
  themes: readonly ThemeDefinition[]
  /** Monotonic change counter (registry or active changes). */
  revision: number
}

/** One theme token exposed to pre-definition Cordis inspection. */
export interface ThemeTokenInspection {
  /** Token name accepted by {@link ThemeRuntime.overrideTokens}. */
  name: string
  /** Intended visual role. */
  description: string
  /** CSS value category. */
  valueType: string
  /** Whether override layers must supply both palette modes. */
  requiresLightAndDark: boolean
  /** CSS custom property consumed by UI styles. */
  cssVariable?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    theme: ThemeRuntime
  }
  interface Events {
    /**
     * Theme state changed (preference switched, registry updated, or the OS
     * color scheme changed while the preference is `system`).
     * @param snapshot - Current immutable theme snapshot.
     * @mode emit
     */
    'theme/change'(snapshot: ThemeSnapshot): void
  }
}

/** Built-in registry seed: the designed palettes without their boot-canvas field. */
const BASE_THEMES: readonly ThemeDefinition[] = Object.freeze(BUILTIN_THEMES.map(theme => Object.freeze({
  id: theme.id, colorScheme: theme.colorScheme, tokens: theme.tokens,
})))

const BUILTIN_INSPECT_TOKENS: readonly ThemeTokenInspection[] = Object.freeze([
  { name: '--dsh-theme-canvas-image', description: 'Tiled texture painted on the application frame behind every panel.', valueType: 'CSS background image', requiresLightAndDark: true, cssVariable: '--dsh-theme-canvas-image' },
  { name: '--dsh-theme-center-image', description: 'Tiled texture painted on the main content column beneath its cards.', valueType: 'CSS background image', requiresLightAndDark: true, cssVariable: '--dsh-theme-center-image' },
  { name: '--dsw-alias-bg-base', description: 'Application base background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-base' },
  { name: '--dsw-alias-bg-layer-1', description: 'Primary raised surface background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-1' },
  { name: '--dsw-alias-bg-layer-2', description: 'Secondary nested surface background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-2' },
  { name: '--dsw-alias-bg-overlay', description: 'Overlay and popover background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-overlay' },
  { name: '--dsw-alias-border-l1', description: 'Primary subtle border.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l1' },
  { name: '--dsw-alias-border-l2', description: 'Secondary stronger border.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l2' },
  { name: '--dsw-alias-brand-primary', description: 'Primary brand accent.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-brand-primary' },
  { name: '--dsw-alias-label-primary', description: 'Primary text color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-primary' },
  { name: '--dsw-alias-label-secondary', description: 'Secondary text color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-secondary' },
  { name: '--dsw-alias-state-error-primary', description: 'Primary error state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-error-primary' },
  { name: '--dsw-alias-state-idle-primary', description: 'Primary inactive state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-idle-primary' },
  { name: '--dsw-alias-state-success-primary', description: 'Primary success state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-success-primary' },
  { name: '--dsw-alias-state-warn-primary', description: 'Primary warning state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-warn-primary' },
  { name: '--dsw-specific-sidebar-fill', description: 'Sidebar column and title-row background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-specific-sidebar-fill' },
])

/**
 * Theme registry and preference owner. `light`/`dark` are built in (the base
 * stylesheets carry both palettes); third-party themes register alias-layer
 * overrides. Reads go through {@link getTheme}; preference writes only
 * through {@link setTheme}; continuous sync only through the `theme/change`
 * event. {@link overrideTokens} stacks partial token layers over the active
 * theme without touching the registry.
 * The service holds the `prefers-color-scheme` media query (environment
 * sensing, not presentation) and re-emits when the OS scheme flips while the
 * preference is `system`.
 */
export class ThemeRuntime {
  private readonly ctx: ClientContext
  private readonly host: ConfigForm<ThemeSettings>
  private themes: ThemeDefinition[] = [...BASE_THEMES]
  private preference: ThemePreference
  private fontSizes: FontSizes = bootstrapFontSizes()
  private fontFamilies: FontFamilies = bootstrapFontFamilies()
  private custom: CustomThemeInputs = { scheme: DEFAULT_CUSTOM_SCHEME, canvas: DEFAULT_CUSTOM_CANVAS, accent: DEFAULT_CUSTOM_ACCENT }
  private customPresets: CustomThemePreset[] = []
  private revision = 0
  /** Own settings writes not yet settled; adoption waits for zero so a Host echo of an earlier write cannot revert a later local change. */
  private pendingWrites = 0
  private snapshot: ThemeSnapshot
  private readonly media: MediaQueryList | undefined
  /** Override layers by source; seq (monotonic) is the stacking order. */
  private readonly overrides = new Map<string, { seq: number; tokens: ThemeTokenOverrides }>()
  private overrideSeq = 0

  /**
   * @param ctx - owning context (change events are emitted on it; the
   * media-query and scope listeners are released through ctx.effect on dispose).
   * @param host - durable preference scope owned by the same plugin.
   */
  constructor(ctx: ClientContext, host: ConfigForm<ThemeSettings>) {
    this.ctx = ctx
    this.host = host
    this.preference = DEFAULT_PREFERENCE
    // Non-browser runs (node e2e booting the client tree) have no matchMedia.
    this.media = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)')
    this.snapshot = this.buildSnapshot()
    if (this.media !== undefined) {
      const media = this.media
      const onChange = (): void => {
        if (this.preference !== 'system') return
        this.publish()
      }
      ctx.effect(() => {
        media.addEventListener('change', onChange)
        return () => { media.removeEventListener('change', onChange) }
      }, 'ui-theme: prefers-color-scheme listener')
    }
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-theme: settings scope adoption')
    this.adopt()
    installFontSizeShortcuts(ctx, (delta) => { this.adjustFontSizes(delta) })
  }

  /**
   * Read the current immutable theme snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getTheme(): ThemeSnapshot {
    return this.snapshot
  }

  /**
   * Export the current token directory without reading DOM or computed styles.
   * @returns stable JSON-safe token descriptions, including registered and override-only names.
   */
  exportInspectTokens(): ThemeTokenInspection[] {
    const tokens = new Map(BUILTIN_INSPECT_TOKENS.map(token => [token.name, token]))
    for (const theme of this.themes) {
      for (const name of Object.keys(theme.tokens)) {
        if (!tokens.has(name)) tokens.set(name, dynamicToken(name))
      }
    }
    for (const layer of this.overrides.values()) {
      for (const name of Object.keys(layer.tokens)) {
        if (!tokens.has(name)) tokens.set(name, dynamicToken(name))
      }
    }
    return [...tokens.values()].map(token => ({ ...token })).sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Switch the theme preference — the only user preference write entry.
   * Built-in preferences are written through the settings scope and every
   * accepted value emits `theme/change`.
   * @param id - a registered theme id, `system`, or `custom`; unknown ids throw.
   */
  setTheme(id: string): void {
    if (id !== 'system' && id !== CUSTOM_THEME_ID && !this.themes.some(t => t.id === id)) {
      throw new Error(`theme "${id}" is not registered`)
    }
    if (this.preference === id) return
    this.preference = id as ThemePreference
    if (isThemePreference(id)) this.write(() => this.host.set(THEME_PREFERENCE_FIELD, id))
    this.publish()
  }

  /**
   * Change the custom theme inputs — the only custom-theme write entry. Changed
   * inputs are written through the settings scope together with the preference
   * switch to `custom` (editing the controls means using the theme), and the
   * change emits one `theme/change` with the re-synthesized theme. Colors must
   * be valid hex values; anything else throws and nothing is written.
   * @param patch - the inputs to change; omitted inputs keep their values.
   */
  setCustom(patch: Partial<CustomThemeInputs>): void {
    const next: CustomThemeInputs = {
      scheme: patch.scheme ?? this.custom.scheme,
      canvas: patch.canvas === undefined ? this.custom.canvas : normalizeHexColor(patch.canvas),
      accent: patch.accent === undefined ? this.custom.accent : normalizeHexColor(patch.accent),
    }
    const changed = next.scheme !== this.custom.scheme
      || next.canvas !== this.custom.canvas
      || next.accent !== this.custom.accent
    const switching = this.preference !== CUSTOM_THEME_ID
    if (!changed && !switching) return
    const ops = [
      ...(next.scheme !== this.custom.scheme ? [{ op: 'set' as const, path: [CUSTOM_SCHEME_FIELD], value: next.scheme }] : []),
      ...(next.canvas !== this.custom.canvas ? [{ op: 'set' as const, path: [CUSTOM_CANVAS_FIELD], value: next.canvas }] : []),
      ...(next.accent !== this.custom.accent ? [{ op: 'set' as const, path: [CUSTOM_ACCENT_FIELD], value: next.accent }] : []),
      ...(switching ? [{ op: 'set' as const, path: [THEME_PREFERENCE_FIELD], value: CUSTOM_THEME_ID }] : []),
    ]
    this.custom = next
    this.preference = CUSTOM_THEME_ID
    this.write(() => this.host.mutate(ops))
    this.publish()
  }

  /**
   * Save the current custom inputs as a named preset — the only preset write
   * entry alongside {@link deleteCustomPreset}. A name that already exists is
   * replaced in place; a new name past the {@link CUSTOM_PRESETS_MAX} cap
   * throws. Saving never changes the active preference.
   * @param name - display name; empty or over {@link CUSTOM_PRESET_NAME_MAX} code points throws and nothing is written.
   */
  saveCustomPreset(name: string): void {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('a preset name is required')
    if (codePointLength(trimmed) > CUSTOM_PRESET_NAME_MAX) {
      throw new Error(`a preset name is limited to ${CUSTOM_PRESET_NAME_MAX} code points`)
    }
    const entry: CustomThemePreset = {
      name: trimmed, scheme: this.custom.scheme, canvas: this.custom.canvas, accent: this.custom.accent,
    }
    const existing = this.customPresets.find(preset => preset.name === trimmed)
    if (existing !== undefined) {
      if (presetEqual(existing, entry)) return
      this.customPresets = this.customPresets.map(preset => preset.name === trimmed ? entry : preset)
    } else {
      if (this.customPresets.length >= CUSTOM_PRESETS_MAX) {
        throw new Error(`at most ${CUSTOM_PRESETS_MAX} presets can be saved; delete one first`)
      }
      this.customPresets = [...this.customPresets, entry]
    }
    this.write(() => this.host.set(CUSTOM_PRESETS_FIELD, this.customPresets))
    this.publish()
  }

  /**
   * Delete one named preset. Deleting the preset backing the active look
   * keeps the current inputs — the active theme is the stored fields, not the
   * preset. Deleting an unknown name is a no-op.
   * @param name - the preset's display name.
   */
  deleteCustomPreset(name: string): void {
    if (!this.customPresets.some(preset => preset.name === name)) return
    this.customPresets = this.customPresets.filter(preset => preset.name !== name)
    this.write(() => this.host.set(CUSTOM_PRESETS_FIELD, this.customPresets))
    this.publish()
  }

  /**
   * Change one role's font size. Accepted
   * values are written through the settings scope and emit `theme/change`.
   * @param role - font role.
   * @param px - integer px within the role's `FONT_SIZE_SPECS` range; out-of-range or fractional values throw.
   */
  setFontSize(role: FontRole, px: number): void {
    const spec = FONT_SIZE_SPECS[role]
    if (!isFontSize(role, px)) throw new Error(`${role} font size ${px} is outside ${spec.min}..${spec.max}`)
    if (this.fontSizes[role] === px) return
    this.fontSizes = Object.freeze({ ...this.fontSizes, [role]: px })
    this.write(() => this.host.set(spec.field, px))
    this.publish()
  }

  /**
   * Step all font sizes within their own ranges and save changed fields in one mutation.
   * Emits one `theme/change`; no write or event occurs when every role is at its limit.
   * @param delta - one pixel to add or remove from each role's current size.
   */
  private adjustFontSizes(delta: 1 | -1): void {
    const fontSizes = { ...this.fontSizes }
    const fields: Record<string, number> = {}
    for (const role of FONT_ROLES) {
      const { field, min, max } = FONT_SIZE_SPECS[role]
      const px = Math.max(min, Math.min(max, fontSizes[role] + delta))
      if (px === fontSizes[role]) continue
      fontSizes[role] = px
      fields[field] = px
    }
    const ops = Object.entries(fields).map(([field, value]) => ({ op: 'set' as const, path: [field], value }))
    if (ops.length === 0) return
    this.fontSizes = Object.freeze(fontSizes)
    this.write(() => this.host.mutate(ops))
    this.publish()
  }

  /**
   * Change one role's font list — the only font-family write entry. The value
   * is normalized, written through the settings scope, and emits `theme/change`
   * when the normalized list differs.
   * @param role - font role.
   * @param value - comma-separated family names; a value without names restores the built-in stack.
   */
  setFontFamily(role: FontRole, value: string): void {
    const list = normalizeFontFamily(value)
    if (this.fontFamilies[role] === list) return
    this.fontFamilies = Object.freeze({ ...this.fontFamilies, [role]: list })
    this.write(() => this.host.set(FONT_FAMILY_FIELDS[role], list))
    this.publish()
  }

  /** Queue one settings write, then adopt the durable section once no own write remains. */
  private write(operation: () => Promise<boolean>): void {
    this.pendingWrites += 1
    void operation().finally(() => {
      this.pendingWrites -= 1
      this.adopt()
    })
  }

  /** Adopt the scope's accepted durable preference, custom inputs, and presets without writing them back. */
  private adopt(): void {
    if (this.pendingWrites > 0) return
    const section = this.host.getSnapshot().value
    if (section === undefined) return
    const fontFamilies = durableFontFamilies(section)
    const fontSizes = sectionFontSizes(section)
    const custom = sectionCustomInputs(section)
    const customPresets = sectionCustomPresets(section)
    if (this.preference === section.preference
      && this.custom.scheme === custom.scheme && this.custom.canvas === custom.canvas && this.custom.accent === custom.accent
      && customPresets.length === this.customPresets.length
      && this.customPresets.every((preset, index) => presetEqual(preset, customPresets[index] ?? preset))
      && FONT_ROLES.every(role => this.fontSizes[role] === fontSizes[role] && this.fontFamilies[role] === fontFamilies[role])) return
    this.preference = section.preference
    this.fontSizes = fontSizes
    this.fontFamilies = fontFamilies
    this.custom = custom
    this.customPresets = customPresets
    this.publish()
  }

  /**
   * Register a theme. Duplicate id throws (single occupant per id; the
   * built-in pair counts; `system` is a preference, not a registrable id).
   * @param definition - theme id, colorScheme, and alias-token overrides.
   * @returns disposer. Disposing the theme backing the active preference
   * resets the preference to the default so the UI never keeps tokens of an
   * unregistered theme.
   */
  register(definition: ThemeDefinition): () => void {
    if (definition.id === 'system') throw new Error('"system" is a preference, not a registrable theme id')
    if (this.themes.some(t => t.id === definition.id)) {
      throw new Error(`theme "${definition.id}" is already registered`)
    }
    this.themes = [...this.themes, definition]
    this.publish()
    return () => {
      if (!this.themes.some(t => t.id === definition.id)) return
      this.themes = this.themes.filter(t => t.id !== definition.id)
      if (this.preference === definition.id) {
        this.preference = DEFAULT_PREFERENCE
      }
      this.publish()
    }
  }

  /**
   * Stack a token override layer on top of the active theme — the token-level
   * analogue of slot shading: the base theme stays untouched, layers compose
   * in seq order with later layers winning per-token, and removing a layer
   * restores whatever it covered. Calling again with the same source replaces
   * that source's whole layer and restacks it on top (effect re-registration
   * semantics). Emits `theme/change` with the recomposed snapshot.
   * @param source - layer identity; one layer per source (dynamic packages
   * pass their package id — the façade pins it, so it also names the layer's
   * origin for inspection).
   * @param tokens - token-name → `{ light, dark }` value pairs. Validated at
   * runtime (model-authored callers reach this boundary with untyped JS);
   * a bare string value throws a teaching error.
   * @returns disposer removing exactly the layer this call created; a no-op
   * once the source has re-overridden (the newer layer is not torn down).
   */
  overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void {
    const layer = { seq: this.overrideSeq++, tokens: validateOverrides(source, tokens) }
    this.overrides.set(source, layer)
    this.publish()
    return () => {
      if (this.overrides.get(source) !== layer) return
      this.overrides.delete(source)
      this.publish()
    }
  }

  private buildSnapshot(): ThemeSnapshot {
    const resolvedId = this.preference === 'system'
      ? (this.media?.matches === true ? 'dark' : 'light')
      : this.preference
    // Both built-ins always exist; a registered preference id resolves or has
    // been reset by its disposer, so the lookup cannot miss. `custom` carries
    // its own synthesis.
    const active = resolvedId === CUSTOM_THEME_ID ? synthesizeCustomTheme(this.custom) : this.themes.find(t => t.id === resolvedId)
    /* v8 ignore next 2 -- needs a registry without light/dark, which register()/dispose() cannot produce */
    if (active === undefined) throw new Error(`theme registry lost "${resolvedId}"`)
    return Object.freeze({
      preference: this.preference,
      fontSizes: this.fontSizes,
      fontFamilies: this.fontFamilies,
      custom: this.custom,
      customPresets: Object.freeze([...this.customPresets]),
      active: this.composeActive(active),
      themes: Object.freeze([...this.themes, synthesizeCustomTheme(this.custom)]),
      revision: this.revision,
    })
  }

  /**
   * Fold the override layers into the active definition: seq order, later
   * layers win per-token, each value picked for the active color scheme (the
   * presenter consumes the composed snapshot and needs no override awareness).
   * Without layers the registered definition passes through by identity.
   */
  private composeActive(active: ThemeDefinition): ThemeDefinition {
    if (this.overrides.size === 0) return active
    const tokens: ThemeTokens = { ...active.tokens }
    for (const layer of [...this.overrides.values()].sort((a, b) => a.seq - b.seq)) {
      for (const [name, modes] of Object.entries(layer.tokens)) {
        tokens[name] = modes[active.colorScheme]
      }
    }
    return Object.freeze({ ...active, tokens: Object.freeze(tokens) })
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    this.ctx.emit('theme/change', this.snapshot)
  }
}

/**
 * Read the font sizes the Host boot script wrote on `body` before any plugin
 * ran, so the initial snapshot matches first paint and ui-layout's presenter
 * does not flash the schema defaults while the settings read is in flight.
 * Non-browser runs, mounts without the boot script, and out-of-range values
 * fall back to each role's default; the durable settings adoption still lands afterwards.
 */
function bootstrapFontSizes(): FontSizes {
  /* v8 ignore next -- needs a documentless run (node e2e booting the client tree), not constructible under jsdom */
  if (typeof document === 'undefined') return DEFAULT_FONT_SIZES
  const read = (role: FontRole): number => {
    const parsed = Number.parseInt(document.body.style.getPropertyValue(FONT_SIZE_SPECS[role].variable), 10)
    return isFontSize(role, parsed) ? parsed : FONT_SIZE_SPECS[role].default
  }
  return Object.freeze({ text: read('text'), code: read('code'), terminal: read('terminal') })
}

/** Font lists the Host boot script wrote on `body`, read for the same first-paint reason as {@link bootstrapFontSizes}. */
function bootstrapFontFamilies(): FontFamilies {
  /* v8 ignore next -- needs a documentless run (node e2e booting the client tree), not constructible under jsdom */
  if (typeof document === 'undefined') return Object.freeze({ text: '', code: '', terminal: '' })
  const style = document.body.style
  return Object.freeze({
    text: normalizeFontFamily(style.getPropertyValue(fontFamilyVariable('text'))),
    code: normalizeFontFamily(style.getPropertyValue(fontFamilyVariable('code'))),
    terminal: normalizeFontFamily(style.getPropertyValue(fontFamilyVariable('terminal'))),
  })
}

/** Normalized font lists from one accepted settings section (hand-edited documents may hold raw input). */
function durableFontFamilies(section: ThemeSettings): FontFamilies {
  return Object.freeze({
    text: normalizeFontFamily(section.textFontFamily),
    code: normalizeFontFamily(section.codeFontFamily),
    terminal: normalizeFontFamily(section.terminalFontFamily),
  })
}

/**
 * Custom theme inputs from one accepted settings section. Documents written
 * before the custom fields existed carry none, and hand-edited documents may
 * hold raw values; missing or malformed fields fall back to the custom schema
 * defaults, mirroring what validation would have filled in.
 * @param section - accepted settings section.
 * @returns the scheme, canvas, and accent inputs.
 */
function sectionCustomInputs(section: ThemeSettings): CustomThemeInputs {
  return {
    scheme: section.customScheme === 'dark' ? 'dark' : 'light',
    canvas: isHexColor(section.customCanvas) ? normalizeHexColor(section.customCanvas) : DEFAULT_CUSTOM_CANVAS,
    accent: isHexColor(section.customAccent) ? normalizeHexColor(section.customAccent) : DEFAULT_CUSTOM_ACCENT,
  }
}

/**
 * Saved custom-theme presets from one accepted settings section. Hand-edited
 * documents may carry junk: entries with an empty/overlong name, a bad scheme,
 * or malformed colors are dropped, colors are normalized, duplicate names keep
 * the first, and the list caps at {@link CUSTOM_PRESETS_MAX}.
 * @param section - accepted settings section.
 * @returns the valid presets in document order.
 */
function sectionCustomPresets(section: ThemeSettings): CustomThemePreset[] {
  const presets: CustomThemePreset[] = []
  for (const preset of Array.isArray(section.customPresets) ? section.customPresets : []) {
    const candidate = preset as Partial<CustomThemePreset> | null
    if (typeof candidate?.name !== 'string') continue
    const name = candidate.name.trim()
    if (name === '' || codePointLength(name) > CUSTOM_PRESET_NAME_MAX) continue
    if (candidate.scheme !== 'light' && candidate.scheme !== 'dark') continue
    if (!isHexColor(candidate.canvas) || !isHexColor(candidate.accent)) continue
    if (presets.some(saved => saved.name === name)) continue
    if (presets.length >= CUSTOM_PRESETS_MAX) break
    presets.push({
      name, scheme: candidate.scheme, canvas: normalizeHexColor(candidate.canvas), accent: normalizeHexColor(candidate.accent),
    })
  }
  return presets
}

/** Whether two presets carry identical values. */
function presetEqual(left: CustomThemePreset, right: CustomThemePreset): boolean {
  return left.name === right.name && left.scheme === right.scheme
    && left.canvas === right.canvas && left.accent === right.accent
}

/**
 * Runtime shape check for one override layer (model-authored callers pass
 * untyped JS through the dynamic-package façade, so the static type cannot
 * enforce the pair shape there). Returns a defensive per-token copy so later
 * caller mutation cannot reach the stored layer.
 */function validateOverrides(source: string, tokens: ThemeTokenOverrides): ThemeTokenOverrides {
  const validated: ThemeTokenOverrides = {}
  for (const [name, value] of Object.entries<unknown>(tokens)) {
    if (typeof value === 'string') {
      throw new TypeError(
        `theme override "${name}" from "${source}" is a bare string — pass { light: ${JSON.stringify(value)}, dark: ${JSON.stringify(value)} } `
        + '(repeat the value when it is the same in both palettes); a single value goes illegible when the user switches color scheme',
      )
    }
    if (typeof value !== 'object' || value === null
      || typeof (value as { light?: unknown }).light !== 'string'
      || typeof (value as { dark?: unknown }).dark !== 'string') {
      throw new TypeError(
        `theme override "${name}" from "${source}" must map to a { light, dark } pair of strings — one value per color scheme`,
      )
    }
    const modes = value as ThemeTokenModes
    validated[name] = { light: modes.light, dark: modes.dark }
  }
  return validated
}

function dynamicToken(name: string): ThemeTokenInspection {
  return {
    name,
    description: 'Theme token registered by the current Client composition.',
    valueType: 'CSS value',
    requiresLightAndDark: true,
    ...(name.startsWith('--') ? { cssVariable: name } : {}),
  }
}

/** Register desktop font-size keys when keyboard and locale services are available. */
function installFontSizeShortcuts(ctx: ClientContext, adjust: (delta: 1 | -1) => void): void {
  ctx.inject(['shortcuts', 'locale'], (scope) => {
    if (scope.shortcuts.runtime !== 'desktop') return
    const t = scope.locale.bind(SETTINGS_NS)
    const combinations: { binding: NormalizedBinding; delta: 1 | -1 }[] = []
    // Fixed bindings drive both reservation and matching.
    for (const [direction, code, delta] of [['increase', 'Equal', 1], ['decrease', 'Minus', -1]] as const) {
      const binding = { code, modifiers: ['primary'] as const }
      const bindings = direction === 'increase'
        ? [binding, { code, modifiers: ['primary', 'shift'] as const }] as const : [binding] as const
      for (const candidate of bindings) {
        combinations.push({ binding: scope.shortcuts.describeBinding(candidate).binding as NormalizedBinding, delta })
      }
      scope.effect(() => scope.shortcuts.registerFixed({
        id: `fontSize.${direction}` as ShortcutCommandId, label: () => t(`fontSize.text.${direction}`),
        keys: scope.shortcuts.describeBinding(binding).keys,
        bindings, group: 'application',
      }), `ui-theme: ${direction} font size reference`)
    }
    scope.effect(() => scope.shortcuts.observeFixedInput((input) => {
      if (input.type === 'reset') return
      const { gesture, context } = input
      if (gesture.composing || gesture.defaultPrevented || gesture.repeat || context.region === 'terminal') return
      const matched = combinations.find(({ binding }) => binding.code === gesture.code
        && (['control', 'alt', 'shift', 'meta'] as const).every(modifier => gesture[modifier] === binding.modifiers.includes(modifier)))
      if (matched === undefined) return
      input.consume()
      adjust(matched.delta)
    }), 'ui-theme: font size input')
  })
}

/**
 * Required services: settings transport plus slots/locale for the Appearance
 * section. `remote` carries the forwarded settings invalidation that
 * `ctx.configForms.get(entryId)` subscribes to on this context.
 */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/**
 * Client plugin body: provide the theme service and register the feature-owned
 * Appearance section (a feature owns its settings surface). Desktop font-size
 * shortcuts share all three font-size settings when the keyboard service is
 * available.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  installThemeStyles(ctx)
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-theme: settings dictionaries')
  const host = ctx.configForms.get<ThemeSettings>(THEME_SETTINGS_NAMESPACE)
  const theme = new ThemeRuntime(ctx, host)
  ctx.provide('theme', theme)
  const t = ctx.locale.bind(SETTINGS_NS)

  const store = createAppearanceSectionStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (snapshot: ThemeSnapshot): void => {
    bound?.sync(
      snapshot.preference, projectThemeGallery(snapshot.themes),
      snapshot.fontSizes, snapshot.fontFamilies, snapshot.custom, snapshot.customPresets, snapshot.revision,
    )
  }
  ctx.on('theme/change', sync)
  const injected = (actions: BoundActions<typeof store>): AppearanceSectionInjected => {
    bound = actions
    // Re-sync from the getter so no event is lost between registration and
    // first render (the store's revision guard drops stale duplicates).
    sync(theme.getTheme())
    return {
      setTheme: (id) => { theme.setTheme(id) },
      setCustom: (patch) => { theme.setCustom(patch) },
      saveCustomPreset: (name) => { theme.saveCustomPreset(name) },
      deleteCustomPreset: (name) => { theme.deleteCustomPreset(name) },
      setFontSize: (role, px) => { theme.setFontSize(role, px) },
      setFontFamily: (role, value) => { theme.setFontFamily(role, value) },
    }
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'appearance',
    order: 5,
    label: () => t('appearance.title'),
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, AppearanceSection))
}
