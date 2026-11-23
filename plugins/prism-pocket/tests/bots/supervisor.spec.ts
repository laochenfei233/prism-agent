/**
 * The supervisor and the ask relay: lifecycle transitions with fake
 * adapters, and the numbered-choice resolution with its timeout delegation.
 *
 * @module @prism/prism-pocket/tests/bots
 */

import { describe, expect, it, vi } from 'vitest'
import { BotSupervisor, type BotSupervisorHooks } from '../../src/bots/supervisor.ts'
import type { BotAdapterFactory, BotAdapterHooks, BotChannelId, BotHandle, BotInbound } from '../../src/bots/types.ts'
import { ASK_TIMEOUT_MS, BotAskRelay, classifyAskReply } from '../../src/bots/asks.ts'
import { decideInbound } from '../../src/bots/inbox.ts'
import { readBotConfig } from '../../src/bots/validate.ts'

/** One scripted handle. */
function scriptedHandle(overrides: Partial<BotHandle> = {}): BotHandle {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    probe: vi.fn(async () => undefined),
    ...overrides,
  }
}

/** A factory that hands out the scripted handles in order and records the hooks. */
function factoryOf(handles: BotHandle[], hooksOut: BotAdapterHooks[]): BotAdapterFactory {
  return (_config, hooks) => {
    hooksOut.push(hooks)
    const next = handles.shift()
    if (next === undefined) throw new Error('no scripted handle left')
    return next
  }
}

/** A supervisor recording every hook call. */
function recordingSupervisor(adapters: Partial<Record<BotChannelId, BotAdapterFactory>>): { supervisor: BotSupervisor; calls: { inbound: BotInbound[]; statuses: string[] } } {
  const calls = { inbound: [] as BotInbound[], statuses: [] as string[] }
  const hooks: BotSupervisorHooks = {
    onInbound: (_channel, message) => { calls.inbound.push(message) },
    onStatus: (channel, status, detail) => { calls.statuses.push(`${channel}:${status}${detail === undefined ? '' : `:${detail}`}`) },
  }
  const full = {
    telegram: adapters.telegram ?? (() => { throw new Error('not scripted') }),
  } as Record<BotChannelId, BotAdapterFactory>
  return { supervisor: new BotSupervisor(hooks, full), calls }
}

const TELEGRAM_CONFIG = readBotConfig('telegram', { botToken: 't' })

describe('BotSupervisor', () => {
  it('records starting → online and forwards inbound messages with the channel', async () => {
    const hooks: BotAdapterHooks[] = []
    const { supervisor, calls } = recordingSupervisor({ telegram: factoryOf([scriptedHandle()], hooks) })
    await supervisor.start('telegram', TELEGRAM_CONFIG)
    expect(supervisor.state('telegram').status).toBe('online')
    hooks[0]?.onInbound({ chatId: 'c1', senderId: 'op1', messageId: 'm1', text: 'hi' })
    expect(calls.inbound).toEqual([{ chatId: 'c1', senderId: 'op1', messageId: 'm1', text: 'hi' }])
    expect(calls.statuses).toEqual(['telegram:starting', 'telegram:online'])
  })

  it('keeps a failed start as an error state, not a throw', async () => {
    const hooks: BotAdapterHooks[] = []
    const failing = scriptedHandle({ start: vi.fn(async () => { throw new Error('bad token') }) })
    const { supervisor } = recordingSupervisor({ telegram: factoryOf([failing], hooks) })
    await supervisor.start('telegram', TELEGRAM_CONFIG)
    expect(supervisor.state('telegram')).toEqual({ status: 'error', detail: 'bad token' })
    expect(supervisor.handle('telegram')).toBeUndefined()
  })

  it('survives a live adapter reporting an error after start', async () => {
    const hooks: BotAdapterHooks[] = []
    const { supervisor } = recordingSupervisor({ telegram: factoryOf([scriptedHandle()], hooks) })
    await supervisor.start('telegram', TELEGRAM_CONFIG)
    hooks[0]?.onStatus('error', 'socket refused')
    expect(supervisor.state('telegram')).toEqual({ status: 'error', detail: 'socket refused' })
  })

  it('stops cleanly and reports off', async () => {
    const handle = scriptedHandle()
    const { supervisor } = recordingSupervisor({ telegram: factoryOf([handle], []) })
    await supervisor.start('telegram', TELEGRAM_CONFIG)
    await supervisor.stop('telegram')
    expect(handle.stop).toHaveBeenCalled()
    expect(supervisor.state('telegram').status).toBe('off')
    expect(supervisor.handle('telegram')).toBeUndefined()
  })

  it('restarts on a second start: the old handle stops before the new one starts', async () => {
    const first = scriptedHandle()
    const second = scriptedHandle()
    const { supervisor } = recordingSupervisor({ telegram: factoryOf([first, second], []) })
    await supervisor.start('telegram', TELEGRAM_CONFIG)
    await supervisor.start('telegram', readBotConfig('telegram', { botToken: 'b' }))
    expect(first.stop).toHaveBeenCalled()
    expect(supervisor.state('telegram').status).toBe('online')
  })
})

