/** Provider-neutral speech transcription inputs and registration metadata. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Configured identity of one transcription provider. */
export type SpeechProviderId = Branded<'SpeechProviderId'>

/** Provider-specific planning estimates, not measured progress or guaranteed resource limits. */
export interface SpeechSetupEstimate {
  readonly recommendedDiskBytes: number
  readonly expectedMemoryBytes: number
  readonly minimumMinutes: number
  readonly maximumMinutes: number
}

/** Public provider facts; credentials and filesystem paths are excluded. */
export interface SpeechProviderInfo {
  readonly id: SpeechProviderId
  readonly name: string
  readonly location: 'host-local' | 'cloud'
  /** Accepted language hints, including automatic detection when supported. */
  readonly languages: readonly string[]
  /** Model this recognizer runs when the selection names none; absent when it names no model. */
  readonly model?: string
  /** Models this recognizer can run, in deployment order; absent when the deployment fixes one. */
  readonly models?: readonly string[]
  readonly setupEstimate?: SpeechSetupEstimate
  /** Origins offered for an explicit preparation download; omitted or empty when no choice applies. */
  readonly downloadSources?: readonly string[]
}

/** Ordered resource-preparation operations understood by the speech UI. Providers omit operations they do not need. */
export type SpeechPreparationStepKind = 'check' | 'model' | 'vad' | 'verify' | 'load'

/** One Host-owned operation; only its running state has a live elapsed clock. */
export interface SpeechPreparationStep {
  readonly kind: SpeechPreparationStepKind
  readonly status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
  readonly startedAt?: number
}

/** Safe download diagnostics for localized preparation guidance; URLs omit credentials and query strings. */
export interface SpeechDownloadFailure {
  readonly resource: string
  readonly source: string
  readonly reason: 'network' | 'dns' | 'timeout' | 'certificate' | 'http' | 'integrity' | 'storage' | 'unknown'
  readonly code?: string
  readonly status?: number
}

/** Host-owned preparation state; byte totals describe downloads, never estimated installation percentages. */
export type SpeechPreparationState = (
  | { readonly phase: 'unprepared' | 'ready' | 'standby' | 'cancelled' }
  | { readonly phase: 'downloading'; readonly resource: string; readonly completedBytes: number; readonly totalBytes?: number }
  | { readonly phase: 'checking' | 'loading' | 'waking' | 'cancelling'; readonly startedAt: number }
  | { readonly phase: 'failed'; readonly message: string; readonly download?: SpeechDownloadFailure }
) & {
  readonly step?: SpeechPreparationStepKind
  readonly steps?: readonly SpeechPreparationStep[]
}

/** Provider facts and its current resource readiness; independent of plugin activation. */
export interface SpeechProviderView extends SpeechProviderInfo {
  readonly preparation: SpeechPreparationState
  /** Live recognition this provider offers; absent when it accepts complete recordings only. */
  readonly streaming?: SpeechStreamingMode
}

/** Host-persisted default selection captured when a recording starts. */
export interface SpeechSelection {
  readonly providerId: SpeechProviderId
  readonly language: string
  /** Model the selected recognizer runs; absent leaves the recognizer's own configured default. */
  readonly model?: string
}

/** User intent updates only the preference fields explicitly changed. */
export interface SpeechSelectionPatch {
  readonly providerId?: SpeechProviderId
  readonly language?: string
  /** @see SpeechSelection.model */
  readonly model?: string
}

/** One consistent provider roster and default-selection observation. */
export interface SpeechSnapshot {
  readonly providers: readonly SpeechProviderView[]
  readonly selection: SpeechSelection
}

/** Download choice for one preparation task; omission keeps the provider's configured selection policy. */
export interface SpeechPreparationOptions {
  /** One advertised origin; providers reject unavailable sources and use a manual choice without fallback. */
  readonly downloadSource?: string
}

/** Optional resource preparation controls. Providers without them are immediately usable. */
export interface SpeechPreparation {
  /** @returns the latest Host-owned state. */
  snapshot(): SpeechPreparationState
  /** @param listener - state invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void
  /**
   * Start or join the current preparation task; page and transport lifetimes do not own it.
   * @param options - task-local download selection; providers reject changing the source of active work.
   */
  prepare(options?: SpeechPreparationOptions): void
  /** Cancel preparation. @returns after its resources settle. */
  cancel(): Promise<void>
}

/** Complete audio recording and an explicit language hint. */
export interface SpeechInput {
  readonly audio: Uint8Array
  readonly language: string
  /** Model this call runs; absent leaves the recognizer's own configured default. */
  readonly model?: string
}

