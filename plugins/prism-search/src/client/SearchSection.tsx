/**
 * The Prism Search settings section: switch `web_search` onto this provider and
 * choose the model that orders results. The model list is read from Models, so
 * this card never names a provider or a model of its own.
 *
 * The layout follows the app's settings pages: one 720px column, a 16/24 title
 * with a tertiary intro, settings-material cards, and one primary save action.
 *
 * @module @prism/prism-search/client/SearchSection
 */

import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import type { BridgeResult, ModelOption, SaveRequest, SearchSettingsView } from './bridge.ts'
import { ENGINE_LABELS } from './engine-labels.ts'
import type { SearchLocaleKey } from './locales.ts'
import { SEARCH_CSS } from './styles.ts'

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

/** Engine names shown before the coverage line ellipsizes. */
const COVERAGE_PREVIEW = 5

/** Names of every engine the provider queries, for the coverage line's tooltip. */
const ENGINE_TITLES = ENGINE_LABELS.map(engine => engine.label).join(' · ')

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

/** A rejected bridge call's message; the bridge itself reports `{ ok: false }` results. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the section.
 * @param props - translator and the data operations bound by the plugin body.
 * @returns the section element.
 */
export function SearchSection({ t, load, save }: SearchSectionProps): ReactElement {
  const selectId = useId()
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
    }).catch((error: unknown) => {
      if (active) setLoadError(messageOf(error))
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
      }).catch((error: unknown) => {
        setSaveError(messageOf(error))
      })
    }).catch((error: unknown) => {
      setSaving(false)
      setSaveError(messageOf(error))
    })
  }

  const coverage = `${ENGINE_LABELS.slice(0, COVERAGE_PREVIEW).map(engine => engine.label).join(' · ')} …`

  return (
    <section className="ps-section" aria-label={t('title')}>
      <style>{SEARCH_CSS}</style>
      <header className="ps-head">
        <h2 className="ps-title">{t('title')}</h2>
        <p className="ps-intro">{t('intro')}</p>
        <p className="ps-engines" title={ENGINE_TITLES}>
          {t('engines', { count: ENGINE_LABELS.length, list: coverage })}
        </p>
      </header>

      {loadError !== '' && <p className="ps-alert" role="alert">{t('error.load', { message: loadError })}</p>}

      {view === undefined && loadError === '' && <p className="ps-hint">{t('status.loading')}</p>}

      {view !== undefined && (
        <>
          <div className="ps-card">
            <div className="ps-row">
              <div className="ps-rowText">
                <div className="ps-rowTitle">{t('source.title')}</div>
                <p className="ps-rowDesc">
                  <span className="ps-dot" data-on={enabled} aria-hidden="true" />
                  {t('source.current')}
                  <span className="ps-mono">
                    {view.currentProvider.length === 0 ? t('source.default') : view.currentProvider}
                  </span>
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={t('source.enable')}
                className="ps-switch"
                disabled={!writable || saving}
                onClick={() => { setEnabled(value => !value); setSaved(false) }}
              >
                <span className="ps-thumb" />
              </button>
            </div>
            <p className="ps-hint">{t('source.hint')}</p>
          </div>

          <div className="ps-card">
            <div className="ps-field">
              <label className="ps-label" htmlFor={selectId}>{t('model.title')}</label>
              <select
                id={selectId}
                className="ps-select"
                value={selected}
                disabled={!writable || saving || view.models.length === 0}
                onChange={(event) => { setSelected(event.target.value); setSaved(false) }}
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
            </div>
            <p className={view.catalogError !== '' ? 'ps-alert' : 'ps-hint'}>
              {view.catalogError !== ''
                ? t('model.unavailable', { message: view.catalogError })
                : view.models.length === 0 ? t('model.empty') : t('model.hint', { count: view.models.length })}
            </p>
          </div>

          <div className="ps-actions">
            <button type="button" className="ps-primary" disabled={!writable || !dirty || saving} onClick={commit}>
              {saving ? t('action.saving') : t('action.save')}
            </button>
            <span className="ps-status" role="status" aria-live="polite">{saved ? t('status.saved') : ''}</span>
            {saveError !== '' && <span className="ps-alert" role="alert">{t('error.save', { message: saveError })}</span>}
            {!writable && <span className="ps-hint">{t('error.unwritable')}</span>}
          </div>
        </>
      )}
    </section>
  )
}
