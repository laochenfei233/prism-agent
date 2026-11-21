/**
 * Storage tab of the 数据 settings page: where the harness home is, and the
 * copy that moves it. The page never resolves a path itself; it renders what
 * the Host answers and asks the Host to copy.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageOf } from '../errors.ts'
import type { DataLocationState, RelocationResult } from '../types.ts'
import { DataCallError, requestRelocate, requestReset, requestState } from './storage-client.ts'
import type { DataLocaleKey } from './locales.ts'
import css from './StoragePage.module.css'

type Translate = (key: DataLocaleKey, params?: Record<string, unknown>) => string

/** Props the section hands the storage tab. */
export interface StoragePageProps {
  /** Bound translator of the data dictionary. */
  readonly t: Translate
  /**
   * Ask the operator for one directory.
   * @param signal - optional cancellation.
   * @returns the absolute directory, or `null` on cancel.
   */
  readonly pick: (signal?: AbortSignal) => Promise<string | null>
}

/**
 * Locale key for one typed refusal; an unmapped code has no copy of its own.
 * @param code - machine code from the Host.
 * @returns the dictionary key, or undefined to fall back to the Host sentence.
 */
function copyKeyOf(code: string): DataLocaleKey | undefined {
  switch (code) {
    case 'prism-data/busy': return 'codeBusy'
    case 'prism-data/target-invalid': return 'codeTargetInvalid'
    case 'prism-data/target-not-empty': return 'codeTargetNotEmpty'
    case 'prism-data/copy-failed': return 'codeCopyFailed'
    case 'prism-data/pointer-failed': return 'codePointerFailed'
    case 'prism-data/bad-request': return 'codeBadRequest'
    default: return undefined
  }
}

/**
 * Localize one refused call: the typed code's copy first, the Host sentence as fallback.
 * @param error - the refusal.
 * @param t - bound translator.
 * @returns the sentence to render.
 */
function failureText(error: unknown, t: Translate): string {
  if (!(error instanceof DataCallError)) return messageOf(error)
  const key = copyKeyOf(error.code)
  return key === undefined ? error.message : t(key, { message: error.message })
}

/**
 * Render the storage tab.
 * @param props - localized copy and the directory picker.
 * @returns the location card, the change dialog, and the last copy's outcome.
 */
export function StoragePage({ t, pick }: StoragePageProps): ReactNode {
  const [location, setLocation] = useState<DataLocationState | null>(null)
  const [loadFailure, setLoadFailure] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  const [result, setResult] = useState<RelocationResult | null>(null)
  const [pickerFailed, setPickerFailed] = useState(false)

  useEffect(() => {
    let live = true
    requestState(t).then((next) => {
      if (live) setLocation(next)
    }, (reason: unknown) => {
      if (live) setLoadFailure(failureText(reason, t))
    })
    return () => { live = false }
    // The dictionary is stable for the page's lifetime; re-reading it would
    // only repeat the same call.
  }, [])

  const openDialog = (): void => {
    setTarget('')
    setActionFailure(null)
    setDialogOpen(true)
  }

  const chooseFolder = async (): Promise<void> => {
    try {
      const picked = await pick()
      if (picked !== null) {
        setTarget(picked)
        setPickerFailed(false)
      }
    } catch {
      setPickerFailed(true)
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setActionFailure(null)
    try {
      const copied = await requestRelocate(target, t)
      setResult(copied)
      setDialogOpen(false)
      setLocation(await requestState(t))
    } catch (reason: unknown) {
      setActionFailure(failureText(reason, t))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setActionFailure(null)
    try {
      setLocation(await requestReset(t))
      setResult(null)
    } catch (reason: unknown) {
      setActionFailure(failureText(reason, t))
    } finally {
      setBusy(false)
    }
  }

  if (location === null) {
    return <div className={css.card}>
      <p className={css.hint} role="status">{loadFailure ?? t('locationTitle')}</p>
    </div>
  }

  return <>
    <div className={css.card}>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowTitle}>{t('locationTitle')}</div>
          <code className={css.path}>{location.root}</code>
          <div className={css.hint}>{t('locationHint')}</div>
        </div>
        <Button variant="outline" size="sm" onClick={openDialog}>{t('change')}</Button>
      </div>
      {location.pendingRoot === undefined
        ? null
        : <p className={css.pending} role="status">{t('pendingRestart', { path: location.pendingRoot })}</p>}
      <p className={css.hint}>{t('envHint')}</p>
      {location.storedRoot === undefined
        ? null
        : <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.hint}>{t('resetHint')}</div>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void reset() }}>{t('reset')}</Button>
        </div>}
      {actionFailure === null || dialogOpen
        ? null
        : <div className={css.error} role="alert">{actionFailure}</div>}
    </div>

    {result === null ? null : <div className={css.card}>
      <h3 className={css.doneTitle}>{t('doneTitle')}</h3>
      <p className={css.hint}>{t('doneBody', { files: String(result.files), size: fileSizeText(result.bytes) })}</p>
      <p className={css.hint}>{t('donePrevious', { previous: result.previousRoot })}</p>
      <code className={css.path}>{result.target}</code>
      {result.skippedLinks.length === 0
        ? null
        : <p className={css.hint}>{t('skippedLinks', {
          count: String(result.skippedLinks.length),
          paths: result.skippedLinks.join(', '),
        })}</p>}
      <p className={css.hint}>{t('restartHint')}</p>
    </div>}

    <Modal
      open={dialogOpen}
      onClose={() => { if (!busy) setDialogOpen(false) }}
      title={t('dialogTitle')}
      closeLabel={t('cancel')}
      description={t('dialogBody')}
      footer={<>
        <Button disabled={busy} onClick={() => { setDialogOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || target.trim() === ''} onClick={() => { void submit() }}>
          {busy ? t('copying') : t('confirm')}
        </Button>
      </>}
    >
      <label className={css.fieldLabel} htmlFor="prism-data-target">{t('targetLabel')}</label>
      <div className={css.inputRow}>
        <input
          id="prism-data-target"
          className={css.input}
          value={target}
          placeholder={t('targetPlaceholder')}
          disabled={busy}
          onChange={(event) => { setTarget(event.target.value) }}
        />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void chooseFolder() }}>
          {t('chooseFolder')}
        </Button>
      </div>
      <p className={css.hint}>{t('targetHint')}</p>
      {pickerFailed ? <p className={css.hint} role="status">{t('pickerUnavailable')}</p> : null}
      {actionFailure === null
        ? null
        : <div className={css.error} role="alert">{actionFailure}</div>}
    </Modal>
  </>
}
