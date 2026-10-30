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
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

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
 * @returns the element ref, its context-menu handler, and the menu element.
 */
export function useMessageContextMenu(t: PropsLocale<'chat'>['t']): MessageContextMenu {
  const state = useContextMenu()
  const actions = useContext(ChatMessageActionsContext)
  const ref = useRef<HTMLDivElement>(null)
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
  return {
    ref,
    onContextMenu,
    menu: <ContextMenu state={state} items={items} onSelect={onSelect} />,
  }
}
