# 会议纪要

[English](meetings.md) | 中文

会议能力在 Session 日志之外拥有持久会议记录及其从属回答。[`ctx.meetingMinutes`](#ctxmeetingminutes--meetingminutesservice) 导入完整转写或录音，使用一个部署配置的 LLM 路由生成摘要和回答，并持久化成功输出。显式工具消费者只把选定操作暴露给模型。

源码：[`packages/prism/prism-meeting/src/types.ts`](../../packages/prism/prism-meeting/src/types.ts)

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

## 请求词汇

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

## 识别词汇

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

## 持久存储

`meeting_minutes` 存储域为版本 2，包含独立的 `meetings` 和 `answers` 表。记录在麦克风打开的那一刻就存在：`beginRecording` 以空转写和 `recording` 状态写入，`updateRecording` 用它替换目前识别出的文本，`finishRecording` 将其关闭为 `transcribed`。`summarize` 和 `ask` 会拒绝仍在录音的会议，因为开头的片段还不是一场可供阅读的会议。存储记录携带服务拥有的单调递增 sequence；分离的公开记录省略这个内部排序字段。删除会议会先删除其从属回答。

## 服务语义

`list`、`get` 和 `listAnswers` 返回分离记录；会议不存在时 `get` 和 `listAnswers` 以 `MeetingMinutesNotFoundError` 失败。`beginRecording`、`updateRecording`、`finishRecording`、`reviseMeeting`、`summarize`、`ask` 和 `delete` 在既有变更后串行执行。会议不在录音状态时 `updateRecording` 和 `finishRecording` 失败；仍在录音时 `summarize` 和 `ask` 失败，因此开头的转写片段永远不会进入模型。`delete` 先删除依赖回答，再删除会议。每个异步操作都加入服务释放流程并响应取消信号。未发布运行时不变量伴生包，因为服务是变更顺序和依赖记录删除的唯一独立观察方。

## 语音识别

`transcribe` 通过 `ctx.speechToText.resolve` 解析部署注册的提供者，并且只执行该提供者；不存在把音频送到别处的回退。调用方可以指定提供者 id 和语言，省略时使用语音插件自身的当前选择。每次识别接受一段规范的 16 kHz 单声道 PCM16 WAV 录音，拒绝超过提供者上限的录音，并返回识别文本及其音频时长。`speech` 报告已注册的提供者、当前选择和各提供者的准备进度，使浏览器调用方能在索要麦克风之前就说明这次录音不会产生转写。

带准备控制的提供者会先被推进到可转写状态：提供者处于 `unprepared`、`failed` 或 `cancelled` 时 `transcribe` 先启动其准备，其余进行中的阶段则加入该任务；准备失败或被取消时以提供者的失败消息拒绝。等待遵循调用方的取消信号，因此模型下载由请求本身而不是隐藏超时来约束。`prepareSpeech` 在不录音的情况下启动或加入所选提供者的准备，`cancelSpeechPreparation` 取消它，两者都返回新的语音状态。没有准备控制的提供者转写行为不变。

会区分说话人的提供者还会返回 `Transcript.segments`：每个已闭合片段一项，各自携带逐字文本和提供者赋予的说话人标签。`transcript` 就是这些文本以换行连接的结果，因此只需要可读文本的消费者无需读取片段。会议把它们存为 `transcriptSegments`，拥有该写入的操作会拒绝无法重建转写的片段，因此记录里不会同时存在同一份识别的两种互相矛盾的形式。说话人标签只在单次录音内有意义：一场会议里的 `1` 和另一场里的 `1` 互不相关；不做说话人区分的提供者直接省略该字段。

## 浏览器接口

`./web` 入口在 Connection 共享的 `/api` 通道上为每个操作注册一条精确 Fetch 路由——`/api/prism-meeting/list`、`get`、`create`、`begin`、`update`、`finish`、`revise`、`summarize`、`delete`、`speech`、`speech/prepare`、`speech/cancel`、`ask`、`answers`、`transcribe` 和 `audio`。每次调用都经过该通道的浏览器信任与认证围栏，每个应答都带同一种 `{ ok, value }` 或 `{ ok, error }` 信封。JSON 路由在服务看到请求体之前先做校验；`transcribe` 和 `audio` 以请求体承载原始录音字节，`audio` 从查询参数读取标题、参与者、语言和提供者选择。每个操作都委托给 `ctx.meetingMinutes`，因此页面使用部署配置的模型路由而不是第二条路由。之所以用路由而不是插件注册的 RPC 通道：`HostConnectionService` 是通过它自己的 context 创建通道的，而该 context 并未注入 `webServer`，所以 `ctx.connection.rpc.handle()` 会在加载时失败。

`./client` 入口注册一个 `sidebar.panellist` 入口以及该入口选中的 `main` 键控面板。页面列出已存会议、按关键字过滤、展示单场会议的摘要、转写与持久化问答、编辑其标题与参与者、删除记录，并通过 `ctx.sessions` 和 `ctx.uiWorkspace` 把一个问题推送到新会话。问答页签就当前会议向配置的模型路由提问，并按新到旧列出已存的问答。「开始会议」先打开麦克风，随即写入它的持久记录，因此进行中的会议就是列表里的一行，和已存记录共用同一个详情栏：每八秒把新增音频送去转写，每次应答都替换已存转写，详情栏提供暂停、结束和放弃。结束时对整段录音重新转写并在同一步关闭记录；上次没有正常结束而留下的录音中记录，页面会提供关闭操作。麦克风被拒绝时会指出需要开启的设置，创建记录失败会释放麦克风，未注册语音提供者时页面会直接说明。已注册但未就绪的提供者会带出一条准备栏，含启动操作、下载进度和取消操作，操作者无需离开页面即可备好本地模型。「导入会议」识别选定的一个音频文件并入库。两条路径都会把音频重新编码为语音提供者校验的规范 16 kHz 单声道 PCM16 WAV。页面文案注册在 `meetingMinutes` 语言命名空间，样式表只使用 shell 的 `--dsw-*` 令牌。

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
