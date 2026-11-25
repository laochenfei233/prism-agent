/** International request forms: Google envelope, Azure multipart, Amazon Transcribe job flow. */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'
import { HttpSpeechProvider } from '../src/provider.ts'
import { readGoogleResult } from '../src/google.ts'
import { readAzureResult } from '../src/azure.ts'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => 'fixed-uuid' }
})

/** Golden AWS SigV4 signature of the deterministic StartTranscriptionJob request, computed independently. */
const GOLDEN_AWS = '39345bb5b1b7341bd0d813aaebf72d86dc41b2655489457f6e8c6d88af61ef2b'

/** Build one canonical one-second 16 kHz mono PCM16 WAV recording of silence. */
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

/** One JSON-answering fetch stub with the requests it received. */
function fetchOf(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: { readonly url: string; readonly init: RequestInit }[] = []
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      init: init ?? {},
    })
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } })
  }
  return { doFetch, calls }
}

afterEach(() => { vi.restoreAllMocks() })

describe('google-speech', () => {
  it('sends the LINEAR16 envelope with the language code and reads joined results', async () => {
    const stub = fetchOf(200, JSON.stringify({
      results: [
        { alternatives: [{ transcript: 'first sentence' }] },
        { alternatives: [{ transcript: 'second sentence' }] },
      ],
    }))
    const service = new HttpSpeechProvider({
      id: 'google-test', endpoint: 'https://speech.example/v1/speech:recognize',
      mode: 'google-speech', model: 'latest_long', languages: ['auto', 'zh'],
      textField: 'text', maxAudioBytes: 25 * 1024 * 1024, maxDurationSeconds: 7200,
      timeoutMs: 1_000, resolveApiKey: async () => 'api-key', doFetch: stub.doFetch,
    })
    const result = await service.transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    expect(result).toMatchObject({ text: 'first sentence\nsecond sentence' })
    const body = JSON.parse(stub.calls[0]?.init.body as string) as {
      config: { encoding: string; sampleRateHertz: number; languageCode?: string; model?: string }
      audio: { content: string }
    }
    expect(body.config.encoding).toBe('LINEAR16')
    expect(body.config.sampleRateHertz).toBe(16000)
    expect(body.config.languageCode).toBe('zh-CN')
    expect(body.config.model).toBe('latest_long')
    expect(body.audio.content).toBe(Buffer.from(canonicalWav(1)).toString('base64'))
    // The key rides the documented header, never the URL.
    const headers = stub.calls[0]?.init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('api-key')
    expect(stub.calls[0]?.url).not.toContain('key=')
  })

  it('answers empty results as no speech and reports service errors', async () => {
    const answer = (body: string, headers: Record<string, string> = {}): Response =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } })
    await expect(readGoogleResult(answer(JSON.stringify({})), 'google')).resolves.toBe('')
    await expect(readGoogleResult(answer(JSON.stringify({ results: [] })), 'google')).resolves.toBe('')
    await expect(readGoogleResult(answer(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'bad audio' } })), 'google'))
      .rejects.toThrow('INVALID_ARGUMENT: bad audio')
  })
})

