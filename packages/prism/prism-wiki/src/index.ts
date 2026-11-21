/**
 * Prism wiki: a persistent, interlinked markdown knowledge vault that the model
 * compiles from raw sources and keeps current, with the vault service, the
 * operator command, the Web Knowledge page, and full-text retrieval.
 * @module @prism/prism-wiki
 */

export { WikiVaultService as default, WikiVaultService, WikiError, DEFAULT_PROTOCOL } from './service.ts'
export type { Config } from './service.ts'
export { VaultFiles, WikiVaultError, VAULT_SCHEMA_TEMPLATE, lintVault, parsePageText, serializePageText } from './vault.ts'
export type { WikiUnreadablePage } from './vault.ts'
export { WikiSearchIndex } from './search.ts'
export type { WikiSearchEntry } from './search.ts'
export type * from './types.ts'
