/**
 * Browser-side callers for the `/api/local-models` routes. Same-origin fetch
 * through the authenticated `/api` carrier, mirroring `prism-pocket`.
 *
 * @module @prism/prism-local-models/client/api
 */

import { LOCAL_MODELS_CANCEL_PATH, LOCAL_MODELS_CATALOG_PATH, LOCAL_MODELS_INSTALL_PATH, LOCAL_MODELS_PROBE_PATH, LOCAL_MODELS_REMOVE_PATH, LOCAL_MODELS_STATUS_PATH } from '../routes.ts'
import type { CatalogView, ProbeOutcome, StatusView } from '../types.ts'

/** Route rejection body rendered by the card. */
export interface RouteError {
  /** Machine-readable failure class from `LocalModelsError`. */
  readonly code: string
  /** Actionable message. */
  readonly message: string
}

/** Fetch the full catalog. @returns the catalog view. @throws RouteError when a typed failure answers. */
export async function fetchCatalog(): Promise<CatalogView> {
  return fetchJson<CatalogView>(LOCAL_MODELS_CATALOG_PATH)
}

/** Fetch the pollable status snapshot. @returns the status view. */
export async function fetchStatus(): Promise<StatusView> {
  return fetchJson<StatusView>(LOCAL_MODELS_STATUS_PATH)
}

/**
 * Start installing one variant.
 * @param modelId - target family id.
 * @param variantId - variant to install.
 */
export async function postInstall(modelId: string, variantId: string): Promise<void> {
  await postJson(LOCAL_MODELS_INSTALL_PATH, { modelId, variantId })
}

/** Stop the active operation of one family. @param modelId - target family id. */
export async function postCancel(modelId: string): Promise<void> {
  await postJson(LOCAL_MODELS_CANCEL_PATH, { modelId })
}

/** Delete the installed variant of one family. @param modelId - target family id. */
export async function postRemove(modelId: string): Promise<void> {
  await postJson(LOCAL_MODELS_REMOVE_PATH, { modelId })
}

/** Run one smoke inference. @param modelId - target family id. @returns the observed outcome. */
export async function postProbe(modelId: string): Promise<ProbeOutcome> {
  return postJson<ProbeOutcome>(LOCAL_MODELS_PROBE_PATH, { modelId })
}

/** GET one JSON route, mapping typed failures to `RouteError`. */
async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  return readBody<T>(response)
}

/** POST one JSON route with a JSON body. */
async function postJson<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readBody<T>(response)
}

/** Parse one route answer, raising `RouteError` from the typed failure body. */
async function readBody<T>(response: Response): Promise<T> {
  const value: unknown = await response.json()
  if (!response.ok) {
    const candidate = value as { code?: unknown; message?: unknown }
    const error: RouteError = {
      code: typeof candidate.code === 'string' ? candidate.code : 'unknown',
      message: typeof candidate.message === 'string' ? candidate.message : response.statusText,
    }
    throw error
  }
  return value as T
}
