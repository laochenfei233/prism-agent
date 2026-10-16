/** Send-buffer backpressure and the start-phase faults the duplex session reports. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { afterEach, describe, expect, it } from 'vitest'
import { DashScopeSpeechProvider, type DashScopeProviderOptions } from '../src/provider.ts'
import { MAX_BUFFERED_BYTES, waitForDrain } from '../src/session.ts'
import { FakeDashScopeService, type ServiceScript } from './fake-service.fixture.ts'

const services: FakeDashScopeService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
})

/** Start one stand-in service that this suite closes after the test. */
async function start(script: ServiceScript = {}): Promise<FakeDashScopeService> {
  const service = await FakeDashScopeService.start(script)
  services.push(service)
  return service
}

/** Build a recognizer pointing at one endpoint. */
function providerFor(url: string, overrides: Partial<DashScopeProviderOptions> = {}): DashScopeSpeechProvider {
  return new DashScopeSpeechProvider({
    id: brandString<SpeechProviderId>('dashscope-session'),
    name: 'DashScope session',
    url,
    model: 'fun-asr-realtime',
    languages: ['auto', 'zh'],
    speakerDiarization: true,
    maxDurationSeconds: 60,
    timeoutMs: 5_000,
    drainTimeoutMs: 2_000,
    resolveApiKey: async () => 'sk-test',
    ...overrides,
  })
}

/** A transport whose queued bytes fall by one chunk on every read. */
function drainingSocket(from: number): { readonly bufferedAmount: number } {
  let queued = from
  return {
    get bufferedAmount(): number {
      queued -= 64 * 1024
      return queued
    },
  }
}

describe('send backpressure', () => {
  it('waits while the transport holds more audio than it may buffer', async () => {
    await waitForDrain(drainingSocket(MAX_BUFFERED_BYTES + 1), new AbortController().signal)
  })

  it('stops waiting when the session is cancelled mid-drain', async () => {
    const caller = new AbortController()
    const pending = waitForDrain({ bufferedAmount: Number.MAX_SAFE_INTEGER }, caller.signal)
    caller.abort(new Error('cancelled while draining'))
    await expect(pending).rejects.toThrow('cancelled while draining')
  })

  it('refuses an already-cancelled session before waiting', async () => {
    await expect(waitForDrain({ bufferedAmount: 0 }, AbortSignal.abort(new Error('cancelled before draining'))))
      .rejects.toThrow('cancelled before draining')
  })
})

describe('start-phase faults', () => {
  it('reports a task that finished before it started', async () => {
    const service = await start({ startFault: 'finished' })
    await expect(providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('Recognition finished before the task started')
  })

  it('reports a frame the protocol cannot decode', async () => {
    const service = await start({ startFault: 'malformed' })
    await expect(providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('Recognition frame carries no event name')
  })

  it('reports a graceful close that arrives before any result', async () => {
    const service = await start({ startFault: 'graceful' })
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const consuming = (async () => {
      for await (const _update of stream.events(new AbortController().signal)) { /* no results are scripted */ }
    })()
    await expect(consuming).rejects.toThrow('Waiting for the final recognition results failed: the connection closed')
    await expect(stream.close()).rejects.toThrow('the connection closed')
  })

  it('reports a connection that never opened', async () => {
    await expect(providerFor('ws://127.0.0.1:1/api-ws/v1/inference').streaming.open(
      { language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow('The recognition connection failed')
  })

  it('ignores an event name the protocol does not recognize', async () => {
    const service = await start({ liveNoise: true, sentences: [{ text: 'kept', final: true }] })
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const seen: string[] = []
    const consuming = (async () => {
      for await (const update of stream.events(new AbortController().signal)) seen.push(update.kind)
    })()
    await stream.close()
    await consuming
    expect(seen).toEqual(['segment', 'final'])
  })
})
