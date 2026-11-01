/**
 * Models-page footer card: one card per local model family with its variant
 * selector, lifecycle state, install controls, and download progress. All data
 * comes from the plugin's `/api/local-models` routes; while a family is busy
 * the card polls the status route once a second.
 *
 * @module @prism/prism-local-models/client/LocalModelsCard
 */

import { useCallback, useEffect, useState, type Dispatch, type ReactElement, type SetStateAction } from 'react'
import { Button, Modal, StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelFamilyView, ModelKind, ModelStatus } from '../types.ts'
import { fetchCatalog, postCancel, postInstall, postProbe, postRemove, type RouteError } from './api.ts'
import type { LocalModelsLocaleKey } from './locales.ts'
import { formatBytes, progressPercent, progressText } from './pure.ts'
import { LOCAL_MODELS_CSS } from './styles.ts'

/** Props bound by the slot renderer. */
export interface LocalModelsCardProps {
  /** Translator bound to this plugin's namespace. */
  t: (key: LocalModelsLocaleKey, params?: Record<string, string | number>) => string
}

/** Copy key of each lifecycle state. */
const STATUS_KEYS: Readonly<Record<ModelStatus, LocalModelsLocaleKey>> = {
  idle: 'status.idle',
  downloading: 'status.downloading',
  provisioning: 'status.provisioning',
  ready: 'status.ready',
  error: 'status.error',
}

/** Status dot of each lifecycle state; `ongoing` is the shared spinner. */
const STATUS_DOTS: Readonly<Record<ModelStatus, StateDotState>> = {
  idle: 'idle',
  downloading: 'ongoing',
  provisioning: 'ongoing',
  ready: 'done',
  error: 'error',
}

/** Copy key of each capability class. */
const KIND_KEYS: Readonly<Record<ModelKind, LocalModelsLocaleKey>> = {
  ocr: 'kind.ocr',
  translation: 'kind.translation',
  embedding: 'kind.embedding',
}

/** Whether the family has an operation the card must keep polling. */
function isBusy(family: ModelFamilyView): boolean {
  return family.status === 'downloading' || family.status === 'provisioning'
}

