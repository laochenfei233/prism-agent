/** Request construction, failure translation, and bounds of the OpenAI-compatible recognizer. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SpeechProvider, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAiSpeechProvider, OpenAiTimeoutError, type OpenAiProviderOptions } from '../src/provider.ts'
import {
  multipartParts,
  partText,
  startFakeEndpoint,
  waveRecording,
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
    id: brandString<SpeechProviderId>('openai-test'),
    name: 'OpenAI test',
    baseUrl,
    model: 'whisper-1',
    languages: ['auto', 'zh'],
    maxDurationSeconds: 60,
    maxUploadBytes: 1_000_000,
    timeoutMs: 5_000,
    resolveApiKey: async () => 'sk-test',
    ...overrides,
  })
}

/** Wait until a predicate holds, so a test acts on a request already in flight. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error('Condition was not reached')
}

describe('OpenAiSpeechProvider', () => {
  it('advertises a cloud recognizer with no preparation task', () => {
    const provider: SpeechProvider = providerFor('http://127.0.0.1:1/v1')
    expect(provider.info).toEqual({
      id: 'openai-test',
      name: 'OpenAI test',
      location: 'cloud',
      languages: ['auto', 'zh'],
      model: 'whisper-1',
    })
    expect(provider.preparation).toBeUndefined()
  })

  it('advertises the models the deployment offers', () => {
    expect(providerFor('http://127.0.0.1:1/v1').info.models).toBeUndefined()
    expect(providerFor('http://127.0.0.1:1/v1', { models: ['whisper-1', 'gpt-4o-transcribe'] }).info.models)
      .toEqual(['whisper-1', 'gpt-4o-transcribe'])
    expect(() => providerFor('http://127.0.0.1:1/v1', { models: ['gpt-4o-transcribe'] }))
      .toThrow('The default model whisper-1 is not among the offered models')
  })

  it('runs the model the call selected', async () => {
    const endpoint = await start()
    await providerFor(endpoint.url, { models: ['whisper-1', 'gpt-4o-transcribe'] }).transcribe(
      { audio: waveRecording(1), language: 'auto', model: 'gpt-4o-transcribe' },
      new AbortController().signal,
    )
    const request = endpoint.requests[0]!
    expect(partText(multipartParts(request.body, request.contentType), 'model')).toBe('gpt-4o-transcribe')
  })

  it('uploads the recording as one multipart request and returns its text', async () => {
    const endpoint = await start({ response: '{"text":"会议开始"}' })
    const recording = waveRecording(1)
    const transcript = await providerFor(endpoint.url).transcribe(
      { audio: recording, language: 'auto' },
      new AbortController().signal,
    )
    expect(transcript.text).toBe('会议开始')
    expect(transcript.audioSeconds).toBe(1)
    expect(transcript.inferenceSeconds).toBeGreaterThanOrEqual(0)
    expect(endpoint.requests).toHaveLength(1)
    const request = endpoint.requests[0]!
    expect(request.authorization).toBe('Bearer sk-test')
    expect(request.contentType).toContain('multipart/form-data')
    const parts = multipartParts(request.body, request.contentType)
    expect(partText(parts, 'model')).toBe('whisper-1')
    expect(partText(parts, 'response_format')).toBe('json')
    expect(parts.get('file')?.equals(recording)).toBe(true)
    expect(request.body.toString('utf8')).toContain('filename="recording.wav"')
    expect(request.body.toString('utf8')).toContain('Content-Type: audio/wav')
  })

  it('omits the language field when the caller asks for detection', async () => {
    const endpoint = await start()
    await providerFor(endpoint.url).transcribe({ audio: waveRecording(1), language: 'auto' }, new AbortController().signal)
    const request = endpoint.requests[0]!
    expect(multipartParts(request.body, request.contentType).has('language')).toBe(false)
  })

  it('forwards an explicit language hint', async () => {
    const endpoint = await start()
    await providerFor(endpoint.url).transcribe({ audio: waveRecording(1), language: 'zh' }, new AbortController().signal)
    const request = endpoint.requests[0]!
    expect(partText(multipartParts(request.body, request.contentType), 'language')).toBe('zh')
  })

  it('returns an empty transcript when the service reports no speech', async () => {
    const endpoint = await start({ response: '{"text":""}' })
    const transcript = await providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )
    expect(transcript.text).toBe('')
  })

  it('joins the transcription path to a base URL with trailing slashes', async () => {
    const endpoint = await start()
    await providerFor(`${endpoint.url}///`).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )
    expect(endpoint.requests).toHaveLength(1)
  })

  it('reports the failure status with the body it answered', async () => {
    const endpoint = await start({ status: 401, response: '{"error":{"message":"bad key"}}' })
    await expect(providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('The transcription request failed with HTTP 401: {"error":{"message":"bad key"}}')
  })

  it('reports only the status when the failure carried no body', async () => {
    const endpoint = await start({ status: 500, response: '' })
    await expect(providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow(/^The transcription request failed with HTTP 500$/u)
  })

  it('rejects a successful response that is not JSON', async () => {
    const endpoint = await start({ response: '<html>gateway</html>' })
    await expect(providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('The transcription response was not JSON')
  })

  it.each([['{"text":42}'], ['{}'], ['null']])('rejects the unusable payload %s', async (response) => {
    const endpoint = await start({ response })
    await expect(providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('The transcription response carried no text field')
  })

  it('fails without a credential and sends no request', async () => {
    const endpoint = await start()
    await expect(providerFor(endpoint.url, { resolveApiKey: async () => undefined }).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('requires an API key')
    await expect(providerFor(endpoint.url, { resolveApiKey: async () => '' }).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('requires an API key')
    expect(endpoint.requests).toEqual([])
  })

  it('rejects a recording that is not canonical 16 kHz mono PCM16 WAV', async () => {
    const endpoint = await start()
    await expect(providerFor(endpoint.url).transcribe(
      { audio: new Uint8Array(64), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('canonical 16 kHz mono PCM16 WAV')
    expect(endpoint.requests).toEqual([])
  })

  it('rejects a recording longer than the configured duration', async () => {
    const endpoint = await start()
    await expect(providerFor(endpoint.url, { maxDurationSeconds: 1 }).transcribe(
      { audio: waveRecording(2), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('exceeds 1 seconds')
    expect(endpoint.requests).toEqual([])
  })

  it('rejects an upload larger than the configured byte limit', async () => {
    const endpoint = await start()
    await expect(providerFor(endpoint.url, { maxUploadBytes: 32_000 }).transcribe(
      { audio: waveRecording(2), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow('Audio exceeds the 32000-byte upload limit')
    expect(endpoint.requests).toEqual([])
  })

  it('honors caller cancellation with the request in flight', async () => {
    const endpoint = await start({ neverAnswer: true })
    const caller = new AbortController()
    const pending = providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      caller.signal,
    )
    const rejection = expect(pending).rejects.toThrow('cancelled by the caller')
    await waitUntil(() => endpoint.requests.length > 0)
    caller.abort(new Error('cancelled by the caller'))
    await rejection
  })

  it('fails when the request deadline elapses', async () => {
    const endpoint = await start({ delayMs: 1_000 })
    await expect(providerFor(endpoint.url, { timeoutMs: 50 }).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toThrow(OpenAiTimeoutError)
  })

  it('translates the elapsed deadline into its configured duration', async () => {
    const endpoint = await start({ delayMs: 1_000 })
    await expect(providerFor(endpoint.url, { timeoutMs: 50 }).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      new AbortController().signal,
    )).rejects.toMatchObject({ timeoutMs: 50 })
  })

  it('fails before sending when the caller already cancelled', async () => {
    const endpoint = await start()
    const caller = new AbortController()
    caller.abort(new Error('cancelled before the call'))
    await expect(providerFor(endpoint.url).transcribe(
      { audio: waveRecording(1), language: 'auto' },
      caller.signal,
    )).rejects.toThrow('cancelled before the call')
    expect(endpoint.requests).toEqual([])
  })
})
