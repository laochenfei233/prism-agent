/**
 * Connector channel status. The feishu/dingtalk/wecom cards delegate to the
 * upstream CLI connectors, and each connector's account state lives on the
 * `connectorAccounts` registry the web-app bundle's `connector-account` row
 * provides. The registry is optional: a composition without it renders the
 * cards with no account status, and a failed watch keeps the last phases.
 *
 * @module @prism/prism-pocket/bots
 */

import type { Context } from '@deepseek-ai/cordis'

/** The connector channels, in page order, with the package whose account the Plugins page shows. */
export const CONNECTOR_CHANNELS: readonly { readonly channel: string; readonly packageName: string }[] = [
  { channel: 'feishu', packageName: '@deepseek-ai/dsh-feishu' },
  { channel: 'dingtalk', packageName: '@deepseek-ai/dsh-dingtalk' },
  { channel: 'wecom', packageName: '@deepseek-ai/dsh-wecom' },
]

/** One account as the registry's watch stream reports it; only read fields are narrowed. */
interface ConnectorAccountEntryLike {
  readonly key?: unknown
  readonly display?: { readonly phase?: unknown }
}

/** Structural view of the connector-accounts registry (no workspace type dependency). */
interface ConnectorAccountsLike {
  watch(signal: AbortSignal): AsyncIterable<{ readonly accounts: readonly ConnectorAccountEntryLike[] }>
}

/** One channel's connector status as the list route renders it. */
export interface ConnectorStatus {
  readonly channel: string
  readonly packageName: string
  /** The account display phase: `connected`, `disconnected`, `checking`, `connecting`, `unavailable`, or `unknown`. */
  readonly phase: string
}

/**
 * Read the registry off the context without trusting it.
 * @param ctx - host context.
 * @returns the registry, or undefined when the connector-account row is absent.
 */
export function connectorAccountsOf(ctx: Context): ConnectorAccountsLike | undefined {
  let service: unknown
  try {
    service = ctx.get('connectorAccounts')
  } catch {
    return undefined
  }
  if (typeof service !== 'object' || service === null) return undefined
  const candidate = service as Partial<ConnectorAccountsLike>
  if (typeof candidate.watch !== 'function') return undefined
  return service as ConnectorAccountsLike
}

/** Narrow one watch frame into a package-name → phase map. */
function readPhases(view: { readonly accounts: readonly ConnectorAccountEntryLike[] }): ReadonlyMap<string, string> {
  const phases = new Map<string, string>()
  for (const account of view.accounts) {
    if (typeof account?.key !== 'string' || typeof account.display?.phase !== 'string') continue
    phases.set(account.key, account.display.phase)
  }
  return phases
}

/**
 * Follow the registry for the plugin's lifetime and keep the latest phases.
 * The watch loop never throws into the host loop; a stream that ends or fails
 * leaves the last phases on the cards.
 * @param ctx - host context; the watcher stops with the plugin.
 * @param registry - the connector-accounts registry.
 * @returns a reader of the current per-channel status.
 */
export function trackConnectorStatus(ctx: Context, registry: ConnectorAccountsLike): () => readonly ConnectorStatus[] {
  let phases: ReadonlyMap<string, string> = new Map()
  const controller = new AbortController()
  ctx.effect(() => () => { controller.abort() }, 'pocket: connector status')
  void (async () => {
    try {
      for await (const view of registry.watch(controller.signal)) {
        if (controller.signal.aborted) return
        phases = readPhases(view)
      }
    } catch {
      // The stream ends with the registry or the plugin; the cards keep the last phases.
    }
  })()
  return () => CONNECTOR_CHANNELS.map(({ channel, packageName }) => ({
    channel,
    packageName,
    phase: phases.get(packageName) ?? 'unknown',
  }))
}
