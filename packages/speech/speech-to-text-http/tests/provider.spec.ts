/** Provider registration, key resolution, and HTTP recognition behavior without network access. */

import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { CredentialInfo, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'
import { HttpSpeechProvider } from '../src/provider.ts'

/** Build one canonical one-second 16 kHz mono PCM16 WAV recording. */
function canonicalWav(secondCount: number): Uint8Array {
  const pcmBytes = 32_000 * secondCount
  const audio = Buffer.alloc(44 + pcmBytes)
  audio.write('RIFF', 0, 'ascii'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8, 'ascii')
  audio.write('fmt ', 12, 'ascii'); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28)
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36, 'ascii')
  audio.writeUInt32LE(pcmBytes, 40)
  return new Uint8Array(audio)
}

/** Credentials plane stub answering one fixed value; every other member is unused. */
class StubCredentials extends CredentialProvider {
  override async resolve(): Promise<ResolvedCredential | undefined> {
    return { value: 'resolved-key', source: 'stub' }
  }

  override async describe(): Promise<CredentialInfo> { throw new Error('the stub describes nothing') }
  override async set(): Promise<void> { throw new Error('the stub stores nothing') }
  override async unset(): Promise<void> { throw new Error('the stub stores nothing') }
  override async readRecord(): Promise<CredentialRecord | undefined> { throw new Error('the stub holds no records') }
  override async describeRecord(): Promise<CredentialRecordInfo> { throw new Error('the stub holds no records') }
  override async listRecords(): Promise<readonly CredentialRecordEntry[]> { return [] }
  override async modifyRecord(): Promise<CredentialRecord | undefined> { throw new Error('the stub holds no records') }
  override async deleteRecord(): Promise<void> { throw new Error('the stub holds no records') }
}

/** One provider aimed at a recording fetch stub. */
function provider(
  doFetch: typeof fetch,
  resolveApiKey: () => Promise<string | undefined> = async () => 'secret',
  overrides: Partial<ConstructorParameters<typeof HttpSpeechProvider>[0]> = {},
): HttpSpeechProvider {
  return new HttpSpeechProvider({
    id: 'http-test',
    endpoint: 'https://asr.example/v1/audio/transcriptions',
    model: 'whisper-large-v3',
    languages: ['auto', 'zh'],
    textField: 'text',
    maxAudioBytes: 25 * 1024 * 1024,
    maxDurationSeconds: 7200,
    timeoutMs: 1_000,
    resolveApiKey,
    doFetch,
    ...overrides,
  })
}

