/**
 * Remote-access status assembly. Probing and pure rendering live in
 * `tailscale.ts` and `commands.ts`; this module re-exports the shared
 * rendering for the node half's public face.
 *
 * @module @prism/prism-pocket/remote-status
 */

export { isOriginTrusted, remoteCommands } from './commands.ts'
