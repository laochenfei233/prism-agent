/**
 * Host half of the Agent Progress panel.
 *
 * The panel reads only browser-visible state (the session list and its
 * Host-computed projections), so this half registers no service, tool, or RPC
 * surface. It exists because the client-module scan enumerates Loader entries:
 * a package that declares `dsh.client` must be loadable as a plugin.
 */

/** Cordis plugin name, matching the `cordis.patch.yml` row id. */
export const name = 'prism-progress'

/** No Host contribution: the browser half owns every surface. */
export function apply(): void {}
