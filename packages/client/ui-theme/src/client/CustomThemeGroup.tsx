/**
 * Custom theme group of the Appearance section: the base-palette segmented
 * control plus canvas and accent color pickers with curated presets. Every
 * accepted change writes through the theme service, which switches the
 * preference to `custom` and re-synthesizes the theme live; Reset restores the
 * schema defaults. Picker drags commit on settle so a continuous drag does not
 * write the settings document per movement.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_CUSTOM_ACCENT, DEFAULT_CUSTOM_CANVAS, DEFAULT_CUSTOM_SCHEME, isHexColor,
  type CustomThemeInputs,
} from '../theme-settings.ts'
import type { createAppearanceSectionStore } from './settings-store.ts'
import css from './AppearanceSection.module.css'

/** Injected business face: the custom-theme write. */
export interface CustomThemeGroupInjected {
  /** Change the custom theme inputs; the service switches the preference to `custom`. */
  setCustom: (patch: Partial<CustomThemeInputs>) => void
}

/** Component props: section store share + locale seat + injected face. */
export type CustomThemeGroupProps =
  PropsStore<ReturnType<typeof createAppearanceSectionStore>>
  & PropsLocale<'settings.theme'> & CustomThemeGroupInjected

/** Curated canvas presets, spanning the light and dark lightness bands. */
const CANVAS_PRESETS = ['#ffffff', '#f4eee1', '#fafaf8', '#edf0e8', '#151517', '#0d0a05', '#10293f'] as const

/** Curated accent presets. */
const ACCENT_PRESETS = ['#ff6900', '#c2402a', '#3f6b4a', '#4176ee', '#8b5cf6', '#ffb000'] as const

/** Settle delay before a picker drag commits its final color. */
const PICKER_COMMIT_MS = 150

/** Props of one color field: committed value, presets, copy, and the write. */
interface ColorFieldProps {
  /** Committed color (`#rrggbb`). */
  value: string
  /** Curated preset colors. */
  presets: readonly string[]
  /** Row label. */
  label: string
  /** Native picker accessible name. */
  inputLabel: string
  /** Commit one color. */
  onCommit: (hex: string) => void
}

/**
 * One color field: preset swatches, the native picker, and the committed hex.
 * Picker movements update a local draft and commit once the draft settles.
 * @param props - the field's value, presets, copy, and write.
 * @returns the swatch row element tree.
 */
function ColorField({ value, presets, label, inputLabel, onCommit }: ColorFieldProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => {
    if (draft === value || !isHexColor(draft)) return
    const timer = window.setTimeout(() => { onCommit(draft) }, PICKER_COMMIT_MS)
    return () => { window.clearTimeout(timer) }
  }, [draft, value, onCommit])
  return (
    <div className={css.field}>
      <span className={css.rowLabel}>{label}</span>
      <div className={css.swatches}>
        {presets.map(hex => (
          <button
            key={hex}
            type="button"
            className={clsx(css.swatch, value === hex && css.swatchActive)}
            style={{ background: hex }}
            aria-label={`${label} ${hex}`}
            aria-pressed={value === hex}
            onClick={() => { onCommit(hex) }}
          />
        ))}
        <input
          type="color"
          className={css.pickerInput}
          value={draft}
          aria-label={inputLabel}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <span className={css.hex}>{value}</span>
      </div>
    </div>
  )
}

/**
 * Render the custom theme group.
 * @param props - composed section-internal props.
 * @returns the group element tree.
 */
export function CustomThemeGroup({ t, setCustom, useStore }: CustomThemeGroupProps) {
  const custom = useStore(s => s.custom)
  const dirty = custom.scheme !== DEFAULT_CUSTOM_SCHEME
    || custom.canvas !== DEFAULT_CUSTOM_CANVAS
    || custom.accent !== DEFAULT_CUSTOM_ACCENT
  return (
    <div className={css.group}>
      <div className={css.groupHeader}>
        <div className={css.title}>{t('appearance.customGroup')}</div>
        <button
          type="button"
          className={css.reset}
          disabled={!dirty}
          onClick={() => { setCustom({ scheme: DEFAULT_CUSTOM_SCHEME, canvas: DEFAULT_CUSTOM_CANVAS, accent: DEFAULT_CUSTOM_ACCENT }) }}
        >{t('appearance.customReset')}</button>
      </div>
      <div className={css.field}>
        <span className={css.rowLabel}>{t('appearance.customScheme')}</span>
        <div className={css.segmented} role="group" aria-label={t('appearance.customScheme')}>
          <button
            type="button"
            className={clsx(css.segment, custom.scheme === 'light' && css.segmentActive)}
            aria-pressed={custom.scheme === 'light'}
            onClick={() => { setCustom({ scheme: 'light' }) }}
          >{t('appearance.customSchemeLight')}</button>
          <button
            type="button"
            className={clsx(css.segment, custom.scheme === 'dark' && css.segmentActive)}
            aria-pressed={custom.scheme === 'dark'}
            onClick={() => { setCustom({ scheme: 'dark' }) }}
          >{t('appearance.customSchemeDark')}</button>
        </div>
      </div>
      <ColorField
        value={custom.canvas}
        presets={CANVAS_PRESETS}
        label={t('appearance.customCanvas')}
        inputLabel={t('appearance.customCanvasInput')}
        onCommit={(hex) => { setCustom({ canvas: hex }) }}
      />
      <ColorField
        value={custom.accent}
        presets={ACCENT_PRESETS}
        label={t('appearance.customAccent')}
        inputLabel={t('appearance.customAccentInput')}
        onCommit={(hex) => { setCustom({ accent: hex }) }}
      />
    </div>
  )
}
