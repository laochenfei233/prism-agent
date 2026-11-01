/**
 * The Prism Search settings section: switch `web_search` onto this provider and
 * choose the model that orders results. The model list is read from Models, so
 * this card never names a provider or a model of its own.
 *
 * @module @prism/prism-search/client/SearchSection
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import type { BridgeResult, ModelOption, SaveRequest, SearchSettingsView } from './bridge.ts'
import type { SearchLocaleKey } from './locales.ts'

/** Props the slot renderer binds. */
export interface SearchSectionProps {
  /** Translator bound to this plugin's namespace. */
  readonly t: (key: SearchLocaleKey, params?: Record<string, string | number>) => string
  /** Read the current selection and the model catalog. */
  readonly load: () => Promise<BridgeResult<SearchSettingsView>>
  /** Persist one staged choice. */
  readonly save: (request: SaveRequest) => Promise<BridgeResult<void>>
}

/** One provider's option group. */
interface ModelGroup {
  readonly name: string
  readonly options: readonly ModelOption[]
}

/** Stable identity of one selectable route. */
function keyOf(option: ModelOption): string {
  return `${option.provider}\u0000${option.model}`
}

/** The selected key for a loaded view, empty when ordering is off or the route is gone. */
function initialKey(view: SearchSettingsView): string {
  if (view.rerankProvider.length === 0 || view.rerankModel.length === 0) return ''
  const match = view.models.find(option => option.provider === view.rerankProvider && option.model === view.rerankModel)
  return match === undefined ? '' : keyOf(match)
}

/** Group the catalog by provider for the picker. */
function groupModels(view: SearchSettingsView): ModelGroup[] {
  const groups = new Map<string, { name: string; options: ModelOption[] }>()
  for (const option of view.models) {
    const group = groups.get(option.provider) ?? { name: option.providerName, options: [] }
    group.options.push(option)
    groups.set(option.provider, group)
  }
  return [...groups.values()]
}

/**
 * Render the section.
 * @param props - translator and the data operations bound by the plugin body.
 * @returns the section element.
 */
export function SearchSection({ t, load, save }: SearchSectionProps): ReactElement {
  const [view, setView] = useState<SearchSettingsView | undefined>(undefined)
  const [loadError, setLoadError] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let active = true
    void load().then((result) => {
      if (!active) return
      if (!result.ok) {
        setLoadError(result.message)
        return
      }
      setLoadError('')
      setView(result.value)
      setEnabled(result.value.enabled)
      setSelected(initialKey(result.value))
    })
    return () => { active = false }
  }, [load])

  const groups = useMemo(() => (view === undefined ? [] : groupModels(view)), [view])
  const dirty = view !== undefined && (enabled !== view.enabled || selected !== initialKey(view))
  const writable = view?.writable === true

  const commit = (): void => {
    if (view === undefined || saving) return
    const option = view.models.find(candidate => keyOf(candidate) === selected)
    setSaving(true)
    setSaved(false)
    setSaveError('')
    void save({
      enabled,
      enabledChanged: enabled !== view.enabled,
      model: option,
      webRevision: view.webRevision,
      ownRevision: view.ownRevision,
    }).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setSaveError(result.message)
        return
      }
      setSaved(true)
      void load().then((next) => {
        if (!next.ok) return
        setView(next.value)
        setEnabled(next.value.enabled)
        setSelected(initialKey(next.value))
      })
    })
  }

  return (
    <div style={styles.section}>
      <div style={styles.title}>{t('title')}</div>
      <div style={styles.hint}>{t('description')}</div>
      {loadError !== '' && <div style={styles.error}>{t('error.load', { message: loadError })}</div>}
      {view !== undefined && (
        <>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!writable || saving}
              onChange={(event) => { setEnabled(event.target.checked); setSaved(false) }}
            />
            <span>{t('provider.enable')}</span>
          </label>
          <div style={styles.hint}>
            {t('provider.current', { provider: view.currentProvider.length === 0 ? t('provider.composed') : view.currentProvider })}
            {' · '}
            {t('provider.enableHint')}
          </div>
          <label style={styles.row}>
            <span>{t('model.label')}</span>
            <select
              value={selected}
              disabled={!writable || saving || view.models.length === 0}
              onChange={(event) => { setSelected(event.target.value); setSaved(false) }}
              style={styles.select}
            >
              <option value="">{t('model.none')}</option>
              {groups.map(group => (
                <optgroup key={group.name} label={group.name}>
                  {group.options.map(option => (
                    <option key={keyOf(option)} value={keyOf(option)}>{option.modelName}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div style={styles.hint}>
            {view.models.length === 0 ? t('model.empty') : t('model.hint', { count: view.models.length })}
          </div>
          <div style={styles.row}>
            <button type="button" disabled={!writable || !dirty || saving} onClick={commit} style={styles.button}>
              {saving ? t('action.saving') : t('action.save')}
            </button>
            {saved && <span style={styles.ok}>{t('status.saved')}</span>}
            {saveError !== '' && <span style={styles.error}>{t('error.save', { message: saveError })}</span>}
            {!writable && <span style={styles.error}>{t('error.unwritable')}</span>}
          </div>
        </>
      )}
    </div>
  )
}

/** Section styles; neutral inline rules that inherit the app theme. */
const styles: Record<string, CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' },
  title: { fontSize: 16, fontWeight: 600 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  hint: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
  select: { minWidth: 260, maxWidth: 420 },
  button: { cursor: 'pointer' },
  ok: { fontSize: 12, opacity: 0.8 },
  error: { fontSize: 12, color: 'crimson', overflowWrap: 'anywhere' },
}
