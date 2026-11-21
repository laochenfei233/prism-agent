/**
 * Route paths. JSON routes register on the authenticated `/api` channel
 * through `connection.fetch.register`.
 *
 * @module @prism/prism-local-models
 */

/** Full catalog: families, variants, lifecycle state, integrity, paths. */
export const LOCAL_MODELS_CATALOG_PATH = '/api/local-models/catalog'

/** Pollable per-family lifecycle snapshot while the card drives an operation. */
export const LOCAL_MODELS_STATUS_PATH = '/api/local-models/status'

/** Start installing one variant of one family. */
export const LOCAL_MODELS_INSTALL_PATH = '/api/local-models/install'

/** Stop the active download or provisioning of one family. */
export const LOCAL_MODELS_CANCEL_PATH = '/api/local-models/cancel'

/** Delete the installed variant of one family. */
export const LOCAL_MODELS_REMOVE_PATH = '/api/local-models/remove'

/** Run one smoke inference and report the observed result. */
export const LOCAL_MODELS_PROBE_PATH = '/api/local-models/probe'
