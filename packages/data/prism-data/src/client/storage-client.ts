/**
 * Browser calls behind the storage tab. Every response is validated here, so
 * the page renders only the fields this module proves.
 *
 * @module @prism/prism-data/client/storage-client
 */

import { DATA_ROUTE_PATH } from '../routes.ts'
import type { DataRequest, DataLocationState, RelocationResult } from '../types.ts'
import type { DataLocaleKey } from './locales.ts'

/** Bound translator of this page's dictionary. */
type Translate = (key: DataLocaleKey, params?: Record<string, unknown>) => string

/** One refused call: the Host's typed code plus its sentence. */
export class DataCallError extends Error {
  /**
   * @param code - machine code the Host answered with, or a transport code.
   * @param message - the Host's sentence, or the localized transport sentence.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DataCallError'
  }
}

/**
 * Read one JSON object from an untrusted response.
 * @param value - parsed body.
 * @returns its entries, or undefined for a non-object.
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

/**
 * Read the location snapshot from an untrusted value.
 * @param value - parsed body.
 * @returns the snapshot, or undefined when a required field is missing.
 */
function locationOf(value: unknown): DataLocationState | undefined {
  const record = recordOf(value)
  const root = record?.['root']
  const pointerPath = record?.['pointerPath']
  if (typeof root !== 'string' || typeof pointerPath !== 'string') return undefined
  const storedRoot = record?.['storedRoot']
  const pendingRoot = record?.['pendingRoot']
  return {
    root,
    pointerPath,
    ...typeof storedRoot === 'string' ? { storedRoot } : {},
    ...typeof pendingRoot === 'string' ? { pendingRoot } : {},
  }
}

/**
 * Read one relocation result from an untrusted value.
 * @param value - parsed body.
 * @returns the result, or undefined when a required field is missing.
 */
function resultOf(value: unknown): RelocationResult | undefined {
  const record = recordOf(value)
  const target = record?.['target']
  const previousRoot = record?.['previousRoot']
  const files = record?.['files']
  const bytes = record?.['bytes']
  if (typeof target !== 'string' || typeof previousRoot !== 'string') return undefined
  if (typeof files !== 'number' || typeof bytes !== 'number') return undefined
  const links = record?.['skippedLinks']
  return {
    target,
    previousRoot,
    files,
    bytes,
    skippedLinks: Array.isArray(links) ? links.filter((link): link is string => typeof link === 'string') : [],
  }
}

/**
 * Read the failure envelope of one response.
 * @param value - parsed body.
 * @returns the code and sentence, or undefined when the body is not a failure.
 */
function failureOf(value: unknown): { readonly code: string; readonly message: string } | undefined {
  const error = recordOf(recordOf(value)?.['error'])
  const code = error?.['code']
  const message = error?.['message']
  if (typeof code !== 'string' || typeof message !== 'string') return undefined
  return { code, message }
}

/**
 * Post one action and validate its result.
 * @param body - action payload.
 * @param guard - validator for the successful value.
 * @param t - bound translator for transport failures.
 * @returns the validated value.
 * @throws {DataCallError} for a refused call or an unrecognized response.
 */
async function call<T>(
  body: DataRequest,
  guard: (value: unknown) => T | undefined,
  t: Translate,
): Promise<T> {
  const response = await fetch(DATA_ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const failure = failureOf(parsed)
    throw failure === undefined
      ? new DataCallError('request-failed', t('requestFailed', { status: String(response.status) }))
      : new DataCallError(failure.code, failure.message)
  }
  const value = guard(recordOf(parsed)?.['value'])
  if (value === undefined) throw new DataCallError('unexpected-response', t('unexpectedResponse'))
  return value
}

/**
 * Read where the data currently lives and what the next launch would use.
 * @param t - bound translator for transport failures.
 * @returns the location snapshot.
 */
export function requestState(t: Translate): Promise<DataLocationState> {
  return call({ action: 'state' }, locationOf, t)
}

/**
 * Copy the current data directory to `target` and record it for the next launch.
 * @param target - absolute destination directory.
 * @param t - bound translator for transport failures.
 * @returns the copy counts and the destination.
 */
export function requestRelocate(target: string, t: Translate): Promise<RelocationResult> {
  return call({ action: 'relocate', target }, resultOf, t)
}

/**
 * Drop the recorded location so the next launch uses the default directory.
 * @param t - bound translator for transport failures.
 * @returns the location snapshot after the reset.
 */
export function requestReset(t: Translate): Promise<DataLocationState> {
  return call({ action: 'reset' }, locationOf, t)
}
