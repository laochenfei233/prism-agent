/**
 * Appearance section store: a mirror of the theme service snapshot feeding the
 * section's three groups (theme gallery, custom theme, fonts). The plugin's
 * apply-world change listener is the only writer; the section components read
 * via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ThemeGalleryEntry } from './gallery.ts'
import {
  DEFAULT_CUSTOM_ACCENT, DEFAULT_CUSTOM_CANVAS, DEFAULT_CUSTOM_SCHEME, DEFAULT_FONT_SIZES,
  type CustomThemeInputs, type FontFamilies, type FontSizes, type ThemePreference,
} from '../theme-settings.ts'

/** Store state mirrored from the theme snapshot. */
export interface AppearanceSectionState {
  /** Persisted preference (selection state reads this, never the resolved active theme). */
  preference: ThemePreference
  /** Gallery rows for the current registry, `system` first, the custom theme last. */
  entries: readonly ThemeGalleryEntry[]
  /** Persisted font sizes in px by role. */
  fontSizes: FontSizes
  /** Persisted normalized font lists by role. */
  fontFamilies: FontFamilies
  /** Persisted custom theme inputs. */
  custom: CustomThemeInputs
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type AppearanceSectionActions = {
  sync: (
    draft: AppearanceSectionState,
    preference: ThemePreference,
    entries: readonly ThemeGalleryEntry[],
    fontSizes: FontSizes,
    fontFamilies: FontFamilies,
    custom: CustomThemeInputs,
    revision: number,
  ) => void
}

/**
 * Declares the Appearance section state and write surface.
 * @returns the store handle.
 */
export function createAppearanceSectionStore(): EngineStoreHandle<AppearanceSectionState, AppearanceSectionActions> {
  return defineStore({
    init: (): AppearanceSectionState => ({
      preference: 'system',
      entries: [],
      fontSizes: DEFAULT_FONT_SIZES,
      fontFamilies: { text: '', code: '', terminal: '' },
      custom: { scheme: DEFAULT_CUSTOM_SCHEME, canvas: DEFAULT_CUSTOM_CANVAS, accent: DEFAULT_CUSTOM_ACCENT },
      revision: -1,
    }),
    actions: {
      sync: (
        d,
        preference: ThemePreference,
        entries: readonly ThemeGalleryEntry[],
        fontSizes: FontSizes,
        fontFamilies: FontFamilies,
        custom: CustomThemeInputs,
        revision: number,
      ) => {
        if (revision <= d.revision) return
        d.preference = preference
        d.entries = entries
        d.fontSizes = fontSizes
        d.fontFamilies = fontFamilies
        d.custom = custom
        d.revision = revision
      },
    },
  })
}
