/** Provider-specific request forms: Tencent TC3 signing, iFlytek job flow, Doubao flash. */

import { Context } from '@deepseek-ai/cordis'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'
import { HttpSpeechProvider } from '../src/provider.ts'
import { readTencentResult, tencentSentenceRequest } from '../src/tencent.ts'

/** Golden TC3 signature of the deterministic recording below, computed independently of the adapter. */
const GOLDEN_TC3 = '7fe50e1c58ee5cbbcd6b7ce943f4c4bc47f07ec63ee963461cdb95c73ca7c67c'

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

describe('tencent-sentence', () => {
  it('signs the documented TC3 credential for a fixed clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_763_352_000_000)
    const init = tencentSentenceRequest('AKIDexample', 'secret-example',
      { engineModel: '16k_zh', endpoint: 'https://asr.example/' },
      { audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    const headers = new Headers(init.headers)
    expect(headers.get('x-tc-action')).toBe('SentenceRecognition')
    expect(headers.get('x-tc-version')).toBe('2019-06-14')
    expect(headers.get('authorization')).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDexample/2025-11-17/asr/tc3_request, '
      + 'SignedHeaders=content-type;host;x-tc-action, '
      + `Signature=${GOLDEN_TC3}`,
    )
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.EngSerViceType).toBe('16k_zh')
    expect(body.SourceType).toBe(1)
    expect(body.DataLen).toBe(canonicalWav(1).byteLength)
  })

  it('reads the recognized text from the Response envelope', () => {
    expect(readTencentResult(JSON.stringify({ Response: { Result: '腾讯云语音识别欢迎您。', AudioDuration: 2430 } }), 'tencent'))
      .toBe('腾讯云语音识别欢迎您。')
    expect(() => readTencentResult(JSON.stringify({ Response: { Error: { Code: 'FailedOperation.ErrorRecognize', Message: '识别失败' } } }), 'tencent'))
      .toThrow('FailedOperation.ErrorRecognize: 识别失败')
    expect(() => readTencentResult(JSON.stringify({ Response: {} }), 'tencent'))
      .toThrow('without a "Response.Result" text')
  })

  it('recognizes through the registry with a resolved SecretId', async () => {
    const stub = fetchOf(200, JSON.stringify({ Response: { Result: 'recognized by tencent' } }))
    const service = new HttpSpeechProvider({
      id: 'tencent-test',
      endpoint: 'https://asr.example/',
      mode: 'tencent-sentence',
      engineModel: '16k_zh',
      languages: ['auto'],
      textField: 'text',
      maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200,
      timeoutMs: 1_000,
      resolveApiKey: async () => 'secret-key',
      resolveSecretId: async () => 'AKIDexample',
      doFetch: stub.doFetch,
    })
    const result = await service.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal)
    expect(result).toMatchObject({ text: 'recognized by tencent' })
    expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toContain('Credential=AKIDexample/')
  })

  it('refuses to register an incomplete tencent service', () => {
    expect(() => new HttpSpeechProvider({
      id: 'tencent-broken', endpoint: 'https://asr.example/', mode: 'tencent-sentence',
      languages: ['auto'], textField: 'text', maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200, timeoutMs: 1_000, resolveApiKey: async () => 'k',
    })).toThrow('must configure an engineModel and a SecretId')
  })
})

