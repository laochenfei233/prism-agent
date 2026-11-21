/**
 * The backup page's state and operations. Configuration edits stage in the
 * shared settings form model and write once on save; passwords travel through
 * the credential surface and are reported only by presence; run state, phase,
 * and history come from the plugin's own POST route.
 * @module @prism/prism-backup/client/page-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFormActions, type SettingsSecretSpec,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { BACKUP_ROUTE, BACKUP_SECRET_REFS, type BackupRunRecord, type BackupSecretId } from '../types.ts'

/** Loader entry id owning the settings namespace this page edits. */
export const BACKUP_ENTRY_ID = 'prism-backup'

/** Plain configuration values the page edits. */
export interface BackupSettings {
  targetType: string
  webdavUrl: string
  s3Endpoint: string
  s3Region: string
  s3Bucket: string
  s3PathStyle: boolean
  smbPath: string
  username: string
  s3AccessKeyId: string
  remoteDir: string
  includeSettings: boolean
  includeMemory: boolean
  includeProjects: boolean
  projectExcludes: string
  maxBackups: number
}

/** Which passwords are stored; values never leave the Host. */
export type PageSecrets = Readonly<Record<BackupSecretId, boolean>>

/** Live run state, stored-password presence, and history the page renders. */
export interface BackupRunState {
  /** Whether a run is active on the Host. */
  running: boolean
  /** Live phase line while a run is active. */
  phase: string | undefined
  /** Finished runs, newest first. */
  history: readonly BackupRunRecord[]
  /** Which passwords are stored. */
  secrets: PageSecrets
  /** Whether the connection test is in flight. */
  testing: boolean
  /** Sentence describing the last action's outcome; a dictionary key or a Host message. */
  notice: { tone: 'ok' | 'error'; text: string } | undefined
}

/** Write-only password field names the section renders, and the secret each one writes. */
export const SECRET_FIELDS: readonly { readonly field: keyof BackupSecretTexts; readonly id: BackupSecretId }[] = [
  { field: 'webdavPassword', id: 'webdav-password' },
  { field: 'smbPassword', id: 'smb-password' },
  { field: 's3SecretKey', id: 's3-secret-key' },
]

/** The write-only controls' staged drafts. */
export interface BackupSecretTexts {
  readonly webdavPassword: string
  readonly smbPassword: string
  readonly s3SecretKey: string
}

/** One field's staged draft. */
export interface BackupFieldDraft {
  readonly text: string
  readonly overridden: boolean
  readonly invalid: boolean
}

/** Staged configuration plus the shell state the form frame renders. */
export interface BackupFormState {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
  /** Every section field's staged draft. */
  readonly fields: Readonly<Record<keyof BackupSettings, BackupFieldDraft>>
  /** Every write-only password control's staged text. */
  readonly secretText: Readonly<BackupSecretTexts>
}

/** The registration-side face the section's slot entry injects. */
export interface BackupSectionFace extends SettingsFormActions {
  hooks: {
    /** Staged configuration form bound by the renderer as useBackupForm. */
    backupForm: SnapshotStore<BackupFormState>
    /** Run state and history bound by the renderer as useBackupRun. */
    backupRun: SnapshotStore<BackupRunState>
  }
  /** Probe the active target. */
  test: () => void
  /** Start a run and follow it. */
  run: () => void
  /** Remove the stored password behind one write-only control. */
  clearSecret: (id: BackupSecretId) => void
}

/** The section fields this page edits, in render order. */
const FIELD_NAMES: readonly (keyof BackupSettings)[] = [
  'targetType', 'webdavUrl', 's3Endpoint', 's3Region', 's3Bucket', 's3PathStyle', 'smbPath',
  'username', 's3AccessKeyId', 'remoteDir', 'includeSettings', 'includeMemory', 'includeProjects',
  'projectExcludes', 'maxBackups',
]

/** Boolean fields staged as their two text spellings, so a toggle rides the same save. */
const BOOLEAN_FIELDS = new Set<string>(['s3PathStyle', 'includeSettings', 'includeMemory', 'includeProjects'])

/** Cells the page follows: its staged form plus its own run store. */
export interface BackupSectionInjected {
  readonly face: BackupSectionFace
}

/**
 * A boolean field staged as its two text spellings.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
  }
}

/** One route answer: a decoded value, a Host sentence, or the page's own fallback key. */
type RouteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }
  | { readonly ok: false; readonly key: 'unreachable' }

/**
 * The sentence or dictionary key one refused answer carries.
 * @param answer - a refused answer.
 * @returns the Host's sentence, or the dictionary key the page translates.
 */
function refusalText(answer: Extract<RouteAnswer<never>, { ok: false }>): string {
  return 'message' in answer ? answer.message : answer.key
}

/**
 * Read one JSON envelope from the plugin route.
 * @param body - the action to send.
 * @param decode - narrows the answer's value, or returns undefined for a shape this client does not trust.
 * @returns the decoded value, or the sentence describing the refusal.
 */
