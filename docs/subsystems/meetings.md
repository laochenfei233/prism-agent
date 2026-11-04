# Meetings

English | [中文](meetings.zh.md)

The meetings capability owns durable meeting records and their dependent answers outside Session logs. [`ctx.meetingMinutes`](#ctxmeetingminutes--meetingminutesservice) imports complete transcripts or recordings, invokes one deployment-configured LLM route for summaries and questions, and stores successful output. Model access is limited by the explicit tool consumer to selected operations.

Source: [`packages/prism/prism-meeting/src/types.ts`](../../packages/prism/prism-meeting/src/types.ts)

## Meeting and answer vocabulary

```ts type-equiv
/** Identifies one durable meeting record. */
type MeetingMinutesId = Branded<'MeetingMinutesId'>
```

```ts type-equiv
/** Identifies one durable question/answer exchange for one meeting. */
type MeetingAnswerId = Branded<'MeetingAnswerId'>
```

```ts type-equiv
/**
 * Lifecycle of one durable meeting record. `recording` is a microphone the
 * caller still holds open, so its transcript is a leading fragment; everything
 * else reads a complete transcript. It does not track the transient in-flight
 * summary model call.
 */
type MeetingMinutesStatus = 'recording' | 'transcribed' | 'summarized'
```

```ts type-equiv
/** One recognized span of a meeting recording, with the speaker its provider attributed it to. */
interface MeetingTranscriptSegment {
  /** Verbatim recognized text of this span, without any speaker prefix. */
  readonly text: string
  /**
   * Provider-assigned speaker label, meaningful only within this one recording.
   * Absent when the provider recognizes no speakers.
   */
  readonly speaker?: string | undefined
}
```

```ts type-equiv
/** One durable meeting record, including its source transcript and latest summary. */
interface MeetingMinutesRecord {
  readonly id: MeetingMinutesId
  readonly title: string
  /** Ordered participant display names; names are normalized but not identities. */
  readonly participants: readonly string[]
  readonly transcript: string
  /**
   * Speaker-attributed spans of `transcript`, in recognition order. Absent for
   * a text import and for any meeting whose recognition reported no speakers.
   */
  readonly transcriptSegments?: readonly MeetingTranscriptSegment[] | undefined
  readonly summary: string | null
  readonly status: MeetingMinutesStatus
  readonly audioSeconds: number
  readonly createdAt: string
  readonly updatedAt: string
}
```

```ts type-equiv
/** One durable answer to a question about one meeting. */
interface MeetingAnswerRecord {
  readonly id: MeetingAnswerId
  readonly meetingId: MeetingMinutesId
  readonly question: string
  readonly answer: string
  readonly createdAt: string
}
```

## Request vocabulary

```ts type-equiv
/** Caller input for creating a meeting from already-available text. */
interface CreateMeetingFromTranscriptRequest {
  readonly title: string
  readonly participants?: readonly string[]
  readonly transcript: string
  /** Speaker-attributed spans of `transcript`; omission stores no speaker labels. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Recognized-audio duration; a text import may supply zero. */
  readonly audioSeconds?: number
}
```

```ts type-equiv
/** Caller input for creating a meeting by running one complete recording through speech recognition. */
interface CreateMeetingFromAudioRequest {
  readonly title: string
  readonly participants?: readonly string[]
  readonly audio: Uint8Array
  /** Speech-provider language hint; omission uses the speech plugin's selection. */
  readonly language?: string
  /** Speech-provider id; omission uses the speech plugin's selection. */
  readonly providerId?: string
}
```

```ts type-equiv
/** Caller input for opening one durable recording before any transcript exists. */
interface BeginMeetingRecordingRequest {
  readonly title: string
  readonly participants?: readonly string[]
}
```

```ts type-equiv
/**
 * Caller input replacing the transcript one open recording has produced so far.
 * The caller owns recognition and sends the complete text, so no append ordering
 * survives a dropped request.
 */
interface UpdateMeetingRecordingRequest {
  /** Complete transcript recognized from the recording so far; empty before the first slice. */
  readonly transcript: string
  /** Speaker-attributed spans of `transcript`; omission stores no speaker labels. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Recognized-audio duration of that recording. */
  readonly audioSeconds: number
}
```

```ts type-equiv
/** Caller input closing one open recording with the transcript of its complete recording. */
interface FinishMeetingRecordingRequest {
  /** Complete transcript of the whole recording; empty when recognition produced none. */
  readonly transcript: string
  /** Speaker-attributed spans of `transcript`; omission stores no speaker labels. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Complete recognized-audio duration, or the recorded elapsed seconds when recognition failed. */
  readonly audioSeconds: number
}
```

```ts type-equiv
/** Caller input revising the operator-editable fields of any stored meeting. */
interface ReviseMeetingMinutesRequest {
  readonly title?: string
  readonly participants?: readonly string[]
}
```

```ts type-equiv
/** Caller input for one persisted question/answer exchange. */
interface AskMeetingMinutesRequest {
  readonly question: string
}
```

## Recognition vocabulary

```ts type-equiv
/** Recognized text of one complete recording, before any durable write. */
interface MeetingTranscript {
  readonly text: string
  /** Speaker-attributed spans of `text`; absent when the provider reports no speakers. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Recognized-audio duration reported by the speech provider. */
  readonly audioSeconds: number
}
```

```ts type-equiv
/** One speech provider this deployment can transcribe with. */
interface MeetingSpeechProvider {
  readonly id: string
  readonly name: string
  /** Provider resource readiness; a provider that needs no download transcribes while unprepared. */
  readonly phase: string
  /** Preparation progress beyond the phase; absent when the provider has no preparation control or reports nothing extra. */
  readonly preparation?: MeetingSpeechPreparation
}
```

```ts type-equiv
/** JSON-safe preparation progress a browser caller renders. */
interface MeetingSpeechPreparation {
  /** Preparation phase as the provider reports it. */
  readonly phase: string
  /** Failure message; present when the phase is `failed`. */
  readonly message?: string
  /** Name of the resource being downloaded; present while the phase is `downloading`. */
  readonly resource?: string
  /** Byte count already downloaded of `resource`. */
  readonly completedBytes?: number
  /** Known total byte count of `resource`; absent while unknown. */
  readonly totalBytes?: number
}
```

```ts type-equiv
/** Speech availability a browser caller reads before it offers recording. */
interface MeetingSpeechStatus {
  readonly providers: readonly MeetingSpeechProvider[]
  /** Provider a transcription without an explicit selection uses. */
  readonly selected: string
}
```

## Durable storage

The `meeting_minutes` domain is version 2 and has separate `meetings` and `answers` tables. A record exists from the moment its microphone opens: `beginRecording` writes it with an empty transcript and the `recording` status, `updateRecording` replaces that transcript with the recognized text so far, and `finishRecording` closes it as `transcribed`. `summarize` and `ask` refuse a meeting that is still recording, because a leading fragment is not a meeting to read. Stored records carry a service-owned monotonic sequence; detached public records omit that internal ordering field. Deleting a meeting deletes its dependent answers first.

## Service semantics

`list`, `get`, and `listAnswers` read detached records; `get` and `listAnswers` fail with `MeetingMinutesNotFoundError` for an absent meeting. `beginRecording`, `updateRecording`, `finishRecording`, `reviseMeeting`, `summarize`, `ask`, and `delete` serialize behind prior mutations. `updateRecording` and `finishRecording` fail unless the meeting is still recording, and `summarize` and `ask` fail while it is, so a leading transcript fragment never reaches a model. `delete` removes dependent answers before the meeting. Every asynchronous operation joins service disposal and honors its cancellation signal. No runtime invariant companion is published because the service owns the only independent observation of mutation order and dependent-record deletion.

## Speech recognition

`transcribe` resolves the deployment's registered provider through `ctx.speechToText.resolve` and executes exactly that provider; no fallback sends audio elsewhere. A caller may pin a provider id and a language; omission uses the speech plugin's own selection. Recognition accepts one canonical 16 kHz mono PCM16 WAV recording per call, rejects a recording longer than the provider's bound, and reports the recognized text with its audio duration. `speech` reports the registered providers, the current selection, and each provider's preparation progress, so a browser caller can say that recording will produce no transcript before it asks for a microphone.

A provider with a preparation control is held to a transcribable state first: `transcribe` starts its preparation when it is unprepared, failed, or cancelled, joins an in-flight preparation otherwise, and rejects with the provider's failure message when that preparation fails or is cancelled; the wait honors the caller's cancellation signal, so a model download is bounded by the request rather than a hidden timeout. `prepareSpeech` starts or joins the selected provider's preparation without a recording, `cancelSpeechPreparation` cancels it, and both answer the fresh speech status. A provider without a preparation control transcribes unchanged.

A provider that separates speakers also returns `Transcript.segments`: one entry per closed span, each carrying its verbatim text and the speaker label the provider assigned. `transcript` is those texts joined by a newline, so a consumer that only needs readable text never reads the spans. A meeting stores them as `transcriptSegments`, and the owning operation rejects spans that do not reconstruct the transcript, so the record never holds two disagreeing forms of one recognition. Speaker labels are per recording: `1` in one meeting and `1` in another are unrelated, and a provider that separates no speakers simply omits the field.

## Browser interface

The `./web` entry registers one exact Fetch route per operation on Connection's shared `/api` channel — `/api/prism-meeting/list`, `get`, `create`, `begin`, `update`, `finish`, `revise`, `summarize`, `delete`, `speech`, `speech/prepare`, `speech/cancel`, `ask`, `answers`, `transcribe`, and `audio`. Every call passes that channel's browser trust and authentication fence, and every answer carries the same `{ ok, value }` or `{ ok, error }` envelope. A JSON route validates its body before the service sees it; `transcribe` and `audio` take raw recording bytes, and `audio` reads title, participants, language, and provider selection from its query. Each operation delegates to `ctx.meetingMinutes`, so the page runs the deployment's configured model route rather than a second one. These are routes rather than a plugin-registered RPC channel because `HostConnectionService` builds a channel through its own context, which does not inject `webServer`, so `ctx.connection.rpc.handle()` fails at load.

The `./client` entry registers one `sidebar.panellist` entry and the keyed `main` panel that entry selects. The page lists stored meetings, filters them, shows one meeting's summary, transcript, and persisted answers, edits its title and participants, deletes a record, and pushes a question into a new Session through `ctx.sessions` and `ctx.uiWorkspace`. The answers tab asks the configured model route about the open meeting and lists the stored exchanges newest first. "start meeting" opens the microphone and then its durable record, so the running meeting is a list row read in the same detail column as every stored one: captured audio is transcribed every eight seconds, each answer replaces the stored transcript, and the column offers pause, end, and discard. Ending re-transcribes the complete recording and closes the record in one step; a record an earlier session left recording is offered for closing. A refused microphone reports the setting that grants it, a refused record creation releases the microphone, and a deployment without a speech provider says so on the page. A registered provider that is not ready carries a preparation bar with a start action, its download progress, and a cancel action, so the operator readies a local model without leaving. "import meeting" recognizes one chosen audio file and stores it. Both paths re-encode audio as the canonical 16 kHz mono PCM16 WAV the speech providers validate. Page copy is registered in the `meetingMinutes` locale namespace, and the stylesheet consumes the shell's `--dsw-*` tokens.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmeetingminutes--meetingminutesservice"></a>

### `ctx.meetingMinutes` — `MeetingMinutesService`

Durable meeting service. Mutations serialize so dependent deletes and answers remain consistent.

```ts cordis-catalog
/**
 * Create a meeting from text without invoking speech recognition.
 * @param request - Title, optional participants, transcript, and audio duration.
 * @param signal - Caller cancellation before the durable write.
 * @returns the durable record after storage settles.
 */
createFromTranscript( request: CreateMeetingFromTranscriptRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

/**
 * Open one durable recording before any transcript exists, so a caller can
 * list and follow the meeting while its microphone is still open.
 * @param request - Title and optional participants known when recording starts.
 * @param signal - Caller cancellation before the durable write.
 * @returns the durable record after storage settles.
 */
beginRecording( request: BeginMeetingRecordingRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

/**
 * Replace the transcript one open recording has produced so far, so a reload
 * or a second reader follows the meeting without the caller's live buffer.
 * @param id - The meeting id.
 * @param request - Complete recognized text so far and its audio duration.
 * @param signal - Caller cancellation before the durable write.
 * @returns the durable record after storage settles.
 * @throws when the meeting is absent or is no longer recording.
 */
updateRecording( id: MeetingMinutesId, request: UpdateMeetingRecordingRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

/**
 * Close one open recording with the transcript of its complete recording, so
 * the record becomes readable by the summary and question operations.
 * @param id - The meeting id.
 * @param request - Complete transcript and recognized-audio duration.
 * @param signal - Caller cancellation before the durable write.
 * @returns the durable record after storage settles.
 * @throws when the meeting is absent or is no longer recording.
 */
finishRecording( id: MeetingMinutesId, request: FinishMeetingRecordingRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

/**
 * Revise the operator-editable fields of any stored meeting, so a title the
 * recorder generated can be replaced once the meeting is known.
 * @param id - The meeting id.
 * @param request - Title and participant names to replace; each omission keeps the stored value.
 * @param signal - Caller cancellation before the durable write.
 * @returns the durable record after storage settles.
 */
reviseMeeting( id: MeetingMinutesId, request: ReviseMeetingMinutesRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

/**
 * Transcribe one complete recording with the explicitly resolved speech provider,
 * then persist its text as a new meeting.
 * @param request - Title, optional participants, complete WAV audio, and optional speech selection.
 * @param signal - Caller cancellation for recognition and the durable write.
 * @returns the durable record after transcription and storage settle.
 */
async createFromAudio( request: CreateMeetingFromAudioRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

/**
 * Transcribe one complete recording with the explicitly resolved speech
 * provider without storing a meeting, so a caller can show recognized text
 * while it is still capturing audio.
 * @param audio - Complete canonical WAV recording.
 * @param signal - Caller cancellation for recognition.
 * @param providerId - Speech provider id; omission uses the speech plugin's selection.
 * @param language - Speech language hint; omission uses the speech plugin's selection.
 * @returns the recognized text and its audio duration.
 */
async transcribe( audio: Uint8Array, signal: AbortSignal = new AbortController().signal, providerId?: string, language?: string, ): Promise<MeetingTranscript>

/**
 * Report the speech providers this deployment can transcribe with, so a
 * caller can tell an operator that recording needs a speech plugin before it
 * asks for a microphone.
 * @returns the registered providers, the default selection, and preparation progress.
 */
speech(): MeetingSpeechStatus

/**
 * Start or join preparation of one speech provider, so an operator readies a
 * local model from the meeting page instead of another surface.
 * @param providerId - provider to prepare; omission prepares the selection.
 * @returns fresh speech status after the request.
 */
prepareSpeech(providerId?: string): MeetingSpeechStatus

/**
 * Cancel one provider's in-flight preparation.
 * @param providerId - provider to cancel; omission cancels the selection.
 * @returns fresh speech status after cancellation settles.
 */
async cancelSpeechPreparation(providerId?: string): Promise<MeetingSpeechStatus>

/**
 * Read meetings in newest-first creation order.
 * @returns a fresh array of public records.
 */
list(): MeetingMinutesRecord[]

/**
 * Read one meeting.
 * @param id - The meeting id.
 * @returns the public record.
 */
get(id: MeetingMinutesId): MeetingMinutesRecord

/**
 * Generate and persist the meeting summary. A model or cancellation failure leaves
 * the existing record unchanged.
 * @param id - The meeting id.
 * @param signal - Caller cancellation for the model call and durable write.
 * @returns the summarized record.
 * @throws when the meeting is still recording, because a leading fragment is not a meeting to summarize.
 */
summarize(id: MeetingMinutesId, signal: AbortSignal = new AbortController().signal): Promise<MeetingMinutesRecord>

/**
 * Ask one question about a meeting, return its answer, and persist the exchange.
 * @param id - The meeting id.
 * @param request - The nonempty question.
 * @param signal - Caller cancellation for the model call and durable write.
 * @returns the durable answer record.
 * @throws when the meeting is still recording, because a leading fragment is not a meeting to question.
 */
ask( id: MeetingMinutesId, request: AskMeetingMinutesRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingAnswerRecord>

/**
 * Read answers for one meeting in newest-first creation order.
 * @param id - The meeting id.
 * @returns a fresh array of answer records.
 */
listAnswers(id: MeetingMinutesId): MeetingAnswerRecord[]

/**
 * Delete one meeting and all of its answers. Answer deletion precedes meeting deletion,
 * so a failed answer write cannot orphan a missing meeting.
 * @param id - The meeting id.
 * @returns `true` when the meeting existed, or `false` when it was already absent.
 */
delete(id: MeetingMinutesId): Promise<boolean>
```

Source: [`packages/prism/prism-meeting/src/index.ts`](../../packages/prism/prism-meeting/src/index.ts)
<!-- END GENERATED cordis-surface -->
