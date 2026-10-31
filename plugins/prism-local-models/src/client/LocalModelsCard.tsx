/**
 * Models-page footer card: one row per local model family with its variant
 * selector, lifecycle state, and install controls. All data comes from the
 * plugin's `/api/local-models` routes; while a family is busy the card polls
 * the status route once a second.
 *
 * @module @prism/prism-local-models/client/LocalModelsCard
 */

import { useCallback, useEffect, useState, type CSSProperties, type Dispatch, type ReactElement, type SetStateAction } from 'react'
import type { ModelFamilyView, ModelKind, ModelStatus } from '../types.ts'
import { fetchCatalog, postCancel, postInstall, postProbe, postRemove, type RouteError } from './api.ts'
import type { LocalModelsLocaleKey } from './locales.ts'
import { formatBytes, progressText } from './pure.ts'

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

  const act = useCallback((_modelId: string, run: () => Promise<unknown>): void => {
    void run().then(refresh).catch((_error: RouteError) => {
      refresh()
    })
  }, [refresh])

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <strong>{t('title')}</strong>
        <span style={styles.path} title={modelsRoot}>{t('path')}: {modelsRoot}</span>
      </div>
      {loadError !== '' && <div style={styles.errorLine}>{t('load.error', { error: loadError })}</div>}
      {families.map(family => (
        <FamilyRow
          key={family.id}
          family={family}
          t={t}
          selectedVariantId={selections[family.id] ?? family.selectedVariantId}
          onSelect={variantId => setSelections(previous => ({ ...previous, [family.id]: variantId }))}
          probeRunning={probes[family.id]?.running === true}
          onInstall={variantId => act(family.id, () => postInstall(family.id, variantId))}
          onCancel={() => act(family.id, () => postCancel(family.id))}
          onRemove={() => {
            if (window.confirm(t('remove.confirm'))) act(family.id, () => postRemove(family.id))
          }}
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
      <div style={styles.note}>{t('note.ocr')}</div>
    </div>
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

/** One model family row. */
function FamilyRow(props: {
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
  return (
    <div style={styles.row}>
      <div style={styles.rowHead}>
        <strong>{family.displayName}</strong>
        <span style={styles.chip}>{t(KIND_KEYS[family.kind])}</span>
        <span style={isBusy(family) ? styles.busy : family.status === 'error' ? styles.errorLine : styles.muted}>
          {t(STATUS_KEYS[family.status])}
          {isBusy(family) && family.progress !== undefined && progressText(family.progress)}
        </span>
      </div>
      {family.status === 'error' && family.error !== undefined && <div style={styles.errorLine}>{family.error}</div>}
      <div style={styles.rowActions}>
        <select
          value={selectedVariantId}
          disabled={isBusy(family)}
          onChange={event => onSelect(event.target.value)}
          style={styles.select}
        >
          {family.variants.map(variant => (
            <option key={variant.id} value={variant.id}>
              {variant.installed ? '✓ ' : ''}{variant.displayName} · {variant.device === 'cuda' ? `${t('device.cuda')} · ` : ''}{formatBytes(variant.sizeBytes)}
            </option>
          ))}
        </select>
        {isBusy(family)
          ? <button type="button" style={styles.button} onClick={onCancel}>{t('action.cancel')}</button>
          : <>
            {family.status !== 'ready' && selectedVariantId !== undefined
              && <button type="button" style={styles.button} onClick={() => onInstall(selectedVariantId)}>{t('action.install')}</button>}
            {family.status === 'ready'
              && <>
                <button type="button" style={styles.button} onClick={onProbe} disabled={probeRunning}>{t('action.probe')}</button>
                <button type="button" style={styles.button} onClick={onRemove}>{t('action.remove')}</button>
              </>}
          </>}
      </div>
      {family.probe !== undefined && (
        <div style={family.probe.ok ? styles.muted : styles.errorLine}>
          {family.probe.ok
            ? t('probe.ok', { detail: family.probe.detail ?? '' })
            : t('probe.fail', { error: family.probe.error ?? '' })}
        </div>
      )}
      {probeRunning && <div style={styles.muted}>{t('probe.running')}</div>}
    </div>
  )
}

/** Card styles; neutral inline rules that inherit the app theme. */
const styles: Record<string, CSSProperties> = {
  card: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0' },
  header: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
  path: { fontSize: 12, opacity: 0.65, overflowWrap: 'anywhere' },
  row: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)', paddingTop: 8 },
  rowHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chip: { fontSize: 11, padding: '1px 6px', borderRadius: 8, border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', opacity: 0.8 },
  muted: { fontSize: 12, opacity: 0.7 },
  busy: { fontSize: 12, opacity: 0.9 },
  errorLine: { fontSize: 12, color: 'crimson', overflowWrap: 'anywhere' },
  select: { maxWidth: 300 },
  button: { cursor: 'pointer' },
  note: { fontSize: 12, opacity: 0.6 },
}
