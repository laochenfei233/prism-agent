// @vitest-environment jsdom
/** Side-conversation Sidebar tab: address, staged quotation, retention, and body. */
import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  parseSideChatAddress, SideChatConversation, SideChatTab, sideChatAddress, sideChatResourceProvider,
} from '../src/client/chat/side-chat.tsx'

const SIDE = 'side-1' as SessionId
const ADDRESS = 'dsh-resource://sidechat/session/side-1'

afterEach(() => { cleanup() })

function bench(options: { quotes?: Map<SessionId, string>; binding?: boolean; conversation?: boolean } = {}) {
  const release = vi.fn()
  const binding = { sessionId: SIDE }
  const sessions = {
    retain: vi.fn(() => ({ ready: Promise.resolve(binding), release })),
    binding: vi.fn(() => options.binding === false ? undefined : binding),
  }
  const requestDraftInitialization = vi.fn(() => 'applied' as const)
  const conversation = { input: { requestDraftInitialization } }
  const ctx = {
    sessions: sessions as never,
    sidebarRight: { openResource: vi.fn() } as never,
    get: ((name: string) => options.conversation === false || name !== 'conversation'
      ? undefined
      : conversation) as never,
  }
  const resource = sideChatResourceProvider(ctx, options.quotes ?? new Map<SessionId, string>())
  return { resource, sessions, requestDraftInitialization, release, binding }
}

function open(b: ReturnType<typeof bench>, address: string, signal: AbortSignal) {
  return b.resource.open(address, { signal })[Symbol.asyncIterator]()
}

describe('side-conversation address', () => {
  it('round-trips one Session identity', () => {
    expect(sideChatAddress('a/b' as SessionId)).toBe('dsh-resource://sidechat/session/a%2Fb')
    expect(parseSideChatAddress('dsh-resource://sidechat/session/a%2Fb')).toBe('a/b')
  })

  it.each([
    ['not a URL', 'not a url'],
    ['another protocol host', 'dsh-resource://file/session/side-1'],
    ['a path outside a session', 'dsh-resource://sidechat/pane/side-1'],
    ['a deeper path', 'dsh-resource://sidechat/session/side-1/extra'],
    ['an undecodable identity', 'dsh-resource://sidechat/session/%'],
  ])('rejects %s', (_reason, address) => {
    expect(parseSideChatAddress(address)).toBeUndefined()
  })
})

describe('side-conversation resource', () => {
  it('retains the Session, stages the quotation, and releases on close', async () => {
    const quotes = new Map<SessionId, string>([[SIDE, '> quoted']])
    const b = bench({ quotes })
    const controller = new AbortController()
    const opening = open(b, ADDRESS, controller.signal)
    expect((await opening.next()).value).toMatchObject({ ok: true })
    // The quotation is consumed once, so a reopened tab keeps whatever the
    // reader has since typed.
    expect(quotes.size).toBe(0)
    expect(b.requestDraftInitialization).toHaveBeenCalledExactlyOnceWith(
      b.binding,
      { prompt: '> quoted', whenDraftExists: 'append' },
    )
    controller.abort()
    expect(await opening.next()).toMatchObject({ done: true })
    expect(b.release).toHaveBeenCalledOnce()
  })

  it('opens a Session the gesture recorded no quotation for', async () => {
    const b = bench()
    const controller = new AbortController()
    const opening = open(b, ADDRESS, controller.signal)
    expect((await opening.next()).value).toMatchObject({ ok: true })
    expect(b.requestDraftInitialization).not.toHaveBeenCalled()
    controller.abort()
    await opening.next()
  })

  it('keeps the panel when the retained binding is already gone', async () => {
    const quotes = new Map<SessionId, string>([[SIDE, '> quoted']])
    const b = bench({ quotes, binding: false })
    const controller = new AbortController()
    const opening = open(b, ADDRESS, controller.signal)
    expect((await opening.next()).value).toMatchObject({ ok: true })
    expect(b.requestDraftInitialization).not.toHaveBeenCalled()
    controller.abort()
    await opening.next()
  })

  it('keeps the panel when no Conversation service is mounted', async () => {
    const quotes = new Map<SessionId, string>([[SIDE, '> quoted']])
    const b = bench({ quotes, conversation: false })
    const controller = new AbortController()
    const opening = open(b, ADDRESS, controller.signal)
    expect((await opening.next()).value).toMatchObject({ ok: true })
    expect(b.requestDraftInitialization).not.toHaveBeenCalled()
    controller.abort()
    await opening.next()
  })

  it('does not retain when the tab closed before its content opened', async () => {
    const b = bench()
    const controller = new AbortController()
    controller.abort()
    expect(await open(b, ADDRESS, controller.signal).next()).toMatchObject({ done: true })
    expect(b.sessions.retain).not.toHaveBeenCalled()
  })

  it('rejects an address outside the side-chat protocol', async () => {
    const b = bench()
    const opening = open(b, 'dsh-resource://file/session/side-1', new AbortController().signal)
    await expect(opening.next()).rejects.toThrow('invalid side chat address')
  })
})

describe('side-conversation tab body', () => {
  const reference = { sessionId: SIDE, binding: {}, ready: Promise.resolve({}), release: () => {} }

  function props(value: { reference: typeof reference } | undefined) {
    return {
      useResource: () => ({ value }),
      useTabInfo: () => ({ tab: { contentId: ADDRESS } }),
      SessionProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
      renderSlot: vi.fn(() => <div data-testid="conversation" />),
    }
  }

  it('binds the resource Session around the Conversation seat', () => {
    const stub = props({ reference })
    render(<>{SideChatTab(stub as never)}</>)
    expect(stub.renderSlot).toHaveBeenCalledExactlyOnceWith('chat.side.conversation', {})
  })

  it('renders nothing until the resource opens', () => {
    const stub = props(undefined)
    render(<>{SideChatTab(stub as never)}</>)
    expect(stub.renderSlot).not.toHaveBeenCalled()
  })
})

describe('side-conversation content', () => {
  it('renders the embedded Conversation content', () => {
    const renderFactorySlot = vi.fn(() => <div data-testid="content" />)
    render(<>{SideChatConversation({ renderFactorySlot } as never)}</>)
    expect(renderFactorySlot).toHaveBeenCalledExactlyOnceWith(
      'conversation.content',
      { variant: 'embedded', phase: 'active', hero: false },
    )
  })
})
