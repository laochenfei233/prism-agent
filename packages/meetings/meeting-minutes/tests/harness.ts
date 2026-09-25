/** Shared meeting-minutes service test harness with memory storage and stubbed speech/model routes. */

import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SpeechToText from '@deepseek-ai/dsh-speech-to-text'
import type { SpeechProvider, SpeechProviderId } from '@deepseek-ai/dsh-speech-to-text'
import {
  LlmAdapter, LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import MeetingMinutesService from '../src/index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

/** One observed hand-built model request reduced to the fields this service controls. */
export interface ObservedModelRequest {
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly prompt: string
  readonly signal?: AbortSignal
}

/** One queued model response factory; it receives the dispatched request. */
type ResponseFactory = (request: GenerateOptions) => AsyncIterable<StreamChunk>

/** A queued hanging model response that a test resolves or that cancellation rejects. */
export class ModelGate {
  /** Releases the model call with a successful empty stream. */
  readonly released: Promise<void>

  private readonly release: () => void

  constructor() {
    let release: () => void
    this.released = new Promise<void>((resolve) => { release = resolve })
    this.release = release!
  }

  /** Open the gate; the stream then reports a successful stop. */
  open(): void {
    this.release()
  }
}

/** Deterministic adapter for the single meeting provider/model route. */
export class MeetingLlmAdapter extends LlmAdapter {
  /** Requests in dispatch order. */
  readonly requests: ObservedModelRequest[] = []

  private readonly responses: ResponseFactory[] = []

  /** Queue a successful visible-text response. */
  queueText(text: string): void {
    this.responses.push(async function* queuedText(options) {
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
  }

  /** Queue a terminal model failure carrying the supplied message. */
  queueFailure(message: string): void {
    this.responses.push(async function* queuedFailure() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'TEST_FAILURE' } } }
    })
  }

  /** Queue a call that remains pending until opened, caller cancellation, or service disposal. */
  queueGate(): ModelGate {
    const gate = new ModelGate()
    this.responses.push(async function* queuedGate(options) {
      const signal = options.signal
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new Error(signal?.reason instanceof Error ? signal.reason.message : 'model call cancelled'))
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        void gate.released.then(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: 'released' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    return gate
  }

  /** Bind the exact test route directly to its queued response. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (signal?.aborted) throw new Error(signal.reason instanceof Error ? signal.reason.message : 'model preparation cancelled')
    const resolved: LlmResolvedModelInfo = { provider, id: model, name: model }
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.dispatch(options),
    }
  }

  /** Required adapter entry point; meeting calls normally use prepareCall. */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.dispatch(options)
  }

  /** Consume one queued response and record the request exactly once. */
  private dispatch(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = this.responses.shift()
    if (response === undefined) throw new Error('no queued model response')
    this.requests.push({
      provider: options.provider,
      model: options.model,
      ...(options.system === undefined ? {} : { system: options.system }),
      prompt: userText(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return response(options)
  }
}

/** Extract the one user text block sent by the service. */
function userText(options: GenerateOptions): string {
  const [message] = options.messages
  if (message === undefined || message.role !== 'user') throw new Error('meeting service sent no user message')
  const [block] = message.content
  if (block === undefined || block.type !== 'text') throw new Error('meeting service sent no text block')
  return block.text
}

/** Complete test composition inputs and observations. */
export interface MeetingHarness {
  readonly ctx: Context
  readonly service: MeetingMinutesService
  readonly llm: MeetingLlmAdapter
  readonly recognize: ReturnType<typeof makeRecognize>
  readonly pool: MemoryMediaPool
}

/** Construct a deterministic provider observation recorder. */
function makeRecognize() {
  return vi.fn(async (input: { audio: Uint8Array; language: string }, signal: AbortSignal) => {
    signal.throwIfAborted()
    return {
      text: `recognized ${input.language} ${input.audio.byteLength}`,
      audioSeconds: 12.5,
      inferenceSeconds: 0.25,
    }
  })
}

/** Activate memory storage, speech, and LLM routes, then the meeting service. */
export async function harness(options?: {
  /** Reuse durable media from a prior disposed composition. */
  pool?: MemoryMediaPool
  /** Overrides the test model bound. */
  maxTranscriptChars?: number
}): Promise<MeetingHarness> {
  const ctx = new Context()
  roots.push(ctx)
  const pool = options?.pool ?? new MemoryMediaPool()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const providerId = brandString<SpeechProviderId>('meeting-test')
  const speech = new SpeechToText(ctx, SpeechToText.Config({ defaultProvider: providerId, language: 'auto' }))
  const recognize = makeRecognize()
  const provider: SpeechProvider = {
    info: { id: providerId, name: 'Meeting test', location: 'host-local', languages: ['auto', 'zh'] },
    transcribe: recognize,
  }
  speech.register(provider)
  const llm = new MeetingLlmAdapter()
  const runtime = new LlmRuntime(ctx)
  runtime.registerAdapter(['meeting-provider'], llm)
  const serviceFiber = ctx.plugin(MeetingMinutesService, {
    summaryProvider: 'meeting-provider',
    summaryModel: 'meeting-model',
    summarySystemPrompt: 'summarize meetings',
    answerSystemPrompt: 'answer meeting questions',
    maxTranscriptChars: options?.maxTranscriptChars ?? 100,
  })
  await serviceFiber
  const service = ctx.meetingMinutes
  llm.requests.length = 0
  return { ctx, service, llm, recognize, pool }
}

/** Active contexts disposed after each test. */
const roots: Context[] = []

/** Dispose every context created by the harness. */
export async function disposeRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
}
