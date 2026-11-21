/**
 * Theme gallery group of the Appearance section: one card per selectable
 * preference, each showing a miniature of the palette it selects. The gallery
 * is rebuilt from the theme registry, so a theme another package registers
 * appears here without this group knowing about it. Selection follows the
 * persisted preference, never the resolved active theme.
 */
import clsx from 'clsx'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeGalleryEntry } from './gallery.ts'
import type { createAppearanceSectionStore } from './settings-store.ts'
import { THEME_LABEL_KEYS, type ThemeKey } from './locales.ts'
import css from './AppearanceRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface AppearanceRowInjected {
  /** Switch the theme preference; accepts any registered theme id, `system`, or `custom`. */
  setTheme: (id: string) => void
}

/** Component props: section store share + locale seat + injected face. */
export type AppearanceRowComponentProps =
  PropsStore<ReturnType<typeof createAppearanceSectionStore>>
  & PropsLocale<'settings.theme'> & AppearanceRowInjected

/** The locale seat's translate function, taken from the composed props. */
type GalleryTranslate = AppearanceRowComponentProps['t']

/**
 * Resolve one row's display copy.
 * @param id - preference id.
 * @param t - the row's locale seat.
 * @returns the localized label, or the id for a theme this package does not name.
 */
function themeLabel(id: string, t: GalleryTranslate): string {
  const key: ThemeKey | undefined = THEME_LABEL_KEYS[id]
  return key === undefined ? id : t(key)
}

/**
 * Preview custom properties for one row. Returned as a plain string map and
 * spread at the style site: `CSSProperties` has no custom-property index, and
 * a spread is the one position TypeScript does not excess-check.
 * @param entry - the row's gallery entry.
 * @returns the three preview colors plus the theme's textures when it carries any.
 */
function previewVariables(entry: ThemeGalleryEntry): Record<string, string> {
  return {
    '--preview-base': entry.base,
    '--preview-surface': entry.surface,
    '--preview-accent': entry.accent,
    ...(entry.canvasImage !== undefined ? { '--preview-image': entry.canvasImage } : {}),
    ...(entry.centerImage !== undefined ? { '--preview-center': entry.centerImage } : {}),
  }
}

/** Preview class per composition; motifs without their own sheet render the plain miniature. */
const MOTIF_CLASS: Record<ThemeGalleryEntry['motif'], string | undefined> = {
  plain: undefined,
  split: css.split,
  sheet: css.sheet,
  night: css.night,
  grid: css.grid,
  beacon: css.beacon,
  strata: css.strata,
  grain: css.grain,
  plan: css.plan,
  crt: css.crt,
  ink: css.ink,
  fern: css.fern,
  bespoke: undefined,
}

/**
 * Render the theme gallery group.
 * @param props - composed section-internal props.
 * @returns the group element tree.
 */
export function AppearanceRow({ t, setTheme, useStore }: AppearanceRowComponentProps) {
  const preference = useStore(s => s.preference)
  const entries = useStore(s => s.entries)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.gallery')}</div>
      <div className={css.gallery} role="group" aria-label={t('appearance.gallery')}>
        {entries.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={clsx(css.themeCard, preference === entry.id && css.selected)}
            aria-pressed={preference === entry.id}
            onClick={() => { setTheme(entry.id) }}
          >
            <span className={clsx(css.preview, MOTIF_CLASS[entry.motif])} style={{ ...previewVariables(entry) }}>
              <span className={css.previewRail} />
              <span className={css.previewBody}>
                <span className={css.previewCard} />
                <span className={css.previewCard} />
              </span>
              <span className={css.previewAccent} />
            </span>
            <span className={css.label}>{themeLabel(entry.id, t)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
