/**
 * Settings transfer: project the live settings document to the volatile
 * values the settings page shows (with secret-role fields kept or stripped),
 * and reapply such a document namespace by namespace through the
 * revision-fenced write path.
 *
 * The walks stay on the descriptor's already-projected form schema JSON, so
 * no schemastery instance is rebuilt here; `describe()` has applied the
 * volatile projection, and secret positions arrive precomputed from the same
 * walk the wire uses.
 *
 * @module @prism/prism-transfer/settings-transfer
 */

import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { TransferError } from './errors.ts'
import { parseSettingsFile, type PrismSettingsFile, type SettingsApplyOutcome } from './types.ts'

/** The settings surface the applier needs (a subset of `SettingsForms`). */
export interface SettingsTransferDeps {
  /**
   * Read active namespaces with their volatile projection.
   * @param options - redaction requested for secret-free exports.
   * @returns one descriptor per active configurable entry.
   */
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  /**
   * Merge editable fields into one entry's config.
   * @param ns - profile entry id.
   * @param patch - fields to merge.
   * @param expectedRevision - revision from `describe`.
   */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** Result of projecting the live settings document for export. */
export interface ExportedSettings {
  readonly file: PrismSettingsFile
  /** Secret-role fields that held values and were stripped. */
  readonly skippedSecrets: number
}

/**
 * Project the live settings document into an export file.
 * @param deps - the settings read/write surface.
 * @param includeSecrets - whether secret-role fields keep their real values.
 * @returns the export document and the number of stripped set secrets.
 */
export function exportSettingsFile(deps: SettingsTransferDeps, includeSecrets: boolean): ExportedSettings {
  const namespaces: Record<string, unknown> = {}
  let skippedSecrets = 0
  for (const descriptor of deps.describe({ redactSecrets: !includeSecrets })) {
    namespaces[descriptor.ns] = descriptor.value
    if (!includeSecrets) {
      skippedSecrets += (descriptor.secrets ?? []).filter(secret => secret.set).length
    }
  }
  return {
    file: {
      format: 'prism-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets,
      namespaces,
    },
    skippedSecrets,
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep the object fields of `value` the schema declares, recursing into
 * declared object children. Union branches and arrays stay whole leaves — the
 * same treatment `projectForm` gives them — so filtering only drops fields no
 * live schema declares.
 * @param schema - the descriptor's form schema JSON.
 * @param value - one imported namespace value.
 * @returns the value narrowed to currently declared volatile fields.
 */
function projectDeclaredFields(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema) || schema['type'] !== 'object' || !isRecord(value)) return value
  const declared = isRecord(schema['dict']) ? schema['dict'] : {}
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(declared)) {
    const field = value[key]
    if (field !== undefined) result[key] = projectDeclaredFields(child, field)
  }
  return result
}

/**
 * Apply one settings document namespace by namespace, never touching
 * namespaces the file does not name.
 * @param deps - the settings read/write surface.
 * @param file - validated imported settings document.
 * @returns one outcome per namespace the file carries.
 */
export async function applySettingsFile(
  deps: SettingsTransferDeps,
  file: PrismSettingsFile,
): Promise<readonly SettingsApplyOutcome[]> {
  const outcomes: SettingsApplyOutcome[] = []
  const current = new Map<string, SettingsDescriptor>(
    deps.describe().map(descriptor => [descriptor.ns, descriptor]),
  )
  for (const ns of Object.keys(file.namespaces)) {
    outcomes.push(await applyNamespace(deps, current.get(ns), ns, file.namespaces[ns]))
  }
  return outcomes
}

/** Apply one namespace with a single revision-fenced retry. */
async function applyNamespace(
  deps: SettingsTransferDeps,
  descriptor: SettingsDescriptor | undefined,
  ns: string,
  fileValue: unknown,
): Promise<SettingsApplyOutcome> {
  if (descriptor === undefined) {
    return { ns, outcome: 'skipped', reason: 'namespace is not active on this install' }
  }
  const projected = projectDeclaredFields(descriptor.schema, fileValue)
  if (!isRecord(projected) || Object.keys(projected).length === 0) {
    return { ns, outcome: 'skipped', reason: 'no field of the file is declared volatile here' }
  }
  const patch: object = projected
  try {
    await deps.update(ns, patch, descriptor.revision)
    return { ns, outcome: 'applied' }
  } catch (error: unknown) {
    if (!(error instanceof SettingsConflictError)) {
      return { ns, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  // One fenced retry against the fresh revision; a second conflict means the
  // namespace is being edited concurrently and is reported, not fought over.
  const fresh = deps.describe().find(entry => entry.ns === ns)
  if (fresh === undefined) {
    return { ns, outcome: 'skipped', reason: 'namespace stopped being active during import' }
  }
  try {
    await deps.update(ns, patch, fresh.revision)
    return { ns, outcome: 'applied' }
  } catch (error: unknown) {
    const reason = error instanceof SettingsConflictError
      ? 'settings changed again during import'
      : error instanceof Error ? error.message : String(error)
    return { ns, outcome: 'failed', reason }
  }
}

/**
 * Parse one uploaded settings document body.
 * @param text - raw JSON text.
 * @returns the validated document.
 */
export function parseSettingsText(text: string): PrismSettingsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new TransferError('settings-format', 'settings document is not valid JSON')
  }
  return parseSettingsFile(parsed)
}
