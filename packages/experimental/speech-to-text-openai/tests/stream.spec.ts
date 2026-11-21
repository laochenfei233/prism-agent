/** Incremental-output session behavior: buffered submission and progressive text. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import type { SpeechProviderId, SpeechStream, SpeechStreamUpdate } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAiTimeoutError } from '../src/errors.ts'
import { OpenAiSpeechProvider, type OpenAiProviderOptions } from '../src/provider.ts'
import {
  multipartParts,
  partText,
  startFakeEndpoint,
  type FakeEndpointOptions,
  type FakeTranscriptionEndpoint,
} from './fake-endpoint.fixture.ts'

const endpoints: FakeTranscriptionEndpoint[] = []

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()))
})

/** Start one stand-in endpoint that this suite closes after the test. */
async function start(options: FakeEndpointOptions = {}): Promise<FakeTranscriptionEndpoint> {
  const endpoint = await startFakeEndpoint(options)
  endpoints.push(endpoint)
  return endpoint
}

/** Build a recognizer pointing at one base URL. */
function providerFor(baseUrl: string, overrides: Partial<OpenAiProviderOptions> = {}): OpenAiSpeechProvider {
  return new OpenAiSpeechProvider({
    id: brandString<SpeechProviderId>('openai-stream'),
    name: 'OpenAI stream',
    baseUrl,
    model: 'gpt-4o-transcribe',
    languages: ['auto', 'zh'],
    maxDurationSeconds: 60,
    maxUploadBytes: 1_000_000,
    timeoutMs: 5_000,
    resolveApiKey: async () => 'sk-test',
    ...overrides,
  })
}

/** Collect every update a session delivers, so `close()` and observation overlap. */
function observe(stream: SpeechStream): { readonly seen: SpeechStreamUpdate[]; readonly done: Promise<void> } {
  const seen: SpeechStreamUpdate[] = []
  const done = (async () => {
    for await (const update of stream.events(new AbortController().signal)) seen.push(update)
  })()
  return { seen, done }
}

/** Encode one streaming event as the endpoint sends it. */
function frame(event: object): string {
  return JSON.stringify(event)
}

