/**
 * Structural host contracts, never Desktop version/hash gates. Unknown shapes
 * are unsupported until a separately validated adapter exists.
 *
 * Port of upstream `integrations/dsh-hachimodock/host-contract.js` with the
 * prism bundle id.
 *
 * @module @prism/prism-hachimodock/host-contract
 */

import type { BridgeContextLike } from './types.ts'

/** The bundle id the client-module graph check looks for. */
export const BUNDLE_ID = '@prism/prism-hachimodock'

/** Read host services structurally; unsupported lookups stay undefined. */
export function serviceView(ctx: BridgeContextLike): BridgeContextLike & { clientModules?: unknown } {
  const optional = (name: string): unknown => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  return {
    get sessions() {
      return ctx.sessions
    },
    get on() {
      return ctx.on
    },
    get agents() {
      return optional('agents')
    },
    get sessionController() {
      return optional('sessionController')
    },
    get clientModules() {
      return optional('clientModules')
    },
    get(name: string) {
      return ['sessionTitle', 'sessionProjections'].includes(name) ? optional(name) : undefined
    },
  } as BridgeContextLike & { clientModules?: unknown }
}

export interface HostCapabilitySnapshot {
  readonly adapter: string
  readonly sessions: boolean
  readonly sessionList: boolean
  readonly liveState: boolean
  readonly events: boolean
  readonly readonlyStatus: boolean
  readonly agentSnapshot: boolean
  readonly clientBundle: boolean
  readonly backgroundPrompt: boolean
  readonly interrupt: boolean
  readonly approval: 'independent-relay'
}

/** Snapshot which bridge features the running host actually provides. */
export function capabilities(ctx: BridgeContextLike): HostCapabilitySnapshot {
  let sessions = false
  try {
    const rows = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : null
    sessions = typeof ctx.sessions?.get === 'function' && Array.isArray(rows)
      && rows.every(s => s !== null && typeof s === 'object' && typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 200)
  } catch {
    /* retain unsupported */
  }
  let agentSnapshot = false
  let clientBundle = false
  try {
    agentSnapshot = sessions && typeof ctx.agents?.get === 'function'
  } catch {
    /* absent */
  }
  try {
    const modules = ctx.get?.('clientModules') as { graph?: () => { entries?: Array<Record<string, unknown>> } | null } | undefined
    const graph = typeof modules?.graph === 'function' ? modules.graph() : null
    clientBundle = Array.isArray(graph?.entries) && (graph as { entries: Array<Record<string, unknown>> }).entries.some(e =>
      e?.id === BUNDLE_ID
      && typeof e.url === 'string'
      && e.immediately === true
      && Array.isArray(e.inject)
      && (e.inject as string[]).includes('@deepseek-ai/dsh-client-ui-conversation'))
  } catch {
    /* bundle availability is independent of host and scoped owner */
  }
  let backgroundPrompt = false
  let interrupt = false
  try {
    backgroundPrompt = sessions && typeof ctx.sessionController?.prompt === 'function'
    interrupt = sessions && typeof ctx.sessionController?.cancel === 'function'
  } catch {
    /* optional control fiber is not active */
  }
  return Object.freeze({
    adapter: 'cordis-session-store-v1',
    sessions,
    agentSnapshot,
    clientBundle,
    backgroundPrompt,
    interrupt,
    sessionList: sessions,
    liveState: sessions && typeof ctx.on === 'function',
    events: sessions && typeof ctx.on === 'function',
    readonlyStatus: sessions && typeof ctx.on === 'function',
    // A registered host hook does not prove the physical approval relay ready.
    approval: 'independent-relay',
  } satisfies HostCapabilitySnapshot)
}
