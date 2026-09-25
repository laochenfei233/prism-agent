# 会议纪要

[English](meetings.md) | 中文

会议能力在 Session 日志之外拥有持久会议记录及其从属回答。[`ctx.meetingMinutes`](#ctxmeetingminutes--meetingminutesservice) 导入完整转写或录音，使用一个部署配置的 LLM 路由生成摘要和回答，并持久化成功输出。显式工具消费者只把选定操作暴露给模型。

源码：[`packages/meetings/meeting-minutes/src/types.ts`](../../packages/meetings/meeting-minutes/src/types.ts)

## 会议与回答词汇

```ts type-equiv
/** Identifies one durable meeting record. */
type MeetingMinutesId = Branded<'MeetingMinutesId'>
```

```ts type-equiv
/** Identifies one durable question/answer exchange for one meeting. */
type MeetingAnswerId = Branded<'MeetingAnswerId'>
```

```ts type-equiv
/** Lifecycle of the AI summary; it does not track the transient in-flight model call. */
type MeetingMinutesStatus = 'transcribed' | 'summarized'
```

```ts type-equiv
/** One durable meeting record, including its source transcript and latest summary. */
interface MeetingMinutesRecord {
  readonly id: MeetingMinutesId
  readonly title: string
  /** Ordered participant display names; names are normalized but not identities. */
  readonly participants: readonly string[]
  readonly transcript: string
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

## 请求词汇

```ts type-equiv
/** Caller input for creating a meeting from already-available text. */
interface CreateMeetingFromTranscriptRequest {
  readonly title: string
  readonly participants?: readonly string[]
  readonly transcript: string
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
/** Caller input for one persisted question/answer exchange. */
interface AskMeetingMinutesRequest {
  readonly question: string
}
```

## 持久存储

`meeting_minutes` 存储域为版本 1，包含独立的 `meetings` 和 `answers` 表。存储记录携带服务拥有的单调递增 sequence；分离的公开记录省略这个内部排序字段。删除会议会先删除其从属回答。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Transcribe one complete recording with the explicitly resolved speech provider,
 * then persist its text as a new meeting.
 * @param request - Title, optional participants, complete WAV audio, and optional speech selection.
 * @param signal - Caller cancellation for recognition and the durable write.
 * @returns the durable record after transcription and storage settle.
 */
async createFromAudio( request: CreateMeetingFromAudioRequest, signal: AbortSignal = new AbortController().signal, ): Promise<MeetingMinutesRecord>

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
 */
summarize(id: MeetingMinutesId, signal: AbortSignal = new AbortController().signal): Promise<MeetingMinutesRecord>

/**
 * Ask one question about a meeting, return its answer, and persist the exchange.
 * @param id - The meeting id.
 * @param request - The nonempty question.
 * @param signal - Caller cancellation for the model call and durable write.
 * @returns the durable answer record.
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

Source: [`packages/meetings/meeting-minutes/src/index.ts`](../../packages/meetings/meeting-minutes/src/index.ts)
<!-- END GENERATED cordis-surface -->