describe('OpenAI incremental-output sessions', () => {
  it('submits the buffered recording and streams partials and a final transcript', async () => {
    const endpoint = await start({ events: [
      frame({ type: 'transcript.text.delta', delta: 'he' }),
      frame({ type: 'transcript.text.delta', delta: 'llo' }),
      frame({ type: 'transcript.text.done', text: 'hello' }),
    ] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    await stream.push(new Uint8Array(32_000))
    const { seen, done } = observe(stream)
    await stream.close()
    await done
    expect(seen).toEqual([
      { kind: 'partial', id: 's0', text: 'he' },
      { kind: 'partial', id: 's0', text: 'hello' },
      { kind: 'final', transcript: { text: 'hello', audioSeconds: 1, inferenceSeconds: expect.any(Number) } },
    ])
    const request = endpoint.requests[0]!
    expect(request.authorization).toBe('Bearer sk-test')
    const parts = multipartParts(request.body, request.contentType)
    expect(partText(parts, 'model')).toBe('gpt-4o-transcribe')
    expect(partText(parts, 'response_format')).toBe('json')
    expect(partText(parts, 'stream')).toBe('true')
    expect(partText(parts, 'language')).toBe('zh')
    const file = parts.get('file')!
    expect(file.byteLength).toBe(44 + 32_000)
    expect(validateWave(new Uint8Array(file), 60)).toBe(1)
  })

  it('submits the model the session selected', async () => {
    const endpoint = await start({ events: [frame({ type: 'transcript.text.done', text: 'ok' })] })
    const stream = await providerFor(endpoint.url, { models: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] })
      .streaming.open({ language: 'auto', model: 'gpt-4o-mini-transcribe' }, new AbortController().signal)
    const { done } = observe(stream)
    await stream.close()
    await done
    const request = endpoint.requests[0]!
    expect(partText(multipartParts(request.body, request.contentType), 'model')).toBe('gpt-4o-mini-transcribe')
  })

  it('omits the language field when the caller asks for detection', async () => {
    const endpoint = await start({ events: [frame({ type: 'transcript.text.done', text: 'ok' })] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { done } = observe(stream)
    await stream.close()
    await done
    const request = endpoint.requests[0]!
    expect(multipartParts(request.body, request.contentType).has('language')).toBe(false)
  })

  it('settles with the accumulated text when the stream ends without a completion event', async () => {
    const endpoint = await start({ events: [
      frame({ type: 'transcript.text.delta', delta: 'a' }),
      frame({ type: 'transcript.text.delta', delta: 'b' }),
    ] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { seen, done } = observe(stream)
    await stream.close()
    await done
    expect(seen.at(-1)).toEqual({
      kind: 'final',
      transcript: { text: 'ab', audioSeconds: 0, inferenceSeconds: expect.any(Number) },
    })
  })

  it('reports diarized spans and carries them into the final transcript', async () => {
    const endpoint = await start({ events: [
      frame({ type: 'transcript.text.segment', id: 'seg-1', text: '你好', speaker: 'A', start: 0, end: 1.5 }),
      frame({ type: 'transcript.text.done', text: '你好' }),
    ] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'zh' }, new AbortController().signal)
    const { seen, done } = observe(stream)
    await stream.close()
    await done
    expect(seen).toEqual([
      { kind: 'segment', id: 'seg-1', segment: { text: '你好', speaker: 'A', start: 0, end: 1.5 } },
      {
        kind: 'final',
        transcript: {
          text: '你好',
          audioSeconds: 0,
          inferenceSeconds: expect.any(Number),
          segments: [{ text: '你好', speaker: 'A', start: 0, end: 1.5 }],
        },
      },
    ])
  })

  it('ignores an event the endpoint added that this provider does not know', async () => {
    const endpoint = await start({ events: [
      frame({ type: 'transcript.heartbeat' }),
      '[DONE]',
      frame({ type: 'transcript.text.done', text: 'kept' }),
    ] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { seen, done } = observe(stream)
    await stream.close()
    await done
    expect(seen).toEqual([{ kind: 'final', transcript: { text: 'kept', audioSeconds: 0, inferenceSeconds: expect.any(Number) } }])
  })

  it('serves one observer per session', async () => {
    const endpoint = await start({ events: [frame({ type: 'transcript.text.done', text: 'ok' })] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { done } = observe(stream)
    await expect(stream.events(new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toThrow('serves one observer')
    await stream.close()
    await done
  })

  it('refuses audio after the session closed and beyond its byte bound', async () => {
    const endpoint = await start({ events: [frame({ type: 'transcript.text.done', text: 'ok' })] })
    const stream = await providerFor(endpoint.url, { maxUploadBytes: 1_000 }).streaming.open(
      { language: 'auto' },
      new AbortController().signal,
    )
    await expect(stream.push(new Uint8Array(2_000))).rejects.toThrow('Audio exceeds the 1000-byte upload limit')
    await stream.close()
    await expect(stream.push(new Uint8Array(2))).rejects.toThrow('no longer accepts audio')
  })

  it('closes a session nobody observed without waiting for an observer', async () => {
    const endpoint = await start({ events: [frame({ type: 'transcript.text.done', text: 'ok' })] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    await stream.push(new Uint8Array(2))
    await stream.close()
    await stream.close()
  })

  it('cancels without delivering a final update', async () => {
    const endpoint = await start({ neverAnswer: true })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { seen, done } = observe(stream)
    await stream.cancel()
    await done
    expect(seen).toEqual([])
    await stream.cancel()
  })

  it('stops observing when the observer itself is cancelled', async () => {
    const endpoint = await start({ neverAnswer: true })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const observer = new AbortController()
    const consuming = (async () => {
      for await (const _update of stream.events(observer.signal)) { /* nothing is scripted to arrive */ }
    })()
    observer.abort(new Error('observer stopped'))
    await expect(consuming).rejects.toThrow('observer stopped')
    await stream.cancel()
  })

  it('cancels a session whose request is already in flight', async () => {
    const endpoint = await start({ neverAnswer: true })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { seen, done } = observe(stream)
    const closing = stream.close()
    await stream.cancel()
    await closing
    await done
    expect(seen).toEqual([])
  })

  it('fails an attached observer when the request failed', async () => {
    const endpoint = await start({ status: 500, response: 'upstream unavailable' })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    const { done } = observe(stream)
    const observed = expect(done).rejects.toThrow('The transcription request failed with HTTP 500: upstream unavailable')
    await expect(stream.close()).rejects.toThrow('The transcription request failed with HTTP 500: upstream unavailable')
    await observed
  })

  it('reports the failure status with the body it answered', async () => {
    const endpoint = await start({ status: 401, response: '{"error":{"message":"bad key"}}' })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    await expect(stream.close()).rejects.toThrow(
      'The transcription request failed with HTTP 401: {"error":{"message":"bad key"}}',
    )
  })

  it('rejects a successful response that carried no body', async () => {
    const endpoint = await start({ status: 204, response: '' })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    await expect(stream.close()).rejects.toThrow('The transcription response carried no body')
  })

  it('rejects a streamed payload that is not JSON', async () => {
    const endpoint = await start({ events: ['<html>'] })
    const stream = await providerFor(endpoint.url).streaming.open({ language: 'auto' }, new AbortController().signal)
    await expect(stream.close()).rejects.toThrow('The transcription response was not JSON')
  })

  it('fails when the request deadline elapses', async () => {
    const endpoint = await start({ neverAnswer: true })
    const stream = await providerFor(endpoint.url, { timeoutMs: 50 }).streaming.open(
      { language: 'auto' },
      new AbortController().signal,
    )
    await expect(stream.close()).rejects.toThrow(OpenAiTimeoutError)
  })

  it.each([[undefined], ['']])('fails at open when the credential resolves to %s', async (apiKey) => {
    const endpoint = await start()
    await expect(providerFor(endpoint.url, { resolveApiKey: async () => apiKey }).streaming.open(
      { language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('requires an API key')
    expect(endpoint.requests).toEqual([])
  })

  it('rejects an already-cancelled caller at open', async () => {
    const endpoint = await start()
    await expect(providerFor(endpoint.url).streaming.open(
      { language: 'auto' },
      AbortSignal.abort(new Error('cancelled before the session opened')),
    )).rejects.toThrow('cancelled before the session opened')
    expect(endpoint.requests).toEqual([])
  })
})
