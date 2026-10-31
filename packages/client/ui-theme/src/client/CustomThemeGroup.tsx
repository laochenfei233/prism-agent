/**
 * Custom theme group of the Appearance section: the base-palette segmented
 * control plus canvas and accent color pickers with curated presets, and the
 * saved-preset area. Every accepted change writes through the theme service,
 * which switches the preference to `custom` and re-synthesizes the theme live;
 * Reset restores the schema defaults. Picker drags commit on settle so a
 * continuous drag does not write the settings document per movement.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CUSTOM_PRESET_NAME_MAX, CUSTOM_PRESETS_MAX, DEFAULT_CUSTOM_ACCENT, DEFAULT_CUSTOM_CANVAS, DEFAULT_CUSTOM_SCHEME,
  isHexColor, type CustomThemeInputs, type CustomThemePreset,
} from '../theme-settings.ts'
import type { createAppearanceSectionStore } from './settings-store.ts'
import css from './AppearanceSection.module.css'

/** Injected business face: the custom-theme write and its saved presets. */
export interface CustomThemeGroupInjected {
  /** Change the custom theme inputs; the service switches the preference to `custom`. */
  setCustom: (patch: Partial<CustomThemeInputs>) => void
  /** Save the current inputs under a name; upserts by name. */
  saveCustomPreset: (name: string) => void
  /** Delete one named preset. */
  deleteCustomPreset: (name: string) => void
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

/** Props of the saved-preset field: list, copy, and the three writes. */
interface PresetFieldProps {
  /** Saved presets from the store. */
  presets: readonly CustomThemePreset[]
  /** Row label. */
  nameLabel: string
  /** Save input placeholder and aria label. */
  placeholder: string
  /** Save button label. */
  saveLabel: string
  /** Delete accessible-name template carrying `{name}`. */
  deleteLabel: string
  /** Save the current inputs under a name. */
  onSave: (name: string) => void
  /** Delete one named preset. */
  onDelete: (name: string) => void
  /** Apply one preset's inputs. */
  onApply: (inputs: CustomThemeInputs) => void
}

/**
 * The saved-preset field: a save row plus one chip per preset. The save button
 * disables itself for empty names, overlong names, and a full list with a new
 * name, so the service's teaching errors stay unreachable from the UI.
 * @param props - the preset list, copy, and writes.
 * @returns the preset area element tree.
 */
function PresetField({ presets, nameLabel, placeholder, saveLabel, deleteLabel, onSave, onDelete, onApply }: PresetFieldProps) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const atCap = presets.length >= CUSTOM_PRESETS_MAX && !presets.some(preset => preset.name === trimmed)
  const savable = trimmed !== '' && [...trimmed].length <= CUSTOM_PRESET_NAME_MAX && !atCap
  const save = (): void => {
    onSave(trimmed)
    setName('')
  }
  return (
    <div className={css.field}>
      <span className={css.rowLabel}>{nameLabel}</span>
      <div className={css.presetArea}>
        <div className={css.saveRow}>
          <input
            type="text"
            className={css.presetInput}
            value={name}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => {
              // Some IMEs report composition only through keyCode 229.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (event.key === 'Enter' && savable) save()
            }}
          />
          <button type="button" className={css.saveButton} disabled={!savable} onClick={save}>{saveLabel}</button>
        </div>
        {presets.length > 0 && (
          <div className={css.chips}>
            {presets.map(preset => (
              <span key={preset.name} className={css.chipRow}>
                <button
                  type="button"
                  className={css.chip}
                  onClick={() => { onApply({ scheme: preset.scheme, canvas: preset.canvas, accent: preset.accent }) }}
                >{preset.name}</button>
                <button
                  type="button"
                  className={css.chipDelete}
                  aria-label={deleteLabel.replace('{name}', () => preset.name)}
                  onClick={() => { onDelete(preset.name) }}
                >×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Render the custom theme group.
 * @param props - composed section-internal props.
 * @returns the group element tree.
 */
export function CustomThemeGroup({ t, setCustom, saveCustomPreset, deleteCustomPreset, useStore }: CustomThemeGroupProps) {
  const custom = useStore(s => s.custom)
  const customPresets = useStore(s => s.customPresets)
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
      <PresetField
        presets={customPresets}
        nameLabel={t('appearance.customPresets')}
        placeholder={t('appearance.customPresetPlaceholder')}
        saveLabel={t('appearance.customSave')}
        deleteLabel={t('appearance.customPresetDelete')}
        onSave={saveCustomPreset}
        onDelete={deleteCustomPreset}
        onApply={setCustom}
      />
    </div>
  )
}