/** One recognized span of audio attributed to a speaker. */
export interface SpeechSegment {
  readonly text: string
  /** Service-assigned speaker label; absent when the recognizer separates no speakers. */
  readonly speaker?: string
  /** Offset from the beginning of the recognized audio, in seconds; absent when the recognizer reports no timing. */
  readonly start?: number
  /** Offset at which this span ends, in seconds; absent when the recognizer reports no timing. */
  readonly end?: number
}

/** Final transcription; an empty string means no speech was recognized. */
export interface Transcript {
  readonly text: string
  readonly audioSeconds: number
  readonly inferenceSeconds: number
  /** Speaker-attributed spans in service order; absent when the recognizer separates no speakers. */
  readonly segments?: readonly SpeechSegment[]
}

/** How much of one recognition a provider streams. */
export type SpeechStreamingMode = 'duplex' | 'incremental-output'

/** One update from a live recognition session. */
export type SpeechStreamUpdate =
  /** Text for one span that is still open; a later partial under the same id replaces this text. */
  | { readonly kind: 'partial'; readonly id: string; readonly text: string; readonly speaker?: string }
  /** One span the recognizer closed; its segment is no longer revised. */
  | { readonly kind: 'segment'; readonly id: string; readonly segment: SpeechSegment }
  /** The session settled; `transcript.segments` holds every closed span in service order. */
  | { readonly kind: 'final'; readonly transcript: Transcript }

/** Language selection one live session opens with. */
export interface SpeechStreamInput {
  readonly language: string
  /** Model this session runs; absent leaves the recognizer's own configured default. */
  readonly model?: string
}

/**
 * One live recognition session. Audio arrives in order through {@link SpeechStream.push};
 * attributed text arrives through {@link SpeechStream.events}, which a caller may observe
 * more than once and abandon without ending the session.
 */
export interface SpeechStream {
  /**
   * Append one chunk of the session's audio, in submission order.
   * @param chunk - canonical PCM16 samples without a container header.
   * @returns after the provider accepted the chunk, so a live source can apply backpressure.
   */
  push(chunk: Uint8Array): Promise<void>
  /**
   * Declare that no further audio follows.
   * @returns after the provider drained the session and delivered its final update.
   */
  close(): Promise<void>
  /**
   * Abandon the session; observed updates stop without a final one.
   * @returns after the provider released its transport.
   */
  cancel(): Promise<void>
  /**
   * Observe updates until the session settles.
   * @param signal - observer cancellation, which does not end the session.
   * @returns partials, closed spans, and one final update.
   */
  events(signal: AbortSignal): AsyncIterable<SpeechStreamUpdate>
}

/** Live recognition a provider may offer; an absent capability means complete recordings only. */
export interface SpeechStreaming {
  /** How much of one recognition this provider streams. */
  readonly mode: SpeechStreamingMode
  /**
   * Open one live session.
   * @param input - language the session recognizes.
   * @param signal - session cancellation, which releases the provider's transport.
   * @returns the open session, already accepting audio.
   */
  open(input: SpeechStreamInput, signal: AbortSignal): Promise<SpeechStream>
}

/** One replaceable recognizer. It owns preparation, execution, and cancellation. */
export interface SpeechProvider {
  readonly info: SpeechProviderInfo
  readonly preparation?: SpeechPreparation
  /** Live recognition; absent when the provider accepts complete recordings only. */
  readonly streaming?: SpeechStreaming
  /**
   * Recognize one complete recording without submitting an Agent message.
   * @param input - WAV bytes and language, borrowed until settlement.
   * @param signal - caller or registration cancellation; rejection follows resource cleanup.
   * @returns final text and measured audio/inference durations.
   */
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>
}

/** Caller selection of a live session before composition defaults are resolved. */
export interface SpeechStreamRequest {
  readonly providerId?: SpeechProviderId
  readonly language?: string
  readonly model?: string
}

/** Resolved selection pins the exact registered provider and the live capability it offers. */
export interface SpeechStreamSpec extends SpeechStreamInput {
  readonly provider: SpeechProvider
  readonly streaming: SpeechStreaming
}

/** Caller selection before composition defaults are resolved. */
export interface SpeechRequest {
  readonly audio: Uint8Array
  readonly providerId?: SpeechProviderId
  readonly language?: string
  readonly model?: string
}

/** Resolved selection pins the exact registered provider, including its lifetime. */
export interface SpeechSpec extends SpeechInput {
  readonly provider: SpeechProvider
}