describe('classifyAskReply', () => {
  it('reads yes, no, numbers, and everything else', () => {
    expect(classifyAskReply('1')).toBe('yes')
    expect(classifyAskReply(' y ')).toBe('yes')
    expect(classifyAskReply('批准')).toBe('yes')
    expect(classifyAskReply('2')).toBe('no')
    expect(classifyAskReply('N')).toBe('no')
    expect(classifyAskReply('3')).toBe('number')
    expect(classifyAskReply('maybe')).toBe('other')
  })
})

describe('decideInbound', () => {
  it('recognizes the three commands and forwards everything else', () => {
    expect(decideInbound('/new')).toEqual({ kind: 'new' })
    expect(decideInbound(' /STOP ')).toEqual({ kind: 'stop' })
    expect(decideInbound('/help')).toEqual({ kind: 'help' })
    expect(decideInbound('hello world')).toEqual({ kind: 'forward', text: 'hello world' })
  })
})

describe('BotAskRelay', () => {
  const target = { channel: 'telegram' as const, chatId: 'c1' }

  /** The operator rule under test: only this sender id resolves an ask. */
  function onlyOperator(senderId: string): (channel: BotChannelId, chatId: string, from: string) => boolean {
    return (_channel, _chatId, from) => from === senderId
  }

  function relayOf(
    sent: string[],
    targetOf: (sessionId: string) => typeof target | undefined = () => target,
    authorized: (channel: BotChannelId, chatId: string, senderId: string) => boolean = () => true,
  ): BotAskRelay {
    return new BotAskRelay({
      targetOf,
      authorized,
      send: async (channel, chatId, text) => { sent.push(`${channel}:${chatId}:${text}`) },
    })
  }

  it('renders an approval and resolves it from the chat reply', async () => {
    const sent: string[] = []
    const relay = relayOf(sent)
    const next = vi.fn(async () => 'delegated')
    const pending = relay.handleApproval('s1', 'shell', next)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(sent[0]).toContain('shell')
    expect(relay.has('s1')).toBe(true)
    expect(relay.consume('telegram', 'c1', 's1', 'op1', 'y')).toBe(true)
    await expect(pending).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects an answer from a non-operator and keeps waiting', async () => {
    const sent: string[] = []
    const relay = relayOf(sent, () => target, onlyOperator('op1'))
    const next = vi.fn(async () => 'delegated')
    const pending = relay.handleApproval('s1', 'shell', next)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(relay.consume('telegram', 'c1', 's1', 'stranger', 'y')).toBe(false)
    expect(relay.has('s1')).toBe(true)
    expect(next).not.toHaveBeenCalled()
    expect(relay.consume('telegram', 'c1', 's1', 'op1', 'y')).toBe(true)
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('delegates when the chat is not bound or an ask is already pending', async () => {
    const sent: string[] = []
    const unbound = relayOf(sent, () => undefined)
    await expect(unbound.handleApproval('s1', 'shell', async () => 'delegated')).resolves.toBe('delegated')
    const bound = relayOf(sent)
    const first = bound.handleApproval('s1', 'a', async () => 'x')
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    await expect(bound.handleApproval('s1', 'b', async () => 'delegated')).resolves.toBe('delegated')
    bound.consume('telegram', 'c1', 's1', 'op1', '1')
    await expect(first).resolves.toBe('allowed-once')
  })

  it('expires after the timeout and the caller delegates', async () => {
    vi.useFakeTimers()
    try {
      const sent: string[] = []
      const relay = relayOf(sent)
      const next = vi.fn(async () => 'delegated')
      const pending = relay.handleApproval('s1', 'shell', next)
      await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS + 1)
      await expect(pending).resolves.toBe('delegated')
      expect(next).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a numbered question answer', async () => {
    const sent: string[] = []
    const relay = relayOf(sent)
    const next = vi.fn(async () => 'delegated')
    const pending = relay.handleQuestion('s1', {
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }],
    }, next)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(relay.consume('telegram', 'c1', 's1', 'op1', '2')).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Two'] }] })
  })

  it('refuses to answer the pending question with a non-number and keeps waiting', async () => {
    const sent: string[] = []
    const relay = relayOf(sent)
    const pending = relay.handleQuestion('s1', {
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'One' }] }],
    }, async () => 'delegated')
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(relay.consume('telegram', 'c1', 's1', 'op1', 'banana')).toBe(true)
    expect(relay.has('s1')).toBe(true)
    expect(relay.consume('telegram', 'c1', 's1', 'op1', '9')).toBe(true)
    expect(relay.has('s1')).toBe(true)
    expect(relay.consume('telegram', 'c1', 's1', 'op1', '1')).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['One'] }] })
  })

  it('delegates question forms it cannot render', async () => {
    const sent: string[] = []
    const relay = relayOf(sent)
    const next = vi.fn(async () => 'delegated')
    await expect(relay.handleQuestion('s1', { questions: [] }, next)).resolves.toBe('delegated')
    await expect(relay.handleQuestion('s1', { questions: [{ id: 'q1', question: 'Free?' }] }, next)).resolves.toBe('delegated')
    expect(sent).toHaveLength(0)
  })
})
