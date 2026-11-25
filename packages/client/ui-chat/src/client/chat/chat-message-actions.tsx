/**
 * Secondary-press actions on conversation text: copy the selection (or the
 * whole message when nothing is selected), append it to the composer of the
 * current Session as a quotation, or start a side conversation in the same
 * workspace with the quotation prefilled. The provider is mounted by the Chat
 * view; a message body renders the menu it returns.
 */
import { createContext, useCallback, useContext, useMemo, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import { ContextMenu, useContextMenu, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageMenuOpenState } from '../contract/slots.ts'

/** Quote-preserving text the Chat view hands down to message bodies. */
export interface ChatMessageActions {
  /** Append text to the current Session's composer draft. */
  appendQuote: (text: string) => void
  /** Open a side conversation in the same workspace with text prefilled. */
  askInSideConversation: (text: string) => void
}

const ChatMessageActionsContext = createContext<ChatMessageActions | undefined>(undefined)

/**
 * Publish the Chat view's message actions to every message body below it.
 * @param props.actions - the quote and side-conversation callbacks.
 * @param props.children - the view's rendered subtree.
 * @returns the provider element.
 */
export function ChatMessageActionsProvider({ actions, children }: {
  actions: ChatMessageActions
  children: ReactNode
}): ReactNode {
  return <ChatMessageActionsContext.Provider value={actions}>{children}</ChatMessageActionsContext.Provider>
}

/** Attachments a message body needs to own its context menu. */
export interface MessageContextMenu {
  /** Ref for the element whose text the menu acts on. */
  ref: RefObject<HTMLDivElement>
  /** Suppress the browser menu and open the action menu at the press point. */
  onContextMenu: (event: ReactMouseEvent) => void
  /** The menu element, rendered inside the owning body. */
  menu: ReactNode
}

/** A settled message whose menu may carry plugin-contributed rows. */
export interface MessageMenuExtras {
  /** Durable id of the settled assistant message the menu describes. */
  readonly messageId: MessageId
  /** Render the menu's plugin rows in this body's slot scope. */
  readonly renderSlot: PropsRenderSlots<'conversation.chat.message.menu.item'>['renderSlot']
}

/** Selected text inside `root`, falling back to the element's own text. */
function actedText(root: HTMLElement): string {
  const selection = window.getSelection()
  if (selection !== null && selection.rangeCount > 0 && selection.anchorNode !== null
    && root.contains(selection.anchorNode)) {
    const text = selection.getRangeAt(0).toString().trim()
    if (text !== '') return text
  }
  return root.textContent?.trim() ?? ''
}

/**
 * Build one message body's context menu over the selection it contains.
 * @param t - the Chat locale seat.
 * @param extras - renders the settled message's plugin rows when the menu may
 *   carry them; omission renders the shipped rows only.
 * @returns the element ref, its context-menu handler, and the menu element.
 */
export function useMessageContextMenu(
  t: PropsLocale<'chat'>['t'],
  extras?: MessageMenuExtras,
): MessageContextMenu {
  const state = useContextMenu()
  const actions = useContext(ChatMessageActionsContext)
  const ref = useRef<HTMLDivElement>(null)
  const openState = useMemo((): MessageMenuOpenState => [
    state.point !== null,
    (open: boolean) => { if (!open) state.close() },
  ], [state.point, state.close])
  const items = useMemo((): readonly MenuEntry[] => [
    { id: 'copy', label: t('context.copy') },
    { id: 'add-to-task', label: t('context.addToTask'), disabled: actions === undefined },
    { id: 'ask-side', label: t('context.askSide'), disabled: actions === undefined },
  ], [actions, t])
  // The press is the moment the reader aimed at: focus moves to the menu row
  // on activation, and a selection is not guaranteed to survive that.
  const menuText = useRef('')
  const onContextMenu = useCallback((event: ReactMouseEvent) => {
    menuText.current = ref.current === null ? '' : actedText(ref.current)
    state.open(event)
  }, [state])
  const onSelect = useCallback((id: string) => {
    const text = menuText.current
    if (text === '') return
    if (id === 'copy') void writeClipboard(text)
    else if (id === 'add-to-task') actions?.appendQuote(text)
    else if (id === 'ask-side') actions?.askInSideConversation(text)
  }, [actions])
  // The slot renders nothing while the menu is closed: building its entries
  // before a press would mount plugin rows for a menu nobody opened.
  const extraRows = extras === undefined || state.point === null
    ? null
    : extras.renderSlot(
      'conversation.chat.message.menu.item',
      { messageId: extras.messageId },
      { hookContext: openState },
    )
  return {
    ref,
    onContextMenu,
    menu: (
      <ContextMenu state={state} items={items} onSelect={onSelect}>
        {extraRows}
      </ContextMenu>
    ),
  }
}