describe('azure-fasttranscribe', () => {
  it('uploads multipart audio with the definition locales and reads phrases', async () => {
    const stub = fetchOf(200, JSON.stringify({
      durationMilliseconds: 1500,
      combinedPhrases: [{ channel: 0, text: '会议开始了' }],
      phrases: [
        { channel: 0, speaker: 1, offsetMilliseconds: 0, durationMilliseconds: 1500, text: '会议开始了' },
      ],
    }))
    const service = new HttpSpeechProvider({
      id: 'azure-test', endpoint: 'https://resource.example/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
      mode: 'azure-fasttranscribe', languages: ['auto', 'zh'],
      textField: 'text', maxAudioBytes: 25 * 1024 * 1024, maxDurationSeconds: 7200,
      timeoutMs: 1_000, resolveApiKey: async () => 'azure-key', doFetch: stub.doFetch,
    })
    const result = await service.transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    expect(result).toMatchObject({
      text: '会议开始了',
      segments: [{ text: '会议开始了', start: 0, end: 1.5, speaker: '1' }],
    })
    const headers = new Headers(stub.calls[0]?.init.headers)
    expect(headers.get('ocp-apim-subscription-key')).toBe('azure-key')
    const form = stub.calls[0]?.init.body as FormData
    expect((form.get('audio') as Blob).size).toBe(canonicalWav(1).byteLength)
    expect(JSON.parse(form.get('definition') as string)).toEqual({ locales: ['zh-CN'] })
  })

  it('omits locales for the auto hint and reports malformed answers', async () => {
    const stub = fetchOf(200, JSON.stringify({ combinedPhrases: [], phrases: [] }))
    const service = new HttpSpeechProvider({
      id: 'azure-test', endpoint: 'https://resource.example/transcribe', mode: 'azure-fasttranscribe',
      languages: ['auto'], textField: 'text', maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200, timeoutMs: 1_000, resolveApiKey: async () => 'k', doFetch: stub.doFetch,
    })
    await expect(service.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .resolves.toMatchObject({ text: '' })
    const form = stub.calls[0]?.init.body as FormData
    expect(JSON.parse(form.get('definition') as string)).toEqual({})
    const malformed = new Response('<html>', { status: 200 })
    expect(readAzureResult(malformed, 'azure')).rejects.toThrow('malformed JSON')
  })
})

describe('aws-transcribe', () => {
  /** One fake Amazon Transcribe flow with the requests it received. */
  function awsStub(jobStatuses: readonly string[], transcriptBody: string) {
    const calls: { readonly url: string; readonly init: RequestInit }[] = []
    let poll = 0
    const doFetch: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      const method = (init?.method as string | undefined) ?? 'GET'
      calls.push({ url: `${method} ${url}`, init: init ?? {} })
      if (method === 'PUT') return new Response('', { status: 200 })
      if (url.includes('transcribe.example')) {
        const raw = init?.body
        const body = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')) as
          { TranscriptionJobName: string }
        if ('TranscriptionJobName' in body && (init?.headers as Record<string, string>)?.['x-amz-target']?.includes('GetTranscriptionJob') === true) {
          const status = jobStatuses[Math.min(poll++, jobStatuses.length - 1)]!
          return new Response(JSON.stringify({
            TranscriptionJob: {
              TranscriptionJobName: body.TranscriptionJobName,
              TranscriptionJobStatus: status,
              ...(status === 'FAILED' ? { FailureReason: 'audio not supported' } : {}),
              ...(status === 'COMPLETED' ? { Transcript: { TranscriptFileUri: 'https://bucket-x.s3.us-east-1.amazonaws.com/prism-asr/out.json' } } : {}),
            },
          }), { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' } })
        }
        return new Response(JSON.stringify({
          TranscriptionJob: { TranscriptionJobName: body.TranscriptionJobName, TranscriptionJobStatus: 'IN_PROGRESS' },
        }), { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' } })
      }
      if (url.includes('out.json')) return new Response(transcriptBody, { status: 200 })
      return new Response('not found', { status: 404 })
    }
    return { doFetch, calls }
  }

  /** One provider pointed at the fake service. */
  function provider(doFetch: typeof fetch): HttpSpeechProvider {
    return new HttpSpeechProvider({
      id: 'aws-test', endpoint: 'https://transcribe.example/', mode: 'aws-transcribe',
      awsRegion: 'us-east-1', awsBucket: 'bucket-x', languages: ['auto', 'zh'],
      textField: 'text', maxAudioBytes: 25 * 1024 * 1024, maxDurationSeconds: 7200,
      timeoutMs: 5_000, pollIntervalMs: 1,
      resolveApiKey: async () => 'awsSecretExample', resolveSecretId: async () => 'AKIAexample',
      doFetch,
    })
  }

  it('uploads, starts, polls, and reads the transcript with a pinned signature', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_763_352_000_000)
    const stub = awsStub(['IN_PROGRESS', 'COMPLETED'],
      JSON.stringify({ status: 'COMPLETED', results: { transcripts: [{ transcript: 'recognized by aws' }] } }))
    const result = await provider(stub.doFetch).transcribe(
      { audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    expect(result).toMatchObject({ text: 'recognized by aws' })
    const [put, start, poll] = stub.calls
    const transcript = stub.calls[4]
    expect(put?.url).toBe('PUT https://s3.us-east-1.amazonaws.com/bucket-x/prism-asr/prism-asr-fixed-uuid.wav')
    const putHeaders = new Headers(put?.init.headers)
    expect(putHeaders.get('x-amz-content-sha256')).toBe(createHash('sha256').update(Buffer.from(canonicalWav(1))).digest('hex'))
    const startHeaders = new Headers(start?.init.headers)
    expect(startHeaders.get('x-amz-target')).toBe('Com.amazonawstranscribe.TranscribeService.StartTranscriptionJob')
    expect(startHeaders.get('authorization')).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAexample/20251117/us-east-1/transcribe/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date;x-amz-target, '
      + `Signature=${GOLDEN_AWS}`)
    const startRaw = start?.init.body
    const startBody = JSON.parse(typeof startRaw === 'string' ? startRaw : Buffer.from(startRaw as Uint8Array).toString('utf8')) as {
      TranscriptionJobName: string; LanguageCode: string
      Media: { MediaFileUri: string }; OutputBucketName: string
    }
    expect(startBody.TranscriptionJobName).toBe('prism-asr-fixed-uuid')
    expect(startBody.LanguageCode).toBe('zh-CN')
    expect(startBody.Media.MediaFileUri).toBe('s3://bucket-x/prism-asr/prism-asr-fixed-uuid.wav')
    expect(startBody.OutputBucketName).toBe('bucket-x')
    expect(new Headers(poll?.init.headers).get('x-amz-target')).toContain('GetTranscriptionJob')
    expect(transcript?.url).toBe('GET https://bucket-x.s3.us-east-1.amazonaws.com/prism-asr/out.json')
  })

  it('fails the job with its reason and turns on language identification for auto', async () => {
    const stub = awsStub(['FAILED'], '')
    await expect(provider(stub.doFetch).transcribe(
      { audio: canonicalWav(1), language: 'auto' }, new AbortController().signal,
    )).rejects.toThrow('task failed: audio not supported')
    const start = stub.calls.find(call => (call.init.headers as Record<string, string>)['x-amz-target']?.includes('StartTranscriptionJob'))
    const raw = start?.init.body
    expect(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')).IdentifyLanguage).toBe(true)
  })

  it('refuses to register an incomplete aws service', () => {
    expect(() => new HttpSpeechProvider({
      id: 'aws-broken', endpoint: 'https://transcribe.example/', mode: 'aws-transcribe',
      languages: ['auto'], textField: 'text', maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200, timeoutMs: 1_000, resolveApiKey: async () => 'k',
      resolveSecretId: async () => 'AKID', awsRegion: 'us-east-1',
    })).toThrow('must configure a region, a bucket, and an access key id')
  })

  it('loudly rejects an incomplete aws entry at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'a-bad', language: 'auto' })
      const mounted = ctx.plugin(Plugin, { services: [
        { providerId: 'a-bad', endpoint: 'https://transcribe.example/', apiKeyEnv: 'A_KEY', mode: 'aws-transcribe',
          secretId: 'AKIA', awsRegion: 'us-east-1' },
      ] })
      await expect(mounted).rejects.toThrow('must configure a region, a bucket, and an access key id')
    } finally { await ctx.fiber.dispose() }
  })
})
