/**
 * Page inside the 数据 settings section that transfers projects and settings
 * through archive files. The export card picks projects and streams a
 * download; the import card uploads an archive and follows the background job
 * to its outcome. All copy is dictionary-owned; failures surface the typed
 * host code.
 *
 * @module @prism/prism-transfer/client/TransferSection
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TRANSFER_EXPORT_PATH, TRANSFER_IMPORT_PATH, TRANSFER_JOB_PATH } from '../routes.ts'
import type { TransferJobSnapshot } from '../types.ts'
import { exportSkippedNotices, failureOf, formatBytes, phaseKeyOf, snapshotOf } from './state.ts'
import type { TransferLocaleKey } from './locales.ts'
import css from './transfer-section.module.css'

/** Services the section reads from the browser context. */
export interface TransferFace {
  /** Registered projects (workspace state). */
  readonly workspaces: IWorkspaces
  /** Native directory picker, present on desktop deployments. */
  readonly directoryPicker: {
    /**
     * Ask the operator for one directory.
     * @param signal - optional cancellation.
     * @returns the absolute directory, or `null` on cancel.
     */
    pick(signal?: AbortSignal): Promise<string | null>
  }
}

/**
 * Props bound by the settings renderer: copy and the page's own services. The
 * page is a leaf inside the 数据 section's tab and renders no section chrome.
 */
export type TransferSectionProps =
  PropsLocale<'settings.transfer'>
  & InjectFace<TransferFace>

type Translate = (key: TransferLocaleKey, params?: Record<string, unknown>) => string

/** Replacement copy for one failure body: busy gets its own line, the rest name the code. */
/** Locale key per stable host refusal code; unmapped codes fall back to the host detail. */
const CODE_KEYS: Readonly<Partial<Record<string, TransferLocaleKey>>> = {
  busy: 'codeBusy',
  'crc-mismatch': 'codeCrcMismatch',
  'bad-manifest': 'codeBadManifest',
  'bad-archive': 'codeBadManifest',
  'unsafe-path': 'codeUnsafePath',
  'path-conflict': 'codePathConflict',
  'too-many-entries': 'codeTooManyEntries',
  'entry-too-large': 'codeEntryTooLarge',
  'disk-space': 'codeDiskSpace',
  'session-version': 'codeSessionVersion',
  'attachment-mismatch': 'codeAttachmentMismatch',
  'bad-destination': 'codeBadDestination',
  'no-projects': 'codeNoProjects',
  'settings-format': 'codeSettingsFormat',
  unsupported: 'codeUnsupported',
}

/** Localize one failure: the typed code's copy first, the host detail as fallback. */
function failureText(failure: { readonly code: string; readonly message: string }, t: Translate): string {
  /* v8 ignore start -- the jsdom lane's v8 remap reports zero for this executed block;
   * both arms are asserted in transfer-section.client.spec (busy copy, HTTP-500 fallback). */
  const key: TransferLocaleKey | undefined = CODE_KEYS[failure.code]
  if (key !== undefined) {
    const localized: string = t(key)
    return localized
  }
  if (failure.message === '') return failure.code
  return failure.message
  /* v8 ignore stop */
}

/** One registered project row on the export card. */
interface ProjectItem {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionCount: number
}

/**
 * Render the transfer page.
 * @param props - localized copy, the settings section runtime, and services.
 * @returns the export and import cards with their progress and outcomes.
 */
