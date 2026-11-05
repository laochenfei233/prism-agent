/**
 * The binding authority rule and the pairing flow: who may rebind, who may
 * drive, how `/start <code>` pairs, and how the legacy alpha bindings keep
 * working. The session trio is faked; the store is real (temp file).
 *
 * @module @prism/prism-pocket/tests/bots
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  BotConversations,
  PAIRING_HINT,
  PAIRING_REJECTED,
  operatorAuthorized,
  type PocketAgentView,
} from '../../src/bots/binding.ts'
import { BotStore } from '../../src/bots/store.ts'
import { readBotConfig } from '../../src/bots/validate.ts'
import type { BotEntry, BotInbound } from '../../src/bots/types.ts'

// These tests resolve this checkout's facade of `@deepseek-ai/dsh-llm`, whose
// target is its built declarations — not executable. The tests stub the one
// runtime export `binding.ts` uses; the message object itself is never read.
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (message: { content: unknown; source: unknown }) => message,
}))

const DIRECTORIES: string[] = []

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One scripted agent. */
interface FakeAgent extends PocketAgentView {
  readonly followup: Mock<(message: unknown) => void>
  readonly interrupt?: Mock<() => Promise<void>>
}

/** Everything one test drives. */
interface Harness {
  conversations: BotConversations
  store: BotStore
  sent: string[]
  bound: string[]
  agents: Map<string, FakeAgent>
  /** Create one session through the fake controller and return its id. */
  createSession(): Promise<string>
}

/**
 * Build a conversations module over a real temp store and faked host services.
 * @param options.legacy - hand-write a pre-senderId binding into the store file
 *   first, exactly as alpha builds persisted them, with a live agent behind it.
 * @param options.interruptible - expose an interrupt affordance on created agents.
 */
function harness(options: { legacy?: boolean; interruptible?: boolean } = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-binding-'))
  DIRECTORIES.push(directory)
  const file = join(directory, 'bots.json')
  let store = new BotStore(file)
  store.setConfig(readBotConfig('telegram', { botToken: 't' }))
  store.setEnabled('telegram', true)
  const sent: string[] = []
  const bound: string[] = []
  const agents = new Map<string, FakeAgent>()
  const spawn = (sessionId: string): FakeAgent => {
    const agent: FakeAgent = {
      id: sessionId,
      followup: vi.fn<(message: unknown) => void>(),
      session: {},
      ...(options.interruptible === true ? { interrupt: vi.fn<() => Promise<void>>(async () => undefined) } : {}),
    }
    agents.set(sessionId, agent)
    return agent
  }
  if (options.legacy === true) {
    store.bind('telegram', 'session-1', 'chat-1', 'op1')
    // Strip the recorded sender identity so the file reads exactly as an alpha build persisted it.
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { bots: Record<string, { senderId?: string }> }
    delete raw.bots.telegram?.senderId
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    store = new BotStore(file)
    spawn('session-1')
  }
  const conversations = new BotConversations({
    store,
    sessionController: {
      resolveAgent: async (sessionId: string) => {
        const agent = agents.get(sessionId)
        return agent === undefined ? { error: new Error(`session "${sessionId}" is gone`) } : { agent }
      },
      create: async () => ({ sessionId: spawn(`session-${agents.size + 1}`).id }),
    },
    sessions: { flush: async () => true },
    agents: { withoutInitiator: async work => work() },
    hooks: {
      send: async (_channel, chatId, text) => { sent.push(`${chatId}|${text}`) },
      onBound: (channel, sessionId, chatId) => { bound.push(`${channel}:${sessionId}:${chatId}`) },
    },
  })
  return { conversations, store, sent, bound, agents, createSession: async () => spawn(`session-${agents.size + 1}`).id }
}

/** One inbound message with the defaults a Telegram-like platform carries. */
function inbound(chatId: string, text: string, senderId = 'op1', messageId = 'm1'): BotInbound {
  return { chatId, senderId, messageId, text }
}

