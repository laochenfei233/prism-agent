/**
 * Pure helpers for the transfer settings page: snapshot parsing, phase copy
 * keys, failure mapping, and display formatting.
 *
 * @module @prism/prism-transfer/client/state
 */

import type { ImportedProjectResult, SettingsApplyOutcome, TransferJobSnapshot } from '../types.ts'

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one poll response into a snapshot, refusing foreign shapes. */
export function snapshotOf(value: unknown): TransferJobSnapshot | undefined {
  if (!isRecord(value) || typeof value['jobId'] !== 'string') return undefined
  if (value['state'] === 'idle') return undefined
  const state = value['state']
  if (state !== 'running' && state !== 'done' && state !== 'failed') return undefined
  const kind = value['kind']
  const phase = value['phase']
  return {
    jobId: value['jobId'],
    kind: kind === 'project' || kind === 'combined' ? kind : 'unknown',
    state,
    phase: phase === 'extracting' || phase === 'restoring' || phase === 'applying-settings'
      || phase === 'registering' || phase === 'done' ? phase : 'validating',
    name: typeof value['name'] === 'string' ? value['name'] : '',
    archiveBytes: typeof value['archiveBytes'] === 'number' ? value['archiveBytes'] : 0,
    files: typeof value['files'] === 'number' ? value['files'] : 0,
    bytes: typeof value['bytes'] === 'number' ? value['bytes'] : 0,
    sessionsDone: typeof value['sessionsDone'] === 'number' ? value['sessionsDone'] : 0,
    sessionsTotal: typeof value['sessionsTotal'] === 'number' ? value['sessionsTotal'] : 0,
    projectsDone: typeof value['projectsDone'] === 'number' ? value['projectsDone'] : 0,
    projectsTotal: typeof value['projectsTotal'] === 'number' ? value['projectsTotal'] : 0,
    duplicates: typeof value['duplicates'] === 'number' ? value['duplicates'] : 0,
    skippedLinks: typeof value['skippedLinks'] === 'number' ? value['skippedLinks'] : 0,
    skippedUnreadable: typeof value['skippedUnreadable'] === 'number' ? value['skippedUnreadable'] : 0,
    skippedSecrets: typeof value['skippedSecrets'] === 'number' ? value['skippedSecrets'] : 0,
    ...resultOf(value),
    ...errorOf(value),
    startedAt: typeof value['startedAt'] === 'number' ? value['startedAt'] : 0,
    ...(typeof value['finishedAt'] === 'number' ? { finishedAt: value['finishedAt'] } : {}),
  }
}

/** Parse the optional result block into a spreadable partial. */
function resultOf(value: Record<string, unknown>): { readonly result?: NonNullable<TransferJobSnapshot['result']> } {
  const raw = value['result']
  if (!isRecord(raw) || !Array.isArray(raw['projects'])) return {}
  const projects = raw['projects'].flatMap((entry: unknown): ImportedProjectResult[] => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['path'] !== 'string') return []
    return [{
      name: entry['name'],
      path: entry['path'],
      sessions: typeof entry['sessions'] === 'number' ? entry['sessions'] : 0,
      duplicates: typeof entry['duplicates'] === 'number' ? entry['duplicates'] : 0,
      ...(typeof entry['registerError'] === 'string' ? { registerError: entry['registerError'] } : {}),
    }]
  })
  const settings = Array.isArray(raw['settings'])
    ? raw['settings'].flatMap((entry: unknown): SettingsApplyOutcome[] => {
      if (!isRecord(entry) || typeof entry['ns'] !== 'string') return []
      const outcome = entry['outcome']
      if (outcome !== 'applied' && outcome !== 'skipped' && outcome !== 'failed') return []
      return [{
        ns: entry['ns'],
        outcome,
        ...(typeof entry['reason'] === 'string' ? { reason: entry['reason'] } : {}),
      }]
    })
    : undefined
  return {
    result: {
      projects,
      ...(settings !== undefined ? { settings } : {}),
    },
  }
}

/** Parse the optional error block into a spreadable partial. */
function errorOf(value: Record<string, unknown>): { readonly error?: NonNullable<TransferJobSnapshot['error']> } {
  const raw = value['error']
  if (!isRecord(raw) || typeof raw['code'] !== 'string') return {}
  return {
    error: {
      code: raw['code'],
      detail: typeof raw['detail'] === 'string' ? raw['detail'] : '',
    },
  }
}

/** Locale key for one job phase. */
export function phaseKeyOf(phase: TransferJobSnapshot['phase']): 'phaseValidating' | 'phaseExtracting' | 'phaseRestoring' | 'phaseApplyingSettings' | 'phaseRegistering' {
  if (phase === 'extracting') return 'phaseExtracting'
  if (phase === 'restoring') return 'phaseRestoring'
  if (phase === 'applying-settings') return 'phaseApplyingSettings'
  if (phase === 'registering') return 'phaseRegistering'
  return 'phaseValidating'
}

/** Read `{code, message}` from a failure body. */
export function failureOf(body: unknown): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(body)) return undefined
  if (typeof body['code'] !== 'string') return undefined
  return {
    code: body['code'],
    message: typeof body['message'] === 'string' ? body['message'] : '',
  }
}

/** Human byte size for the chosen-file line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`
}
