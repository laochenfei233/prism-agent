/** Live duplex session behavior: attribution, single-observer ownership, and cancellation. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SpeechProviderId, SpeechStreamUpdate } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { afterEach, describe, expect, it } from 'vitest'
import { DashScopeSpeechProvider, type DashScopeProviderOptions } from '../src/provider.ts'
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
    id: brandString<SpeechProviderId>('dashscope-live'),
    name: 'DashScope live',
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

describe('DashScope live sessions', () => {
  it('streams partials, speaker-attributed segments, and one final transcript', async () => {
    const service = await start({
      liveSentences: [
        { text: '你', final: false, speaker: 'A' },
        { text: '你好', final: true, speaker: 'A' },
        { text: '在', final: false, speaker: 'B' },
        { text: '在吗', final: true, speaker: 'B' },
      ],
    })
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const seen: SpeechStreamUpdate[] = []
    const consuming = (async () => {
      for await (const update of stream.events(new AbortController().signal)) seen.push(update)
    })()
    await stream.push(new Uint8Array(32_000))
    await stream.close()
    await consuming
    expect(seen).toEqual([
      { kind: 'partial', id: 's0', text: '你', speaker: 'A' },
      { kind: 'segment', id: 's0', segment: { text: '你好', speaker: 'A' } },
      { kind: 'partial', id: 's1', text: '在', speaker: 'B' },
      { kind: 'segment', id: 's1', segment: { text: '在吗', speaker: 'B' } },
      {
        kind: 'final',
        transcript: {
          text: '你好\n在吗',
          audioSeconds: 1,
          inferenceSeconds: expect.any(Number),
          segments: [{ text: '你好', speaker: 'A' }, { text: '在吗', speaker: 'B' }],
        },
      },
    ])
    expect(service.uploaded.equals(Buffer.alloc(32_000))).toBe(true)
    expect(service.requests[0]?.payload).toMatchObject({
      parameters: { speaker_diarization_enabled: true, language_hints: ['zh'] },
    })
    expect(service.authorizations).toEqual(['Bearer sk-test'])
  })

  it('declares the model the session selected', async () => {
    const service = await start()
    const stream = await providerFor(service.url, { models: ['fun-asr-realtime', 'paraformer-realtime-v2'] })
      .streaming.open({ language: 'zh', model: 'paraformer-realtime-v2' }, new AbortController().signal)
    await stream.cancel()
    expect(service.requests[0]?.payload).toMatchObject({ model: 'paraformer-realtime-v2' })
  })

  it('settles with an unattributed transcript when the service separated no speakers', async () => {
    const service = await start({ sentences: [{ text: 'plain', final: true }] })
    const stream = await providerFor(service.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const seen: SpeechStreamUpdate[] = []
    const consuming = (async () => {
      for await (const update of stream.events(new AbortController().signal)) seen.push(update)
    })()
    await stream.close()
    await consuming
    expect(seen).toEqual([
      { kind: 'segment', id: 's0', segment: { text: 'plain' } },
      {
        kind: 'final',
        transcript: { text: 'plain', audioSeconds: 0, inferenceSeconds: expect.any(Number), segments: [{ text: 'plain' }] },
      },
    ])
    expect(service.requests[0]?.payload).toMatchObject({ parameters: { speaker_diarization_enabled: true } })
  })

  it('settles with an empty transcript when the service reported nothing', async () => {
    const service = await start()
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const seen: SpeechStreamUpdate[] = []
    const consuming = (async () => {
      for await (const update of stream.events(new AbortController().signal)) seen.push(update)
    })()
    await stream.close()
    await consuming
    expect(seen).toEqual([{
      kind: 'final',
      transcript: { text: '', audioSeconds: 0, inferenceSeconds: expect.any(Number) },
    }])
  })

  it('serves one observer per session', async () => {
    const service = await start()
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const started = stream.events(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect(stream.events(new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toThrow('serves one observer')
    await stream.cancel()
    await expect(started).resolves.toEqual({ value: undefined, done: true })
    expect(service.requests).toHaveLength(1)
  })

  it('stops accepting audio once the caller closed the session', async () => {
    const service = await start()
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    await stream.close()
    await expect(stream.push(new Uint8Array(2))).rejects.toThrow('no longer accepts audio')
    await stream.close()
  })

  it('cancels a session nobody observed', async () => {
    const service = await start()
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    await stream.cancel()
    await stream.cancel()
  })

  it('cancels an observed session without delivering a final update', async () => {
    const service = await start({ finish: false })
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const seen: SpeechStreamUpdate[] = []
    const consuming = (async () => {
      for await (const update of stream.events(new AbortController().signal)) seen.push(update)
    })()
    await stream.cancel()
    await consuming
    expect(seen).toEqual([])
  })

  it('fails the observer and the close when the endpoint drops mid-session', async () => {
    const service = await start({ finish: false })
    const stream = await providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const consuming = (async () => {
      for await (const _update of stream.events(new AbortController().signal)) { /* no updates are scripted */ }
    })()
    const failed = expect(consuming).rejects.toThrow(/connection (failed|closed early)|Waiting for/u)
    await service.close()
    await failed
    await expect(stream.close()).rejects.toThrow(/connection (failed|closed early)|Waiting for/u)
  })

  it.each([[undefined], ['']])('fails before connecting when the credential resolves to %s', async (apiKey) => {
    const service = await start()
    await expect(providerFor(service.url, { resolveApiKey: async () => apiKey }).streaming.open(
      { language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow('requires an API key')
    expect(service.requests).toEqual([])
  })

  it('rejects an already-cancelled caller before connecting', async () => {
    const service = await start()
    await expect(providerFor(service.url).streaming.open(
      { language: 'zh' },
      AbortSignal.abort(new Error('cancelled before the session opened')),
    )).rejects.toThrow('cancelled before the session opened')
    expect(service.requests).toEqual([])
  })

  it('reports the service failure raised while the task starts', async () => {
    const service = await start({ failWith: 'quota exceeded' })
    await expect(providerFor(service.url).streaming.open({ language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('DashScope recognition failed: quota exceeded')
  })
})
