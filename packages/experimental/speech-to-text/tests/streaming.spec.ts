/** Live-session routing, capability reporting, and registration-owned session lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SpeechToText from '../src/index.ts'
import type {
  SpeechProvider,
  SpeechProviderId,
  SpeechStream,
  SpeechStreamingMode,
  SpeechStreamUpdate,
  Transcript,
} from '../src/types.ts'

const result: Transcript = { text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 }
const input = new AbortController().signal

/** One scripted session: the test inspects every operation it received. */
class FakeSession implements SpeechStream {
  readonly pushed: Uint8Array[] = []
  closeCalls = 0
  cancelCalls = 0
  /** Updates {@link FakeSession.events} replays to every observer. */
  updates: SpeechStreamUpdate[] = []

  async push(chunk: Uint8Array): Promise<void> { this.pushed.push(chunk) }

  async close(): Promise<void> { this.closeCalls++ }

  async cancel(): Promise<void> { this.cancelCalls++ }

  async *events(_signal: AbortSignal): AsyncIterable<SpeechStreamUpdate> { yield* this.updates }
}

/**
 * Build one recognizer.
 * @param id - registration identity.
 * @param mode - advertised live mode, or `undefined` for a batch-only recognizer.
 * @param session - session every open returns.
 * @returns the recognizer, that session, and the recorded open calls.
 */
function provider(id: string, mode?: SpeechStreamingMode, session = new FakeSession()) {
  const open = vi.fn(async () => session)
  const recognizer: SpeechProvider = {
    info: { id: id as SpeechProviderId, name: id, location: 'cloud', languages: ['auto', 'zh'] },
    transcribe: async () => result,
    ...mode === undefined ? {} : { streaming: { mode, open } },
  }
  return { recognizer, session, open }
}

/** Mount the service with one live and one batch-only recognizer. */
async function mounted() {
  const ctx = new Context()
  const base = ctx.plugin(SpeechToText, { defaultProvider: 'live', language: 'zh' })
  await base
  const service = ctx.get('speechToText')!
  const live = provider('live', 'duplex')
  const batch = provider('batch')
  const removeLive = service.register(live.recognizer)
  const removeBatch = service.register(batch.recognizer)
  return { ctx, base, service, live, batch, removeLive, removeBatch }
}

describe('live session capability', () => {
  it('reports the mode a provider streams and omits it for batch-only recognizers', async () => {
    const { base, service } = await mounted()
    try {
      expect(service.snapshot().providers).toEqual([
        { id: 'live', name: 'live', location: 'cloud', languages: ['auto', 'zh'], preparation: { phase: 'ready' }, streaming: 'duplex' },
        { id: 'batch', name: 'batch', location: 'cloud', languages: ['auto', 'zh'], preparation: { phase: 'ready' } },
      ])
    } finally { await base.dispose() }
  })

  it('resolves composition defaults and explicit choices without fallback', async () => {
    const { base, service, live } = await mounted()
    try {
      const spec = service.resolveStream({})
      expect(spec).toEqual({ provider: live.recognizer, streaming: live.recognizer.streaming, language: 'zh' })
      expect(service.resolveStream({ providerId: live.recognizer.info.id, language: 'auto' }))
        .toMatchObject({ provider: live.recognizer, language: 'auto' })
      expect(() => service.resolveStream({ providerId: 'batch' as SpeechProviderId }))
        .toThrow('offers no live session: batch')
      expect(() => service.resolveStream({ providerId: 'missing' as SpeechProviderId })).toThrow('unavailable')
      expect(() => service.resolveStream({ providerId: 'live' as SpeechProviderId, language: 'fr' }))
        .toThrow('does not support language')
    } finally { await base.dispose() }
  })
})

describe('live sessions', () => {
  it('opens exactly the resolved session and delegates every operation', async () => {
    const { base, service, live } = await mounted()
    try {
      const caller = new AbortController()
      const stream = await service.openStream(service.resolveStream({}), caller.signal)
      expect(live.open).toHaveBeenCalledTimes(1)
      expect(live.open).toHaveBeenCalledWith({ language: 'zh' }, expect.any(AbortSignal))
      await stream.push(new Uint8Array([1, 2, 3]))
      expect(live.session.pushed.map(chunk => chunk.byteLength)).toEqual([3])
      live.session.updates = [
        { kind: 'partial', id: 's1', text: 'hel', speaker: 'A' },
        { kind: 'final', transcript: result },
      ]
      const seen: SpeechStreamUpdate[] = []
      for await (const update of stream.events(input)) seen.push(update)
      expect(seen).toEqual(live.session.updates)
      await stream.close()
      expect(live.session.closeCalls).toBe(1)
      await stream.cancel()
      expect(live.session.cancelCalls).toBe(1)
    } finally { await base.dispose() }
  })

  it('rejects an already-cancelled caller and a withdrawn registration', async () => {
    const { base, service, removeLive } = await mounted()
    try {
      const spec = service.resolveStream({})
      await expect(service.openStream(spec, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
      await removeLive()
      await expect(service.openStream(spec, input)).rejects.toThrow('no longer registered')
    } finally { await base.dispose() }
  })

  it('cancels a live session when its registration withdraws', async () => {
    const { base, service, live, removeLive } = await mounted()
    try {
      await service.openStream(service.resolveStream({}), input)
      await removeLive()
      expect(live.session.cancelCalls).toBe(1)
    } finally { await base.dispose() }
  })

  it('stops owning a session once the caller closes or cancels it', async () => {
    const { base, service, live, removeLive } = await mounted()
    try {
      const closed = await service.openStream(service.resolveStream({}), input)
      await closed.close()
      const cancelled = await service.openStream(service.resolveStream({}), input)
      await cancelled.cancel()
      await removeLive()
      expect(live.session.cancelCalls).toBe(1)
      expect(live.session.closeCalls).toBe(1)
    } finally { await base.dispose() }
  })

  it('cancels live sessions when the service itself unloads', async () => {
    const { base, service, live } = await mounted()
    await service.openStream(service.resolveStream({}), input)
    await base.dispose()
    expect(live.session.cancelCalls).toBe(1)
  })
})
