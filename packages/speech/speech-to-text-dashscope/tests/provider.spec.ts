/** Provider registration lifetime and duplex recognition behavior without network access. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SpeechToText from '@deepseek-ai/dsh-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-speech-to-text/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashScopeSpeechProvider } from '../src/provider.ts'
import * as Provider from '../src/index.ts'

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

/** Controlled WebSocket double that answers run-task/finish-task and records all sends. */
class ScriptedWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: ScriptedWebSocket[] = []
  static responseAfterRun = '{"header":{"event":"task-started"}}'
  static resultsAfterFinish: string[] = []
  readonly readyState = ScriptedWebSocket.OPEN
  readonly bufferedAmount = 0
  readonly sent: Array<string | ArrayBuffer> = []
  readonly url: string

  constructor(url: string) {
    super()
    this.url = url
    ScriptedWebSocket.instances.push(this)
    queueMicrotask(() => { this.dispatchEvent(new Event('open')) })
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const outgoing = typeof data === 'string' ? data : new ArrayBuffer(0)
    this.sent.push(outgoing)
    if (typeof outgoing !== 'string') return
    const frame = JSON.parse(outgoing) as { header?: { action?: string } }
    if (frame.header?.action === 'run-task') this.receive(ScriptedWebSocket.responseAfterRun)
    if (frame.header?.action === 'finish-task') {
      for (const raw of ScriptedWebSocket.resultsAfterFinish) this.receive(raw)
      this.receive('{"header":{"event":"task-finished"}}')
    }
  }

  close(): void {
    this.dispatchEvent(new Event('close'))
  }

  private receive(raw: string): void {
    queueMicrotask(() => { this.dispatchEvent(new MessageEvent('message', { data: raw })) })
  }
}

function provider(resolveApiKey: () => Promise<string | undefined>): DashScopeSpeechProvider {
  return new DashScopeSpeechProvider({
    id: brandString<SpeechProviderId>('dashscope-funasr'),
    name: 'DashScope test', url: 'wss://dashscope.example/inference', model: 'fun-asr-realtime',
    languages: ['zh'], speakerDiarization: true, maxDurationSeconds: 60,
    timeoutMs: 1_000, drainTimeoutMs: 1_000, resolveApiKey,
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('DashScope provider registration', () => {
  it('registers through ctx.speechToText and withdraws the provider when its plugin unloads', async () => {
    vi.stubGlobal('WebSocket', ScriptedWebSocket)
    ScriptedWebSocket.resultsAfterFinish = [JSON.stringify({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: 'meeting started', sentence_end: true } } },
    })]
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'dashscope-funasr', language: 'zh' })
      const fiber = ctx.plugin(Provider, { apiKey: 'secret', url: 'wss://dashscope.example/inference' })
      await fiber
      expect(ctx.speechToText.listProviders()).toEqual([{
        id: 'dashscope-funasr', name: 'DashScope fun-asr-realtime', location: 'cloud', languages: ['zh'],
      }])
      const audio = canonicalWav(1)
      const result = await ctx.speechToText.transcribe(ctx.speechToText.resolve({ audio }), new AbortController().signal)
      expect(result).toMatchObject({ text: 'meeting started', audioSeconds: 1 })
      const socket = ScriptedWebSocket.instances[0]!
      expect(socket.url).toBe('wss://dashscope.example/inference?authorization=Bearer+secret')
      expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
        header: { action: 'run-task', streaming: 'duplex' },
        payload: { model: 'fun-asr-realtime', parameters: { format: 'pcm', sample_rate: 16_000 } },
      })
      expect(socket.sent.at(-2)).toBeInstanceOf(ArrayBuffer)
      expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({ header: { action: 'finish-task' } })
      await fiber.dispose()
      expect(ctx.speechToText.listProviders()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})

describe('DashScope recognition behavior', () => {
  it('fails loudly when no key is resolvable', async () => {
    await expect(provider(async () => undefined).transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('DashScope recognition requires an API key')
  })

  it('rejects non-canonical audio before contacting the provider', async () => {
    await expect(provider(async () => 'secret').transcribe({ audio: new Uint8Array([1]), language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('Audio must be a canonical 16 kHz mono PCM16 WAV recording')
  })

  it('turns a malformed service frame into a recognition protocol failure', async () => {
    vi.stubGlobal('WebSocket', ScriptedWebSocket)
    ScriptedWebSocket.responseAfterRun = '{'
    await expect(provider(async () => 'secret').transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('Recognition frame is not JSON')
  })

  it('reports a task failure using the service message', async () => {
    vi.stubGlobal('WebSocket', ScriptedWebSocket)
    ScriptedWebSocket.responseAfterRun = '{"header":{"event":"task-failed","error_message":"quota exceeded"}}'
    await expect(provider(async () => 'secret').transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('DashScope recognition failed: quota exceeded')
  })

  it('reports a connection failure before the task starts', async () => {
    class FailingWebSocket extends EventTarget {
      readonly readyState = ScriptedWebSocket.CLOSED
      readonly bufferedAmount = 0
      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('error'))
          this.dispatchEvent(new Event('close'))
        })
      }
      send(): void { throw new Error('The failed connection must not send audio') }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FailingWebSocket)
    await expect(provider(async () => 'secret').transcribe({ audio: canonicalWav(1), language: 'zh' }, new AbortController().signal))
      .rejects.toThrow('The recognition connection failed: DashScope recognition connection failed')
  })
})