async function callRoute<T>(
  body: unknown,
  decode: (value: unknown) => T | undefined,
): Promise<RouteAnswer<T>> {
  let response: Response
  try {
    response = await fetch(BACKUP_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const parsed = await response.json().catch(() => undefined) as
    | { readonly ok?: unknown; readonly value?: unknown; readonly error?: { readonly message?: unknown } }
    | undefined
  if (parsed?.ok === true) {
    const decoded = decode(parsed.value)
    if (decoded === undefined) return { ok: false, key: 'unreachable' }
    return { ok: true, value: decoded }
  }
  const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined
  return { ok: false, ...message === undefined ? { key: 'unreachable' as const } : { message } }
}

/**
 * Narrow one `state` answer.
 * @param value - untrusted answer value.
 * @returns the state, or undefined for a shape this client does not trust.
 */
function decodeState(value: unknown): StateAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { running?: unknown; phase?: unknown; history?: unknown }
  if (typeof candidate.running !== 'boolean' || !Array.isArray(candidate.history)) return undefined
  const phase = typeof candidate.phase === 'object' && candidate.phase !== null
    ? (candidate.phase as { detail?: unknown }).detail
    : undefined
  return {
    running: candidate.running,
    ...typeof phase === 'string' ? { phase: { detail: phase } } : {},
    history: candidate.history.flatMap(decodeRecord),
  }
}

/** The failure codes one history record may carry. */
const BACKUP_ERROR_CODES: readonly NonNullable<BackupRunRecord['failure']>['code'][] = [
  'prism-backup/bad-request',
  'prism-backup/not-configured',
  'prism-backup/busy',
  'prism-backup/connection-failed',
  'prism-backup/auth-failed',
  'prism-backup/upload-failed',
  'prism-backup/collect-failed',
  'prism-backup/failed',
]

/**
 * Whether a wire value names one of the feature's failure codes.
 * @param value - untrusted value.
 * @returns true when the value is a known code.
 */
function isBackupErrorCode(value: unknown): value is NonNullable<BackupRunRecord['failure']>['code'] {
  return typeof value === 'string' && (BACKUP_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Narrow one history record; the page renders only the fields it can trust.
 * @param value - untrusted record value.
 * @returns the record, or an empty list for a shape this client does not trust.
 */
function decodeRecord(value: unknown): readonly BackupRunRecord[] {
  if (typeof value !== 'object' || value === null) return []
  const candidate = value as Record<string, unknown>
  const counts = candidate.counts
  const failure = candidate.failure
  if (typeof candidate.id !== 'string' || typeof candidate.startedAt !== 'number'
    || typeof candidate.finishedAt !== 'number'
    || (candidate.status !== 'success' && candidate.status !== 'failed')
    || (candidate.targetType !== 'webdav' && candidate.targetType !== 's3' && candidate.targetType !== 'smb')
    || typeof candidate.endpoint !== 'string'
    || typeof counts !== 'object' || counts === null) {
    return []
  }
  const count = (field: string): number => {
    const raw = (counts as Record<string, unknown>)[field]
    return typeof raw === 'number' ? raw : 0
  }
  return [{
    id: candidate.id,
    startedAt: candidate.startedAt,
    finishedAt: candidate.finishedAt,
    status: candidate.status,
    targetType: candidate.targetType,
    endpoint: candidate.endpoint,
    ...typeof candidate.archiveName === 'string' ? { archiveName: candidate.archiveName } : {},
    ...typeof candidate.sizeBytes === 'number' ? { sizeBytes: candidate.sizeBytes } : {},
    counts: {
      settings: count('settings'),
      memoryFiles: count('memoryFiles'),
      projects: count('projects'),
      projectFiles: count('projectFiles'),
    },
    ...typeof failure === 'object' && failure !== null
      && isBackupErrorCode((failure as Record<string, unknown>).code)
      && typeof (failure as Record<string, unknown>).message === 'string'
      ? { failure: { code: (failure as { code: NonNullable<BackupRunRecord['failure']>['code'] }).code, message: (failure as { message: string }).message } }
      : {},
  }]
}

/**
 * Narrow one `run` answer; the page only needs to know one arrived.
 * @param value - untrusted answer value.
 * @returns a marker for a well-shaped answer.
 */
function decodeRun(value: unknown): true | undefined {
  return typeof value === 'object' && value !== null ? true : undefined
}

/**
 * Narrow one `test` answer.
 * @param value - untrusted answer value.
 * @returns the sentence, or undefined for a shape this client does not trust.
 */
function decodeTest(value: unknown): { message: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' ? { message } : undefined
}

/** One `state` answer as the Host sends it. */
interface StateAnswer {
  readonly running: boolean
  readonly phase?: { readonly detail: string }
  readonly history: readonly BackupRunRecord[]
}

/**
 * Own the page's stores, the staged form, and the Host calls.
 * @param ctx - the page plugin's context, declaring the Remote namespaces it drives.
 * @param scope - the shared configuration form of the `prism-backup` entry.
 * @returns the face the section's slot entry injects.
 */
export function createBackupSection(ctx: Context, scope: ConfigForm<BackupSettings>): BackupSectionFace {
  const runStore = createSnapshotStore<BackupRunState>({
    running: false,
    phase: undefined,
    history: [],
    secrets: { 'webdav-password': false, 'smb-password': false, 's3-secret-key': false },
    testing: false,
    notice: undefined,
  })

  const refreshSecrets = async (): Promise<void> => {
    const refs = SECRET_FIELDS.map(entry => BACKUP_SECRET_REFS[entry.id])
    const described = await ctx.remote.credentials.describe(refs)
    const next: Record<BackupSecretId, boolean> = { 'webdav-password': false, 'smb-password': false, 's3-secret-key': false }
    if (described.ok) {
      for (const entry of SECRET_FIELDS) {
        next[entry.id] = described.value[BACKUP_SECRET_REFS[entry.id]]?.configured === true
      }
    }
    runStore.update((draft) => { draft.secrets = next })
  }

  const secretSpecs: SettingsSecretSpec[] = SECRET_FIELDS.map(entry => ({
    field: entry.field,
    write: async (text: string) => {
      const response = await ctx.remote.credentials.set(BACKUP_SECRET_REFS[entry.id], text)
      if (!response.ok) return false
      await refreshSecrets()
      return true
    },
  }))
  const specs: SettingsFieldSpec[] = FIELD_NAMES.map(field => field === 'maxBackups'
    ? settingsNumberField(field)
    : BOOLEAN_FIELDS.has(field) ? settingsBooleanField(field) : settingsTextField(field))
  const form = new SettingsFormModel(scope, specs, secretSpecs)
  const formStore = form.bind((): BackupFormState => {
    const fields = {} as Record<keyof BackupSettings, BackupFieldDraft>
    for (const field of FIELD_NAMES) fields[field] = form.field(field)
    const secretText = {} as Record<keyof BackupSecretTexts, string>
    for (const entry of SECRET_FIELDS) secretText[entry.field] = form.field(entry.field).text
    return { ...form.shell(), fields, secretText }
  })

  let poll: ReturnType<typeof setInterval> | undefined
  let disposed = false
  const stopPolling = (): void => {
    if (poll === undefined) return
    clearInterval(poll)
    poll = undefined
  }
  const startPolling = (): void => {
    if (disposed || poll !== undefined) return
    poll = setInterval(() => { void refreshRunState() }, 1000)
  }
  const refreshRunState = async (): Promise<void> => {
    const answer = await callRoute({ action: 'state' }, decodeState)
    // A page that unloaded must not restart a timer from an in-flight answer.
    if (disposed || !answer.ok) return
    runStore.update((draft) => {
      draft.running = answer.value.running
      draft.phase = answer.value.phase?.detail
      draft.history = answer.value.history
    })
    // A page opened while a run is already active has to follow it too.
    if (answer.value.running) startPolling()
    else stopPolling()
  }

  const test = (): void => {
    runStore.update((draft) => { draft.testing = true; draft.notice = undefined })
    void callRoute({ action: 'test' }, decodeTest).then((answer) => {
      runStore.update((draft) => {
        draft.testing = false
        draft.notice = answer.ok
          ? { tone: 'ok', text: answer.value.message }
          : { tone: 'error', text: refusalText(answer) }
      })
    })
  }

  const run = (): void => {
    runStore.update((draft) => { draft.running = true; draft.phase = undefined; draft.notice = undefined })
    startPolling()
    void callRoute({ action: 'run' }, decodeRun)
      .then((answer) => {
        runStore.update((draft) => {
          draft.notice = answer.ok
            ? { tone: 'ok', text: 'runOk' }
            : { tone: 'error', text: refusalText(answer) }
        })
      })
      .finally(() => {
        // This page's run attempt is over, accepted or refused: stop here even
        // when the follow-up read fails, so an unreachable Host cannot leave
        // the page polling.
        stopPolling()
        runStore.update((draft) => { draft.running = false; draft.phase = undefined })
        void refreshRunState()
      })
  }

  const clearSecret = (id: BackupSecretId): void => {
    void ctx.remote.credentials.unset(BACKUP_SECRET_REFS[id]).then(async (response) => {
      if (!response.ok) {
        runStore.update((draft) => { draft.notice = { tone: 'error', text: response.error.message } })
        return
      }
      await refreshSecrets()
    })
  }

  void refreshSecrets()
  void refreshRunState()
  ctx.effect(() => () => {
    disposed = true
    stopPolling()
    form.dispose()
  }, 'prism-backup: page form')

  return {
    ...form.actions(),
    hooks: { backupForm: formStore, backupRun: runStore },
    test,
    run,
    clearSecret,
  }
}
