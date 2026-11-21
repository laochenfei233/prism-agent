/**
 * Connection fetch-route paths owned by the transfer plugin. The browser half
 * imports the same constants so both sides can never drift.
 *
 * @module @prism/prism-transfer/routes
 */

/** Streaming zip or settings-JSON download. */
export const TRANSFER_EXPORT_PATH = '/api/prism.transfer/export'
/** Streaming archive upload that starts one background import job. */
export const TRANSFER_IMPORT_PATH = '/api/prism.transfer/import'
/** Import job polling. */
export const TRANSFER_JOB_PATH = '/api/prism.transfer/job'
/** Buffered settings-document import. */
export const TRANSFER_SETTINGS_PATH = '/api/prism.transfer/settings'