/** One JSON-answering fetch stub with the requests it received. */
function fetchOf(status: number, body: string) {
  const calls: { readonly url: string; readonly init: RequestInit }[] = []
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      init: init ?? {},
    })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  return { doFetch, calls }
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('HTTP provider recognition', () => {
  it('uploads the WAV as OpenAI-shaped multipart with the bearer key and reads the mapped field', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: 'meeting started' }))
    const audio = canonicalWav(1)
    const result = await provider(stub.doFetch).transcribe({ audio, language: 'auto' }, new AbortController().signal)
    expect(result).toMatchObject({ text: 'meeting started', audioSeconds: 1 })
    expect(result.inferenceSeconds).toBeGreaterThanOrEqual(0)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toBe('https://asr.example/v1/audio/transcriptions')
    const headers = new Headers(stub.calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
    const form = stub.calls[0]?.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-large-v3')
    expect(form.get('language')).toBeNull()
    const file = form.get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(file.size).toBe(audio.byteLength)
  })

  it('sends a configured language and skips the auto hint', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: '你好' }))
    await provider(stub.doFetch).transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    const form = stub.calls[0]?.init.body as FormData
    expect(form.get('language')).toBe('zh')
  })

  it('fails with an operator-readable message when no key resolves', async () => {
    const stub = fetchOf(200, '{}')
    await expect(provider(stub.doFetch, async () => undefined).transcribe(
      { audio: canonicalWav(1), language: 'auto' }, new AbortController().signal,
    )).rejects.toThrow('no API key')
    expect(stub.calls).toHaveLength(0)
  })

  it('rejects non-canonical audio and oversized recordings before the request', async () => {
    const stub = fetchOf(200, '{}')
    await expect(provider(stub.doFetch).transcribe({ audio: new Uint8Array([1]), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('canonical 16 kHz mono PCM16 WAV')
    const small = provider(stub.doFetch, async () => 'secret', { maxAudioBytes: 100 })
    await expect(small.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('exceeds 100 bytes')
    expect(stub.calls).toHaveLength(0)
  })

  it('reports a failed HTTP answer with its status and body', async () => {
    const stub = fetchOf(503, 'upstream unavailable')
    await expect(provider(stub.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('answered 503: upstream unavailable')
  })

  it('treats a bodyless answer as an unusable response', async () => {
    const doFetch: typeof fetch = async () => new Response(null, { status: 200 })
    await expect(provider(doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('malformed JSON')
  })

  it('rejects a JSON answer whose mapped path is absent', async () => {
    const stub = fetchOf(200, '"recognized"')
    await expect(provider(stub.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('answered without the "text" field')
  })

  it('rejects malformed JSON and an answer without the mapped field', async () => {
    const malformed = fetchOf(200, '<html>gateway</html>')
    await expect(provider(malformed.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('malformed JSON')
    const missing = fetchOf(200, JSON.stringify({ result: 'recognized' }))
    await expect(provider(missing.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('answered without the "text" field')
  })

  it('answers an empty recognized text as the no-speech transcript', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: '' }))
    await expect(provider(stub.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .resolves.toMatchObject({ text: '' })
  })
})

describe('generic request layer', () => {
  it('omits the model field and keeps the credential when the service names no model', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: 'ok' }))
    await provider(stub.doFetch, async () => 'secret', { model: undefined, name: 'DeepSeek ASR' }).transcribe(
      { audio: canonicalWav(1), language: 'auto' }, new AbortController().signal)
    const form = stub.calls[0]?.init.body as FormData
    expect(form.get('model')).toBeNull()
    expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer secret')
  })

  it('maps the recognized text through a dot path into nested answers', async () => {
    const stub = fetchOf(200, JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'hello there' }] }] } }))
    const nested = provider(stub.doFetch, async () => 'secret',
      { textField: 'results.channels.0.alternatives.0.transcript' })
    await expect(nested.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .resolves.toMatchObject({ text: 'hello there' })
  })

  it('uploads raw bytes with the fixed endpoint URL and the configured credential prefix', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: 'raw' }))
    const raw = provider(stub.doFetch, async () => 'secret', {
      mode: 'raw-body',
      endpoint: 'https://api.example/v1/listen?model=nova-3',
      authStyle: 'token',
    })
    const audio = canonicalWav(1)
    await raw.transcribe({ audio, language: 'auto' }, new AbortController().signal)
    expect(stub.calls[0]?.url).toBe('https://api.example/v1/listen?model=nova-3')
    const headers = new Headers(stub.calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Token secret')
    expect(headers.get('content-type')).toBe('audio/wav')
    expect(stub.calls[0]?.init.body).toBeInstanceOf(Uint8Array)
    expect((stub.calls[0]?.init.body as Uint8Array).byteLength).toBe(audio.byteLength)
  })

  it('carries the credential as a raw value under a custom header', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: 'keyed' }))
    const keyed = provider(stub.doFetch, async () => 'secret', { authHeader: 'xi-api-key', authStyle: 'raw' })
    await keyed.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal)
    expect(new Headers(stub.calls[0]?.init.headers).get('xi-api-key')).toBe('secret')
  })
})

describe('chat-completions mode recognition', () => {
  /** One provider speaking the audio-bearing chat-completions request form. */
  function chatProvider(doFetch: typeof fetch): HttpSpeechProvider {
    return provider(doFetch, async () => 'secret', {
      endpoint: 'https://asr.example/v1/chat/completions',
      mode: 'chat-completions',
      model: 'mimo-v2.5-asr',
      languages: ['auto', 'zh', 'en'],
    })
  }

  it('sends the WAV as a base64 data URL inside an input_audio message', async () => {
    const stub = fetchOf(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: '会议开始了' } }] }))
    const audio = canonicalWav(1)
    const result = await chatProvider(stub.doFetch).transcribe({ audio, language: 'zh' }, new AbortController().signal)
    expect(result).toMatchObject({ text: '会议开始了', audioSeconds: 1 })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toBe('https://asr.example/v1/chat/completions')
    const headers = new Headers(stub.calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
    expect(headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(stub.calls[0]?.init.body as string) as {
      model: string
      asr_options: { language: string }
      messages: { role: string; content: { type: string; input_audio: { data: string } }[] }[]
    }
    expect(body.model).toBe('mimo-v2.5-asr')
    expect(body.asr_options).toEqual({ language: 'zh' })
    expect(body.messages[0]?.role).toBe('user')
    expect(body.messages[0]?.content[0]?.type).toBe('input_audio')
    expect(body.messages[0]?.content[0]?.input_audio.data).toBe(`data:audio/wav;base64,${Buffer.from(audio).toString('base64')}`)
  })

  it('omits the language knob for the auto hint and answers empty as no speech', async () => {
    const stub = fetchOf(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }))
    const result = await chatProvider(stub.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal)
    expect(result).toMatchObject({ text: '' })
    const body = JSON.parse(stub.calls[0]?.init.body as string) as { asr_options?: { language: string } }
    expect(body.asr_options).toBeUndefined()
  })

  it('rejects an answer without a choices message text', async () => {
    const stub = fetchOf(200, JSON.stringify({ choices: [] }))
    await expect(chatProvider(stub.doFetch).transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('answered without a "choices[0].message.content" text')
  })

  it('registers a chat-completions service and answers through the registry', async () => {
    const stub = fetchOf(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'chat mode from the registry' } }] }))
    vi.stubGlobal('fetch', stub.doFetch)
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'http-chat', language: 'auto' })
      const fiber = await ctx.plugin(Plugin, {
        services: [
          { providerId: 'http-chat', endpoint: 'https://a.example/v1/chat/completions', apiKey: 'literal-chat', apiKeyEnv: 'A_KEY', model: 'mimo-v2.5-asr', mode: 'chat-completions', languages: ['auto', 'zh', 'en'] },
        ],
      })
      expect(ctx.speechToText.listProviders()).toEqual([
        { id: 'http-chat', name: 'mimo-v2.5-asr', location: 'cloud', languages: ['auto', 'zh', 'en'], maxAudioSeconds: 819 },
      ])
      const spec = ctx.speechToText.resolve({ audio: canonicalWav(1) })
      await expect(ctx.speechToText.transcribe(spec, new AbortController().signal))
        .resolves.toMatchObject({ text: 'chat mode from the registry' })
      await fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })
})

