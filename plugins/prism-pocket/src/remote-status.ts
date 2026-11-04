/**
 * Remote-access status assembly. Probing and pure rendering live in
 * `tailscale.ts`, `tunnel.ts`, and `commands.ts`; this module re-exports the
 * shared rendering for the node half's public face.
 *
 * @module @prism/prism-pocket/remote-status
 */

export { isOriginTrusted, phoneAccess, phoneTarget, remoteCommands, tunnelAccess, tunnelCommands } from './commands.ts'
