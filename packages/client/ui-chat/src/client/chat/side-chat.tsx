/**
 * Right-Sidebar host for a side conversation started from message text.
 *
 * One `sidechat` resource retains the created Session for as long as its tab is
 * open, and the tab body renders the shared Conversation content for it, so the
 * reader asks beside the conversation instead of navigating away from it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { NS } from '../locale.ts'
import css from './side-chat.module.css'

/** Stable implementation identity for the Sidebar tab body. */
export const SIDE_CHAT_ID = '@deepseek-ai/dsh-client-ui-chat'

/** Resource-address prefix for one side conversation. */
export const SIDE_CHAT_ADDRESS = 'dsh-resource://sidechat/session/'

/** Value retained by one open side-conversation tab. */
export interface SideChatResource {
  readonly reference: SessionReference
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    sideChat: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    sidechat: SideChatResource
  }

  interface SlotMap {
    /** Session-scoped Conversation occurrence hosted by one side-conversation tab. */
    'chat.side.conversation': { kind: 'single'; scope: 'session' }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed Session could not be opened for its panel. */
    'sidechat/open-failed': Record<string, never>
  }
}

/** Services a side conversation reads and drives. */
export type SideChatContext = Pick<Context, 'sessions' | 'sidebarRight' | 'get'>

/**
 * Address one side-conversation Session.
 * @param sessionId - Session the panel shows.
 * @returns the canonical resource address.
 */
export function sideChatAddress(sessionId: SessionId): string {
  return `${SIDE_CHAT_ADDRESS}${encodeURIComponent(sessionId)}`
}

