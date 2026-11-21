/**
 * Host half of the About settings section.
 *
 * The section renders only browser-visible state (the shell-injected update
 * carrier), so this half registers no service, tool, or RPC surface. It exists
 * because the client-module scan enumerates Loader entries: a package that
 * declares `dsh.client` must be loadable as a plugin.
 */

/** Cordis plugin name, matching the `cordis.patch.yml` row id. */
export const name = 'prism-about'

/** No Host contribution: the browser half owns every surface. */
export function apply(): void {}
