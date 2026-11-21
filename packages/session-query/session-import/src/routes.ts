/**
 * Exact Host route addressed by the settings page. The browser uses the
 * document-relative form; the Host registers the absolute path on the shared
 * API channel.
 */

/** Absolute registration path of the import route. */
export const SESSION_IMPORT_PATH = '/api/session.import'

/** Browser-relative form used by the settings page. */
export const SESSION_IMPORT_ROUTE = SESSION_IMPORT_PATH.slice(1)

/** Absolute registration path of the source-discovery route. */
export const SESSION_IMPORT_CANDIDATES_PATH = '/api/session.import.candidates'

/** Browser-relative form used by the settings page. */
export const SESSION_IMPORT_CANDIDATES_ROUTE = SESSION_IMPORT_CANDIDATES_PATH.slice(1)