/** Canonical spelling of one side-conversation address. */
const SIDE_CHAT_PATTERN = /^dsh-resource:\/\/sidechat\/session\/([^/?#]+)$/

/**
 * Parse one side-conversation resource address.
 * @param value - possible resource address.
 * @returns the addressed Session, or undefined for another or malformed resource.
 */
export function parseSideChatAddress(value: string): SessionId | undefined {
  const match = SIDE_CHAT_PATTERN.exec(value)
  if (match === null) return undefined
  try {
    return decodeURIComponent(match[1] as string) as SessionId
  } catch (_invalidEncoding) {
    return undefined
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/**
 * Create one Session in the viewing Session's workspace and open its panel,
 * staging the quotation the menu gesture captured. Nothing sends, and the main
 * conversation keeps its own selection.
 * @param ctx - Sessions, Sidebar, and the resource owner.
 * @param sessionId - Session whose workspace and selection the reader acts in.
 * @param prompt - quoted text staged in the new conversation's composer.
 * @param quotes - quotations awaiting the Session their panel opens.
 */
export function startSideChat(
  ctx: SideChatContext,
  sessionId: SessionId,
  prompt: string,
  quotes: Map<SessionId, string>,
): void {
  // The Workspace the reader is in owns the new Session: the Host attaches
  // membership only for an explicit Workspace, so a directory alone would leave
  // it ungrouped until the next bootstrap.
  const workspaceId = ctx.get('workspaces')?.list.getSnapshot().items
    .find(item => item.sessionIds.includes(sessionId))?.workspaceId
  const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  const request = workspaceId !== undefined
    ? { workspaceId }
    : cwd === undefined ? {} : { cwd }
  void ctx.sessions.create(request).then((sideId) => {
    quotes.set(sideId, prompt)
    try {
      ctx.sidebarRight.openResource(sideChatAddress(sideId))
    } catch (error: unknown) {
      // The Session existing without its panel is the lesser failure; the
      // quotation is dropped rather than stranded in the map.
      quotes.delete(sideId)
      throw error
    }
  }).catch((reason: unknown) => {
    console.warn('ui-chat: side conversation failed:', reason)
  })
}

/**
 * Retain one side-conversation Session for its tab and stage the quotation its
 * menu gesture captured.
 * @param ctx - Client services the resource reads.
 * @param quotes - quotations awaiting the Session they were opened for.
 * @returns the resource provider serving `sidechat` addresses.
 */
export function sideChatResourceProvider(ctx: SideChatContext, quotes: Map<SessionId, string>): ResourceProvider<'sidechat'> {
  return {
    protocol: 'sidechat',
    async *open(address, { signal }) {
      const sessionId = parseSideChatAddress(address)
      if (sessionId === undefined) throw new Error(`ui-chat: invalid side chat address "${address}"`)
      if (signal.aborted) return
      const reference = ctx.sessions.retain(sessionId, { source: 'sideChat', signal })
      try {
        const quote = quotes.get(sessionId)
        if (quote !== undefined) {
          await reference.ready
          quotes.delete(sessionId)
          const binding = ctx.sessions.binding(sessionId)
          const conversation = ctx.get('conversation')
          if (binding !== undefined && conversation !== undefined) {
            conversation.input.requestDraftInitialization(binding, { prompt: quote, whenDraftExists: 'append' })
          }
        }
        yield { ok: true, value: { reference } }
        await waitForAbort(signal)
      } catch (error: unknown) {
        // A provider reports failures as frames; closing the tab mid-open
        // rejects readiness, and an unexpected throw must not escape.
        quotes.delete(sessionId)
        if (!signal.aborted) {
          yield {
            ok: false,
            error: remoteErrorOf(error) ?? new RemoteError(
              'sidechat/open-failed',
              error instanceof Error ? error.message : String(error),
              {},
            ),
          }
        }
      } finally {
        reference.release()
      }
    },
  }
}

/** Props supplied to the Sidebar tab body hosting a side conversation. */
export type SideChatTabProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'chat.side.conversation'>

/** Bind the resource's Session around the tab's Conversation seat. */
export function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }: SideChatTabProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'sidechat'>(tab.contentId)
  if (resource.value === undefined) return null
  return (
    <div className={css.root} data-side-chat="">
      <SessionProvider session={resource.value.reference}>{renderSlot('chat.side.conversation', {})}</SessionProvider>
    </div>
  )
}

/** Props supplied to the embedded Conversation of one side-conversation tab. */
export type SideChatConversationProps = PropsRuntime<'chat.side.conversation'> & PropsRenderFactories

/** Render the shared Conversation content for the scoped side-conversation Session. */
export function SideChatConversation({ renderFactorySlot }: SideChatConversationProps) {
  return <>{renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })}</>
}

/**
 * Register the side-conversation resource owner and its Sidebar presentation.
 * @param ctx - Client root carrying resources, Slots, Sidebar, and Sessions.
 * @param t - Chat namespace translator for the tab title.
 * @param quotes - quotations awaiting the Session they were opened for.
 */
export function registerSideChat(ctx: Context, t: TranslateNS<typeof NS>, quotes: Map<SessionId, string>): void {
  // Both registries stay optional: Chat also mounts in compositions that ship
  // neither, where a side conversation has no panel to open.
  ctx.inject(['resources'], (scope) => {
    scope.effect(
      () => scope.resources.register(sideChatResourceProvider(scope, quotes)),
      'ui-chat: side conversation resources',
    )
  })
  ctx.inject(['sidebarRightTabs'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id: SIDE_CHAT_ID,
      kind: 'sidechat',
      patterns: [`${SIDE_CHAT_ADDRESS}**`],
      priority: 'builtin',
      canOpen: address => parseSideChatAddress(address) !== undefined,
      title: () => t('sideChat.title'),
    } satisfies SidebarRightTabDefinition), 'ui-chat: side conversation type')
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SIDE_CHAT_ID,
    children: { 'chat.side.conversation': { kind: 'single', scope: 'session' } },
  }, SideChatTab)), 'ui-chat: side conversation body')
  ctx.effect(() => ctx.slots.inject('chat.side.conversation', () => ctx.slots.register({
    name: 'chat.side.conversation',
  }, SideChatConversation)), 'ui-chat: side conversation content')
}