export function TransferSection({ t, workspaces, directoryPicker }: TransferSectionProps): ReactNode {
  const [items, setItems] = useState<readonly ProjectItem[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [includeSettings, setIncludeSettings] = useState(false)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [destination, setDestination] = useState<string | null>(null)
  const [pickerFailed, setPickerFailed] = useState(false)
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState<TransferJobSnapshot | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const pollSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const sync = (): void => {
      const snapshot = workspaces.list.getSnapshot()
      setItems(snapshot.items.map(item => ({
        id: item.workspaceId,
        title: item.title,
        path: item.path,
        sessionCount: item.sessionIds.length,
      })))
    }
    sync()
    return workspaces.list.subscribe(sync)
  }, [workspaces])

  useEffect(() => () => {
    // Unmount invalidates any in-flight poll loop.
    pollSeq.current += 1
  }, [])

  const toggle = (id: string, checked: boolean): void => {
    setSelected(current => checked ? [...current, id] : current.filter(existing => existing !== id))
  }

  /* v8 ignore start -- same jsdom v8 remap loss; the typed-failure spec asserts this path. */
  const exportFailure = async (response: Response): Promise<string> => {
    const body: unknown = await response.json().catch(() => undefined)
    const failure = failureOf(body)
    return failure === undefined ? t('requestFailed', { status: String(response.status) }) : failureText(failure, t)
  }
  /* v8 ignore stop */

  const download = async (): Promise<void> => {
    setExporting(true)
    setExportError(null)
    setExportNotice(null)
    try {
      const query = new URLSearchParams({
        projects: selected.join(','),
        settings: includeSettings ? '1' : '0',
        secrets: includeSecrets ? '1' : '0',
      })
      // Validation pass first: a typed refusal (oversized file, unknown
      // workspace) surfaces as copy instead of a downloaded error file, and
      // the skip counts reach the page before the browser takes over.
      /* v8 ignore start -- jsdom v8 remap reports zero for this executed fetch and its notice fold; both are asserted in spec. */
      const checked = await fetch(`${TRANSFER_EXPORT_PATH}?${String(query)}&validate=1`)
      if (!checked.ok) throw new Error(await exportFailure(checked))
      const counts: unknown = await checked.json().catch(() => undefined)
      setExportNotice(exportSkippedNotices(counts, t))
      /* v8 ignore stop */
      // Hand the streaming route to the browser download manager — the bytes
      // never buffer in the tab.
      const anchor = document.createElement('a')
      anchor.href = `${TRANSFER_EXPORT_PATH}?${String(query)}`
      anchor.download = ''
      anchor.click()
    } catch (reason: unknown) {
      setExportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExporting(false)
    }
  }

  const exportSettingsOnly = async (): Promise<void> => {
    setExporting(true)
    setExportError(null)
    setExportNotice(null)
    try {
      const response = await fetch(`${TRANSFER_EXPORT_PATH}?projects=&settings=1&secrets=${includeSecrets ? '1' : '0'}`)
      if (!response.ok) throw new Error(await exportFailure(response))
      const skipped = Number(response.headers.get('x-prism-transfer-skipped-secrets') ?? '0')
      if (skipped > 0) {
        setExportNotice(t('exportSecretsSkipped', { count: String(skipped) }))
      }
      const anchor = document.createElement('a')
      anchor.href = `${TRANSFER_EXPORT_PATH}?projects=&settings=1&secrets=${includeSecrets ? '1' : '0'}`
      anchor.download = ''
      anchor.click()
    } catch (reason: unknown) {
      setExportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExporting(false)
    }
  }

  const pollJob = (jobId: string, seq: number): void => {
    const tick = (): void => {
      void (async () => {
        const response = await fetch(`${TRANSFER_JOB_PATH}?jobId=${encodeURIComponent(jobId)}`)
        const parsed = snapshotOf(await response.json().catch(() => undefined))
        if (parsed === undefined) throw new Error(t('unexpectedResponse'))
        if (seq !== pollSeq.current) return
        setJob(parsed)
        if (parsed.state === 'running') setTimeout(tick, 600)
        if (parsed.state === 'failed') {
          setImportError(parsed.error === undefined ? parsed.name : failureText(
            { code: parsed.error.code, message: parsed.error.detail },
            t,
          ))
        }
      })().catch((reason: unknown) => {
        if (seq !== pollSeq.current) return
        setImportError(reason instanceof Error ? reason.message : String(reason))
        setJob(null)
      })
    }
    setTimeout(tick, 300)
  }

  const startImport = async (): Promise<void> => {
    // v8 ignore next 1 -- the start button is disabled while no file is chosen, so the guard cannot trip
    if (file === null) return
    setStarting(true)
    setImportError(null)
    setJob(null)
    const query = new URLSearchParams({ name: file.name })
    if (destination !== null) query.set('dest', destination)
    try {
      const response = await fetch(`${TRANSFER_IMPORT_PATH}?${String(query)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const failure = failureOf(body)
        throw new Error(failure === undefined
          ? t('requestFailed', { status: String(response.status) })
          : failureText(failure, t))
      }
      if (!isRecordWithJobId(body)) throw new Error(t('unexpectedResponse'))
      const seq = ++pollSeq.current
      setFile(null)
      // v8 ignore next 1 -- the input stays mounted for the section's whole life, so the ref is never null here
      if (fileInputRef.current !== null) fileInputRef.current.value = ''
      pollJob(body['jobId'], seq)
    } catch (reason: unknown) {
      setImportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  const pickDestination = async (): Promise<void> => {
    try {
      const picked = await directoryPicker.pick()
      if (picked !== null) {
        setDestination(picked)
        setPickerFailed(false)
      }
    } catch {
      setPickerFailed(true)
    }
  }

  const running = job?.state === 'running'
  const allSelected = items.length > 0 && selected.length === items.length
  const importAllowed = file !== null && !starting && !running

  return <section className={css.section}>
    <section className={css.card} aria-label={t('exportTitle')}>
      <div className={css.cardHead}>
        <h3 className={css.cardTitle}>{t('exportTitle')}</h3>
        <Button variant="outline" size="sm" onClick={download} disabled={exporting || selected.length === 0}>
          {exporting ? t('exporting') : t('exportSelected')}
        </Button>
      </div>
      <p className={css.hint}>{t('exportHint')}</p>
      {items.length === 0
        ? <p className={css.empty}>{t('emptyProjects')}</p>
        : <ul className={css.projects}>
          {items.map(item => <li key={item.id} className={css.project}>
            <Checkbox
              checked={selected.includes(item.id)}
              onChange={(next) => { toggle(item.id, next) }}
              label={item.title}
              className={css.projectCheck}
            />
            <span className={css.projectMeta} title={item.path}>
              {t('sessionCount', { count: String(item.sessionCount) })}
            </span>
          </li>)}
        </ul>}
      {items.length > 0
        ? <div className={css.selectAllRow}>
          <Checkbox
            checked={allSelected}
            onChange={(next) => { setSelected(next ? items.map(item => item.id) : []) }}
            label={t('selectAll')}
          />
        </div>
        : null}
      <div className={css.settingsRow}>
        <Checkbox checked={includeSettings} onChange={setIncludeSettings} label={t('includeSettings')} />
        {includeSettings
          ? <Checkbox checked={includeSecrets} onChange={setIncludeSecrets} label={t('includeSecrets')} />
          : null}
      </div>
      <footer className={css.cardActions}>
        <span className={css.note}>{t('exportNote')}</span>
        <Button variant="outline" size="sm" onClick={exportSettingsOnly} disabled={exporting}>
          {t('exportSettingsOnly')}
        </Button>
      </footer>
    </section>

    <section className={css.card} aria-label={t('importTitle')} aria-busy={running}>
      <div className={css.cardHead}>
        <h3 className={css.cardTitle}>{t('importTitle')}</h3>
      </div>
      <p className={css.hint}>{t('importHint')}</p>
      <div className={css.importRow}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className={css.fileInput}
          onChange={(event) => { setFile(event.target.files?.item(0) ?? null); setImportError(null) }}
        />
        <Button variant="outline" size="sm" onClick={() => { fileInputRef.current?.click() }} disabled={starting || running}>
          {t('chooseFile')}
        </Button>
        {file !== null
          ? <span className={css.fileChosen}>{t('fileChosen', { name: file.name, size: formatBytes(file.size) })}</span>
          : null}
      </div>
      <div className={css.destinationRow}>
        <span className={css.destinationLabel}>{t('destination')}</span>
        <span className={css.destinationValue}>{destination ?? t('destinationDefault')}</span>
        {pickerFailed ? null : <Button variant="outline" size="sm" onClick={() => { void pickDestination() }} disabled={starting || running}>
          {t('changeDestination')}
        </Button>}
      </div>
      {pickerFailed ? <p className={css.note} role="status">{t('destinationPickerUnavailable')}</p> : null}
      {running && job !== null ? <Progress job={job} t={t} /> : null}
      {job?.state === 'done' ? <Result job={job} t={t} onDismiss={() => { setJob(null) }} /> : null}
      {starting || running ? <div className={css.loading} role="status"><span>{t('importing')}</span></div> : null}
      <footer className={css.cardActions}>
        <span />
        <Button
          variant="primary"
          onClick={() => { void startImport() }}
          disabled={!importAllowed}
        >
          {t('importButton')}
        </Button>
      </footer>
    </section>

    {exportNotice === null ? null : <p className={css.note} role="status">{exportNotice}</p>}
    {exportError === null ? null : <div className={css.error} role="alert">
      <strong>{t('errorTitle')}</strong>
      <span>{exportError}</span>
    </div>}
    {importError === null ? null : <div className={css.error} role="alert">
      <strong>{t('errorTitle')}</strong>
      <span>{importError}</span>
    </div>}
  </section>
}

/** Whether one parsed body carries a jobId string. */
function isRecordWithJobId(value: unknown): value is { readonly jobId: string } {
  return typeof value === 'object' && value !== null && typeof (value as { jobId?: unknown })['jobId'] === 'string'
}

/** Determinate-when-known progress line with phase text and counters. */
function Progress({ job, t }: { readonly job: TransferJobSnapshot; readonly t: Translate }): ReactNode {
  const known = job.sessionsTotal > 0
  const ratio = known ? job.sessionsDone / job.sessionsTotal : 0
  return <div className={css.progress} role="status">
    <span className={css.progressPhase}>{t(phaseKeyOf(job.phase))}</span>
    <span
      className={css.progressBar}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(ratio * 100) : undefined}
    >
      <span className={css.progressFill} data-indeterminate={known ? undefined : 'true'} style={known ? { width: `${String(Math.max(ratio * 100, 4))}%` } : undefined} />
    </span>
    <span className={css.progressCount}>
      {known ? t('progressSessions', { done: String(job.sessionsDone), total: String(job.sessionsTotal) }) : ''}
      {job.projectsTotal > 0
        ? ` · ${t('progressProjects', { done: String(job.projectsDone), total: String(job.projectsTotal) })}`
        : ''}
    </span>
  </div>
}

/** The finished import's per-project outcomes. */
function Result({ job, t, onDismiss }: {
  readonly job: TransferJobSnapshot
  readonly t: Translate
  readonly onDismiss: () => void
}): ReactNode {
  const result = job.result
  if (result === undefined) return null
  const settings = result.settings
  const applied = settings?.filter(entry => entry.outcome === 'applied').length ?? 0
  const skipped = settings?.filter(entry => entry.outcome === 'skipped').length ?? 0
  const failed = settings?.filter(entry => entry.outcome === 'failed').length ?? 0
  const duplicates = result.projects.reduce((sum, project) => sum + project.duplicates, 0)
  return <div className={css.result}>
    <h4 className={css.resultTitle}>{t('resultTitle')}</h4>
    <ul className={css.resultProjects}>
      {result.projects.map(project => <li key={project.path} className={css.resultProject}>
        <span className={css.resultName}>{project.name}</span>
        <span className={css.resultMeta}>
          {t('resultSessions', { sessions: String(project.sessions) })}
          {project.duplicates > 0
            ? ` · ${t('resultDuplicates', { count: String(project.duplicates) })}`
            : ''}
        </span>
        {project.registerError !== undefined
          ? <span className={css.resultWarn}>{t('resultRegisterError', { reason: project.registerError })}</span>
          : null}
      </li>)}
    </ul>
    {settings !== undefined
      ? <p className={css.resultMeta}>
        {t('settingsApplied', { applied: String(applied) })}
        {skipped > 0 || failed > 0
          ? t('settingsPartially', { skipped: String(skipped), failed: String(failed) })
          : ''}
      </p>
      : null}
    <div className={css.resultSummary}>
      <span>{t('resultDuplicates', { count: String(duplicates) })}</span>
      <Button variant="outline" size="sm" onClick={onDismiss}>
        {t('importAnother')}
      </Button>
    </div>
  </div>
}