describe('HTTP provider registration', () => {
  it('registers one recognizer per service, answers through the registry, and withdraws on disposal', async () => {
    const stub = fetchOf(200, JSON.stringify({ text: 'from the registry' }))
    vi.stubGlobal('fetch', stub.doFetch)
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'http-a', language: 'auto' })
      const fiber = ctx.plugin(Plugin, {
        services: [
          { providerId: 'http-a', endpoint: 'https://a.example/asr', apiKeyEnv: 'A_KEY', model: 'whisper-a' },
          { providerId: 'http-b', name: 'Second service', endpoint: 'https://b.example/asr', apiKey: 'literal-b', apiKeyEnv: 'B_KEY', model: 'whisper-b' },
        ],
      })
      await fiber
      expect(ctx.speechToText.listProviders()).toEqual([
        { id: 'http-a', name: 'whisper-a', location: 'cloud', languages: ['auto'], maxAudioSeconds: 819 },
        { id: 'http-b', name: 'Second service', location: 'cloud', languages: ['auto'], maxAudioSeconds: 819 },
      ])
      const spec = ctx.speechToText.resolve({ audio: canonicalWav(1), providerId: brandString<SpeechProviderId>('http-b') })
      const result = await ctx.speechToText.transcribe(spec, new AbortController().signal)
      expect(result).toMatchObject({ text: 'from the registry' })
      await fiber.dispose()
      expect(ctx.speechToText.listProviders()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('fails an incomplete service entry at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'http-a', language: 'auto' })
      await expect(ctx.plugin(Plugin, { services: [{ endpoint: 'https://a.example/asr', apiKeyEnv: 'A_KEY', model: 'whisper-a' }] }))
        .rejects.toThrow()
      expect(ctx.speechToText.listProviders()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects a duplicate provider id at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'http-a', language: 'auto' })
      const config = { services: [{ providerId: 'http-a', endpoint: 'https://a.example/asr', apiKeyEnv: 'A_KEY', model: 'whisper-a' }] }
      await ctx.plugin(Plugin, config)
      // The duplicate id fails when the second plugin's registration runs.
      await expect(ctx.plugin(Plugin, config)).rejects.toThrow('Speech provider already registered: http-a')
    } finally { await ctx.fiber.dispose() }
  })
})

describe('service key resolution', () => {
  const ref = 'HTTP_ASR_TEST_KEY' as CredentialRef

  it('prefers the literal configuration value', async () => {
    const ctx = new Context()
    vi.stubEnv('HTTP_ASR_TEST_KEY', 'ambient-key')
    await expect(Plugin.resolveServiceKey('literal-key', ref, 'HTTP_ASR_TEST_KEY', ctx)).resolves.toBe('literal-key')
  })

  it('resolves through the credentials plane when one is mounted', async () => {
    const ctx = new Context()
    // Constructing the service registers it on the context.
    new StubCredentials(ctx)
    await expect(Plugin.resolveServiceKey(undefined, ref, 'HTTP_ASR_TEST_KEY', ctx)).resolves.toBe('resolved-key')
  })

  it('falls back to the launch environment and reports an absent key', async () => {
    const ctx = new Context()
    vi.stubEnv('HTTP_ASR_TEST_KEY', 'ambient-key')
    await expect(Plugin.resolveServiceKey(undefined, ref, 'HTTP_ASR_TEST_KEY', ctx)).resolves.toBe('ambient-key')
    vi.stubEnv('HTTP_ASR_TEST_KEY', '')
    await expect(Plugin.resolveServiceKey(undefined, ref, 'HTTP_ASR_TEST_KEY', ctx)).resolves.toBeUndefined()
  })
})