/** One minimal entry for the authority-rule table. */
function entryOf(chatId?: string, senderId?: string): BotEntry {
  return {
    config: readBotConfig('telegram', { botToken: 't' }),
    enabled: true,
    ...(chatId !== undefined ? { chatId } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
  }
}

describe('operatorAuthorized', () => {
  it('authorizes the bound chat on legacy and platform-less bindings only', () => {
    expect(operatorAuthorized(undefined, 'c1', 'op1')).toBe(false)
    expect(operatorAuthorized(entryOf('c1'), 'c1', 'op1')).toBe(true)
    expect(operatorAuthorized(entryOf('c1', ''), 'c1', 'op1')).toBe(true)
    expect(operatorAuthorized(entryOf('c1', 'op1'), 'c1', 'op1')).toBe(true)
    expect(operatorAuthorized(entryOf('c1', 'op1'), 'c1', 'other')).toBe(false)
    expect(operatorAuthorized(entryOf('c1', 'op1'), 'c2', 'other')).toBe(false)
  })

  it('recovers the operator across chats by sender match', () => {
    expect(operatorAuthorized(entryOf('c1', 'op1'), 'c2', 'op1')).toBe(true)
    expect(operatorAuthorized(entryOf('c1'), 'c2', 'op1')).toBe(false)
    expect(operatorAuthorized(entryOf('c1', 'op1'), 'c2', '')).toBe(false)
  })
})

describe('BotConversations pairing and authority', () => {
  it('pairs with the page code, rotates it, and records the sender', async () => {
    const h = harness()
    const code = h.store.pairingCode()
    await h.conversations.onInbound('telegram', inbound('chat-1', `/start ${code}`, 'op1'))
    expect(h.store.entry('telegram')).toMatchObject({ sessionId: 'session-1', chatId: 'chat-1', senderId: 'op1' })
    expect(h.sent).toEqual([expect.stringContaining('已配对新会话')])
    expect(h.store.pairingCode()).not.toBe(code)
    expect(h.store.consumePairingCode(code)).toBe(false)
  })

  it('rejects a wrong pairing code and keeps the active one', async () => {
    const h = harness()
    const code = h.store.pairingCode()
    await h.conversations.onInbound('telegram', inbound('chat-1', '/start wrong-code', 'op1'))
    expect(h.sent).toEqual([expect.stringContaining(PAIRING_REJECTED)])
    expect(h.store.entry('telegram')?.sessionId).toBeUndefined()
    expect(h.store.pairingCode()).toBe(code)
  })

  it('answers a bare /start and an ordinary message with the pairing hint, never auto-claiming', async () => {
    const h = harness()
    await h.conversations.onInbound('telegram', inbound('chat-1', '/start', 'op1'))
    expect(h.sent).toEqual([expect.stringContaining(PAIRING_HINT)])
    await h.conversations.onInbound('telegram', inbound('chat-1', 'hello', 'op1'))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toContain(PAIRING_HINT)
    expect(h.store.entry('telegram')?.sessionId).toBeUndefined()
    expect(h.agents.size).toBe(0)
  })

  it('rejects /new from a foreign sender without advertising /new', async () => {
    const h = harness()
    const sessionId = await h.createSession()
    h.store.bind('telegram', sessionId, 'chat-1', 'op1')
    await h.conversations.onInbound('telegram', inbound('chat-1', '/new', 'stranger'))
    expect(h.sent).toEqual([expect.stringContaining('已绑定其他会话')])
    expect(h.sent[0]).not.toContain('/new')
    expect(h.store.entry('telegram')?.sessionId).toBe(sessionId)
  })

  it('lets the operator rebind from another chat via the sender match', async () => {
    const h = harness()
    h.store.bind('telegram', await h.createSession(), 'chat-1', 'op1')
    await h.conversations.onInbound('telegram', inbound('chat-2', '/new', 'op1'))
    expect(h.store.entry('telegram')).toMatchObject({ sessionId: 'session-2', chatId: 'chat-2', senderId: 'op1' })
    expect(h.sent).toEqual([expect.stringContaining('已开始新会话')])
  })

  it('forwards the operator and rejects a same-chat foreign sender', async () => {
    const h = harness()
    h.store.bind('telegram', await h.createSession(), 'chat-1', 'op1')
    await h.conversations.onInbound('telegram', inbound('chat-1', 'hello'))
    expect(h.sent).toEqual([])
    expect(h.agents.get('session-1')?.followup).toHaveBeenCalledTimes(1)
    await h.conversations.onInbound('telegram', inbound('chat-1', 'yo', 'stranger'))
    expect(h.sent).toEqual([expect.stringContaining('已绑定其他会话')])
    expect(h.agents.get('session-1')?.followup).toHaveBeenCalledTimes(1)
  })

  it('delivers an authorized cross-chat message into the bound session', async () => {
    const h = harness()
    h.store.bind('telegram', await h.createSession(), 'chat-1', 'op1')
    await h.conversations.onInbound('telegram', inbound('chat-2', 'recover', 'op1'))
    expect(h.agents.get('session-1')?.followup).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([])
  })

  it('lets the operator stop the turn from another chat and keeps strangers out', async () => {
    const h = harness({ interruptible: true })
    h.store.bind('telegram', await h.createSession(), 'chat-1', 'op1')
    await h.conversations.onInbound('telegram', inbound('chat-2', '/stop', 'op1'))
    expect(h.agents.get('session-1')?.interrupt).toHaveBeenCalled()
    expect(h.sent[0]).toContain('已请求中止')
    await h.conversations.onInbound('telegram', inbound('chat-3', '/stop', 'stranger'))
    expect(h.sent[1]).toContain('没有绑定的会话')
    expect(h.agents.get('session-1')?.interrupt).toHaveBeenCalledTimes(1)
  })

  it('keeps chatId-only authority for a legacy binding and tightens it on rebind', async () => {
    const h = harness({ legacy: true })
    expect(h.store.entry('telegram')?.senderId).toBeUndefined()
    await h.conversations.onInbound('telegram', inbound('chat-1', 'hello', 'anyone'))
    expect(h.agents.get('session-1')?.followup).toHaveBeenCalledTimes(1)
    await h.conversations.onInbound('telegram', inbound('chat-2', 'hello', 'anyone'))
    expect(h.sent[0]).toContain('已绑定其他会话')
    await h.conversations.onInbound('telegram', inbound('chat-1', '/new', 'op1'))
    expect(h.store.entry('telegram')).toMatchObject({ sessionId: 'session-2', chatId: 'chat-1', senderId: 'op1' })
  })
})