/** The Models-page footer card. @param props - renderer-bound translator. */
export function LocalModelsCard({ t }: LocalModelsCardProps): ReactElement {
  const [families, setFamilies] = useState<readonly ModelFamilyView[]>([])
  const [modelsRoot, setModelsRoot] = useState('')
  const [loadError, setLoadError] = useState('')
  const [probes, setProbes] = useState<Record<string, { running: boolean } | undefined>>({})
  const [selections, setSelections] = useState<Record<string, string | undefined>>({})
  const [removal, setRemoval] = useState<ModelFamilyView | undefined>(undefined)
  const [removing, setRemoving] = useState(false)
  const [removeFailure, setRemoveFailure] = useState('')
  const [failure, setFailure] = useState('')

  const refresh = useCallback((): void => {
    void fetchCatalog().then(catalog => {
      setFamilies(catalog.families)
      setModelsRoot(catalog.modelsRoot)
      setLoadError('')
    }).catch((error: RouteError) => {
      setLoadError(error.message)
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const busy = families.some(isBusy)
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(refresh, 1000)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  const act = useCallback((run: () => Promise<unknown>): void => {
    setFailure('')
    void run().then(refresh).catch((error: RouteError) => {
      setFailure(error.message)
      refresh()
    })
  }, [refresh])

  const confirmRemoval = (): void => {
    if (removal === undefined || removing) return
    setRemoving(true)
    setRemoveFailure('')
    void postRemove(removal.id)
      .then(() => {
        setRemoving(false)
        setRemoval(undefined)
        refresh()
      })
      .catch((error: RouteError) => {
        setRemoving(false)
        setRemoveFailure(error.message)
      })
  }

  return (
    <section className="lmm">
      <style>{LOCAL_MODELS_CSS}</style>
      <h3 className="lmm-title">{t('title')}</h3>
      <p className="lmm-intro">{t('intro')}</p>
      {modelsRoot !== '' && <p className="lmm-path" title={modelsRoot}>{t('path')}: {modelsRoot}</p>}
      {loadError !== '' && <p className="lmm-message" data-tone="error">{t('load.error', { error: loadError })}</p>}
      {failure !== '' && <p className="lmm-message" data-tone="error">{t('action.failed', { error: failure })}</p>}
      <ul className="lmm-rows">
        {families.map(family => (
          <FamilyCard
            key={family.id}
            family={family}
            t={t}
            selectedVariantId={selections[family.id] ?? family.selectedVariantId}
            onSelect={variantId => setSelections(previous => ({ ...previous, [family.id]: variantId }))}
            probeRunning={probes[family.id]?.running === true}
            onInstall={variantId => act(() => postInstall(family.id, variantId))}
            onCancel={() => act(() => postCancel(family.id))}
            onRemove={() => setRemoval(family)}
            onProbe={() => {
              setProbes(previous => ({ ...previous, [family.id]: { running: true } }))
              void postProbe(family.id)
                .then(outcome => {
                  setProbes(previous => ({ ...previous, [family.id]: { running: false } }))
                  applyProbe(setFamilies, family.id, outcome)
                })
                .catch((error: RouteError) => {
                  setProbes(previous => ({ ...previous, [family.id]: { running: false } }))
                  applyProbe(setFamilies, family.id, { ok: false, error: error.message })
                })
            }}
          />
        ))}
      </ul>
      <p className="lmm-note">{t('note.ocr')}</p>
      <Modal
        open={removal !== undefined}
        title={t('remove.title', { model: removal?.displayName ?? '' })}
        closeLabel={t('action.close')}
        description={t('remove.confirm')}
        onClose={() => { if (!removing) setRemoval(undefined) }}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus disabled={removing} onClick={() => setRemoval(undefined)}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="outline"
              className="lmm-danger"
              disabled={removing}
              onClick={confirmRemoval}
            >{t('action.remove')}</Button>
          </>
        )}
      >
        {removeFailure !== '' && (
          <p className="lmm-message" data-tone="error">{t('action.failed', { error: removeFailure })}</p>
        )}
      </Modal>
    </section>
  )
}

/** Write one probe outcome back into the displayed family list. */
function applyProbe(
  setFamilies: Dispatch<SetStateAction<readonly ModelFamilyView[]>>,
  modelId: string,
  outcome: { ok: boolean; detail?: string; error?: string },
): void {
  setFamilies(previous => previous.map(family => family.id === modelId
    ? { ...family, probe: outcome.ok ? { ok: true, detail: outcome.detail } : { ok: false, error: outcome.error } }
    : family))
}

/** One model family card. */
function FamilyCard(props: {
  family: ModelFamilyView
  t: LocalModelsCardProps['t']
  selectedVariantId: string
  onSelect: (variantId: string) => void
  probeRunning: boolean
  onInstall: (variantId: string) => void
  onCancel: () => void
  onRemove: () => void
  onProbe: () => void
}): ReactElement {
  const { family, t, selectedVariantId, onSelect, probeRunning, onInstall, onCancel, onRemove, onProbe } = props
  const percent = family.progress === undefined ? undefined : progressPercent(family.progress)
  const status = t(STATUS_KEYS[family.status])
  return (
    <li className="lmm-card">
      <div className="lmm-head">
        <span className="lmm-name">{family.displayName}</span>
        <Tag>{t(KIND_KEYS[family.kind])}</Tag>
        <span className="lmm-status" data-state={family.status}>
          <StateDot state={STATUS_DOTS[family.status]} />
          {status}
          {isBusy(family) && family.progress !== undefined ? progressText(family.progress) : ''}
        </span>
      </div>
      <div className="lmm-body">
        <select
          value={selectedVariantId}
          disabled={isBusy(family)}
          aria-label={t('variant.label', { model: family.displayName })}
          onChange={event => { onSelect(event.currentTarget.value) }}
          className="lmm-select"
        >
          {family.variants.map(variant => (
            <option key={variant.id} value={variant.id}>
              {variant.installed ? '✓ ' : ''}{variant.displayName} · {variant.device === 'cuda' ? `${t('device.cuda')} · ` : ''}{variant.sizeBytes > 0 ? formatBytes(variant.sizeBytes) : t('variant.provisioned')}
            </option>
          ))}
        </select>
        <div className="lmm-actions">
          {isBusy(family)
            ? <Button size="sm" onClick={onCancel}>{t('action.cancel')}</Button>
            : (
              <>
                {family.status !== 'ready'
                  && <Button size="sm" variant="primary" onClick={() => { onInstall(selectedVariantId) }}>{t('action.install')}</Button>}
                {family.status === 'ready'
                  && (
                    <>
                      <Button size="sm" variant="outline" onClick={onProbe} disabled={probeRunning}>
                        {probeRunning ? t('probe.running') : t('action.probe')}
                      </Button>
                      <Button size="sm" className="lmm-danger" onClick={onRemove}>{t('action.remove')}</Button>
                    </>
                  )}
              </>
            )}
        </div>
      </div>
      {percent !== undefined && (
        <div
          className="lmm-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('progress.label', { model: family.displayName })}
        >
          <div className="lmm-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {family.status === 'error' && family.error !== undefined
        && <p className="lmm-message" data-tone="error">{family.error}</p>}
      {family.probe !== undefined && (
        <p className="lmm-message" data-tone={family.probe.ok ? undefined : 'error'}>
          {family.probe.ok
            ? t('probe.ok', { detail: family.probe.detail ?? '' })
            : t('probe.fail', { error: family.probe.error ?? '' })}
        </p>
      )}
    </li>
  )
}