describe('xfyun-filetrans', () => {
  /** One fake lfasr service speaking the four-step flow, with the requests it received. */
  function lfasrStub(progresses: readonly number[]) {
    const calls: { readonly url: string; readonly init: RequestInit }[] = []
    let poll = 0
    const doFetch: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      calls.push({ url, init: init ?? {} })
      const respond = (payload: object): Response =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/api/prepare')) return respond({ ok: 0, data: 'task-1' })
      if (url.endsWith('/api/upload')) return respond({ ok: 0, data: '' })
      if (url.endsWith('/api/merge')) return respond({ ok: 0, data: '' })
      if (url.endsWith('/api/getProgress')) {
        const status = progresses[Math.min(poll++, progresses.length - 1)] ?? 9
        return respond({ ok: 0, data: JSON.stringify({ status }) })
      }
      if (url.endsWith('/api/getResult')) {
        return respond({ ok: 0, data: JSON.stringify([
          { bg: 0, ed: 1200, onebest: '你好', speaker: 1 },
          { bg: 1200, ed: 2500, onebest: '世界。', speaker: 2 },
        ]) })
      }
      return new Response('not found', { status: 404 })
    }
    return { doFetch, calls }
  }

  /** One provider pointed at the fake service. */
  function provider(doFetch: typeof fetch, overrides: Partial<ConstructorParameters<typeof HttpSpeechProvider>[0]> = {}):
  HttpSpeechProvider {
    return new HttpSpeechProvider({
      id: 'xfyun-test',
      endpoint: 'https://raas.example',
      mode: 'xfyun-filetrans',
      languages: ['auto', 'zh', 'en'],
      textField: 'text',
      maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200,
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      resolveApiKey: async () => 'secret-key',
      resolveAppId: async () => 'app-1',
      doFetch,
      ...overrides,
    })
  }

  it('prepares, uploads, merges, polls, and reads the sentence result', async () => {
    const stub = lfasrStub([3, 9])
    const result = await provider(stub.doFetch).transcribe(
      { audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    expect(result.text).toBe('你好世界。')
    expect(result.segments).toEqual([
      { text: '你好', start: 0, end: 1.2, speaker: '1' },
      { text: '世界。', start: 1.2, end: 2.5, speaker: '2' },
    ])
    const actions = stub.calls.map(call => call.url.split('/api/')[1])
    expect(actions).toEqual(['prepare', 'upload', 'merge', 'getProgress', 'getProgress', 'getResult'])
    const prepare = new URLSearchParams(stub.calls[0]?.init.body as string)
    expect(prepare.get('app_id')).toBe('app-1')
    expect(prepare.get('file_len')).toBe(String(canonicalWav(1).byteLength))
    expect(prepare.get('language')).toBe('cn')
    expect(prepare.get('signa')).toBeTruthy()
    const uploadForm = stub.calls[1]?.init.body as FormData
    expect(uploadForm.get('task_id')).toBe('task-1')
    expect(uploadForm.get('slice_id')).toBe('aaaaaaaaaa')
    expect((uploadForm.get('content') as Blob).size).toBe(canonicalWav(1).byteLength)
  })

  it('fails the task when the service reports a settled failure status', async () => {
    const stub = lfasrStub([6])
    await expect(provider(stub.doFetch).transcribe(
      { audio: canonicalWav(1), language: 'auto' }, new AbortController().signal,
    )).rejects.toThrow('task failed with status 6')
  })

  it('refuses to register an incomplete xfyun service', () => {
    expect(() => new HttpSpeechProvider({
      id: 'xfyun-broken', endpoint: 'https://raas.example', mode: 'xfyun-filetrans',
      languages: ['auto'], textField: 'text', maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200, timeoutMs: 1_000, resolveApiKey: async () => 'k',
    })).toThrow('must configure an AppId')
  })
})

describe('volcano-flash', () => {
  it('sends base64 audio with the documented headers and reads utterance segments', async () => {
    const stub = fetchOf(200, JSON.stringify({
      result: {
        text: '会议开始了',
        utterances: [{ text: '会议开始了', start_time: 0, end_time: 1500 }],
      },
      audio_info: { duration: 1500 },
    }), { 'x-api-status-code': '20000000' })
    const service = new HttpSpeechProvider({
      id: 'volcano-test',
      endpoint: 'https://openspeech.example/api/v3/auc/bigmodel/recognize/flash',
      mode: 'volcano-flash',
      languages: ['auto', 'zh'],
      textField: 'text',
      maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200,
      timeoutMs: 1_000,
      resolveApiKey: async () => 'flash-key',
      doFetch: stub.doFetch,
    })
    const result = await service.transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal)
    expect(result).toMatchObject({
      text: '会议开始了',
      segments: [{ text: '会议开始了', start: 0, end: 1.5 }],
    })
    const headers = new Headers(stub.calls[0]?.init.headers)
    expect(headers.get('x-api-key')).toBe('flash-key')
    expect(headers.get('x-api-resource-id')).toBe('volc.bigasr.auc_turbo')
    expect(headers.get('x-api-sequence')).toBe('-1')
    const body = JSON.parse(stub.calls[0]?.init.body as string) as { audio: { data: string; format: string; language?: string } }
    expect(body.audio.format).toBe('wav')
    expect(body.audio.language).toBe('zh-CN')
    expect(body.audio.data).toBe(Buffer.from(canonicalWav(1)).toString('base64'))
  })

  it('answers silence as the no-speech transcript and rejects failures by status header', async () => {
    const silent = fetchOf(200, '', { 'x-api-status-code': '20000003' })
    const service = new HttpSpeechProvider({
      id: 'volcano-test', endpoint: 'https://openspeech.example/flash', mode: 'volcano-flash',
      languages: ['auto'], textField: 'text', maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200, timeoutMs: 1_000, resolveApiKey: async () => 'k', doFetch: silent.doFetch,
    })
    await expect(service.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .resolves.toMatchObject({ text: '' })
    const failed = fetchOf(200, '', { 'x-api-status-code': '45000001', 'x-api-message': 'invalid parameter' })
    const broken = new HttpSpeechProvider({
      id: 'volcano-test', endpoint: 'https://openspeech.example/flash', mode: 'volcano-flash',
      languages: ['auto'], textField: 'text', maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 7200, timeoutMs: 1_000, resolveApiKey: async () => 'k', doFetch: failed.doFetch,
    })
    await expect(broken.transcribe({ audio: canonicalWav(1), language: 'auto' }, new AbortController().signal))
      .rejects.toThrow('answered 45000001: invalid parameter')
  })
})

describe('flavor configuration', () => {
  it('loudly rejects an incomplete tencent-sentence entry at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 't-bad', language: 'auto' })
      const mounted = ctx.plugin(Plugin, { services: [
        { providerId: 't-bad', endpoint: 'https://asr.example/', apiKeyEnv: 'T_KEY', mode: 'tencent-sentence' },
      ] })
      await expect(mounted).rejects.toThrow('must configure a SecretId')
    } finally { await ctx.fiber.dispose() }
  })

  it('loudly rejects an incomplete xfyun entry at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'x-bad', language: 'auto' })
      const mounted = ctx.plugin(Plugin, { services: [
        { providerId: 'x-bad', endpoint: 'https://raas.example', apiKeyEnv: 'X_KEY', mode: 'xfyun-filetrans' },
      ] })
      await expect(mounted).rejects.toThrow('must configure an AppId')
    } finally { await ctx.fiber.dispose() }
  })

  it('registers a tencent service with a credential-referenced SecretId', async () => {
    const stub = fetchOf(200, JSON.stringify({ Response: { Result: 'from config' } }))
    vi.stubGlobal('fetch', stub.doFetch)
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 't-ok', language: 'auto' })
      const fiber = await ctx.plugin(Plugin, { services: [
        { providerId: 't-ok', endpoint: 'https://asr.example/', apiKey: 't-key', apiKeyEnv: 'T_KEY', mode: 'tencent-sentence',
          secretId: 'AKIDfrom-config', engineModel: '16k_zh' },
      ] })
      expect(ctx.speechToText.listProviders()).toEqual([{
        id: brandId('t-ok'), name: 't-ok', location: 'cloud', languages: ['auto'], maxAudioSeconds: 60,
      }])
      const spec = ctx.speechToText.resolve({ audio: canonicalWav(1) })
      await expect(ctx.speechToText.transcribe(spec, new AbortController().signal))
        .resolves.toMatchObject({ text: 'from config' })
      await fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })
})

/** Brand one provider id the way the registry does. */
function brandId(id: string): SpeechProviderId {
  return id as SpeechProviderId
}
