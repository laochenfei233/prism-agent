/** Realtime session behavior of the DashScope recognizer against a local duplex endpoint. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SpeechProvider, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { afterEach, describe, expect, it } from 'vitest'
import { DashScopeSpeechProvider, DashScopeTimeoutError, type DashScopeProviderOptions } from '../src/provider.ts'
import { FakeDashScopeService, waveRecording } from './fake-service.fixture.ts'

const services: FakeDashScopeService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
})

/** Build provider options pointing at one endpoint. */
function providerFor(url: string, overrides: Partial<DashScopeProviderOptions> = {}): DashScopeSpeechProvider {
  return new DashScopeSpeechProvider({
    id: brandString<SpeechProviderId>('dashscope-test'),
    name: 'DashScope test',
    url,
    model: 'fun-asr-realtime',
    languages: ['zh'],
    speakerDiarization: true,
    maxDurationSeconds: 60,
    timeoutMs: 5_000,
    drainTimeoutMs: 2_000,
    resolveApiKey: async () => 'sk-test',
    ...overrides,
  })
}

/** Wait until a predicate holds, so a test observes a session before acting on it. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error('Condition was not reached')
}

describe('DashScopeSpeechProvider', () => {
  it('advertises a cloud recognizer with no preparation task', () => {
    const provider: SpeechProvider = providerFor('ws://127.0.0.1:1/api-ws/v1/inference')
    expect(provider.info).toEqual({
      id: 'dashscope-test',
      name: 'DashScope test',
      location: 'cloud',
      languages: ['zh'],
      model: 'fun-asr-realtime',
    })
    expect(provider.preparation).toBeUndefined()
  })

  it('advertises the models the deployment offers', () => {
    expect(providerFor('ws://127.0.0.1:1/api-ws/v1/inference').info.models).toBeUndefined()
    expect(providerFor('ws://127.0.0.1:1/api-ws/v1/inference', { models: ['fun-asr-realtime', 'paraformer-realtime-v2'] })
      .info.models).toEqual(['fun-asr-realtime', 'paraformer-realtime-v2'])
    expect(() => providerFor('ws://127.0.0.1:1/api-ws/v1/inference', { models: ['other'] }))
      .toThrow('The default model fun-asr-realtime is not among the offered models')
  })

  it('declares the model the call selected', async () => {
    const service = await FakeDashScopeService.start({ sentences: [] })
    services.push(service)
    await providerFor(service.url, { models: ['fun-asr-realtime', 'paraformer-realtime-v2'] }).transcribe(
      { audio: waveRecording(1), language: 'zh', model: 'paraformer-realtime-v2' },
      new AbortController().signal,
    )
    expect(service.requests[0]?.payload).toMatchObject({ model: 'paraformer-realtime-v2' })
  })

  it('uploads PCM without the WAV header and joins the closed sentences', async () => {
    const service = await FakeDashScopeService.start({
      sentences: [
        { text: '大家好', final: false },
        { text: '大家好，会议开始。', final: true },
        { text: '第二项议题', final: true },
      ],
    })
    services.push(service)
    const transcript = await providerFor(service.url).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )
    expect(transcript.text).toBe('大家好，会议开始。\n第二项议题')
    expect(transcript.audioSeconds).toBe(1)
    expect(transcript.inferenceSeconds).toBeGreaterThanOrEqual(0)
    expect(service.uploaded.equals(Buffer.alloc(32_000))).toBe(true)
    expect(service.authorizations).toEqual(['Bearer sk-test'])
    expect(service.requests.map(frame => frame.header?.action)).toEqual(['run-task', 'finish-task'])
    expect(service.requests[0]?.payload).toMatchObject({
      task: 'asr',
      model: 'fun-asr-realtime',
      parameters: { format: 'pcm', sample_rate: 16000, speaker_diarization_enabled: true },
    })
  })

  it('returns an empty transcript when the service reports no speech', async () => {
    const service = await FakeDashScopeService.start({ sentences: [] })
    services.push(service)
    const transcript = await providerFor(service.url).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )
    expect(transcript.text).toBe('')
  })

  it('splits a long recording into one-second PCM frames', async () => {
    const service = await FakeDashScopeService.start({ sentences: [] })
    services.push(service)
    await providerFor(service.url).transcribe({ audio: waveRecording(3), language: 'zh' }, new AbortController().signal)
    expect(service.audio.map(frame => frame.length)).toEqual([32_000, 32_000, 32_000])
  })

  it('reports the service failure message', async () => {
    const service = await FakeDashScopeService.start({ failWith: 'quota exceeded' })
    services.push(service)
    await expect(providerFor(service.url).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow('DashScope recognition failed: quota exceeded')
  })

  it('fails without a credential', async () => {
    const service = await FakeDashScopeService.start({ sentences: [] })
    services.push(service)
    await expect(providerFor(service.url, { resolveApiKey: async () => undefined }).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow('requires an API key')
    expect(service.requests).toEqual([])
  })

  it('rejects a recording that is not canonical 16 kHz mono PCM16 WAV', async () => {
    const service = await FakeDashScopeService.start({ sentences: [] })
    services.push(service)
    await expect(providerFor(service.url).transcribe(
      { audio: new Uint8Array(64), language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow('canonical 16 kHz mono PCM16 WAV')
    expect(service.requests).toEqual([])
  })

  it('rejects a recording longer than the configured duration', async () => {
    const service = await FakeDashScopeService.start({ sentences: [] })
    services.push(service)
    await expect(providerFor(service.url, { maxDurationSeconds: 1 }).transcribe(
      { audio: waveRecording(2), language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow('exceeds 1 seconds')
  })

  it('fails when the endpoint closes before the task finishes', async () => {
    const service = await FakeDashScopeService.start({ finish: false })
    services.push(service)
    const pending = providerFor(service.url).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )
    const rejection = expect(pending).rejects.toThrow(/connection (failed|closed early)/)
    await waitUntil(() => service.requests.some(frame => frame.header?.action === 'finish-task'))
    await service.close()
    await rejection
  })

  it('honors caller cancellation', async () => {
    const service = await FakeDashScopeService.start({ stall: true })
    services.push(service)
    const caller = new AbortController()
    const pending = providerFor(service.url).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      caller.signal,
    )
    const rejection = expect(pending).rejects.toThrow('cancelled by the caller')
    await waitUntil(() => service.requests.length > 0)
    caller.abort(new Error('cancelled by the caller'))
    await rejection
  })

  it('fails when the recognition deadline elapses before the task starts', async () => {
    const service = await FakeDashScopeService.start({ stall: true })
    services.push(service)
    await expect(providerFor(service.url, { timeoutMs: 100 }).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )).rejects.toThrow(DashScopeTimeoutError)
    await expect(providerFor(service.url, { timeoutMs: 100 }).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )).rejects.toMatchObject({ phase: 'recognition', timeoutMs: 100 })
  })

  it('fails when the service withholds its final results', async () => {
    const service = await FakeDashScopeService.start({ finish: false })
    services.push(service)
    await expect(providerFor(service.url, { drainTimeoutMs: 100 }).transcribe(
      { audio: waveRecording(1), language: 'zh' },
      new AbortController().signal,
    )).rejects.toMatchObject({ phase: 'results', timeoutMs: 100 })
  })
})
