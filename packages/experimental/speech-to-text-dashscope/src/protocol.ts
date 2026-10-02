/**
 * The DashScope `api-ws/v1/inference` duplex recognition protocol: the frames this
 * provider sends, the events it accepts, and the authorization query that a WebSocket
 * client without header support must use.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-dashscope/protocol
 */

/** Realtime recognition model the service runs when the deployment names none. */
export const DASHSCOPE_DEFAULT_MODEL = 'fun-asr-realtime'

/** DashScope duplex recognition endpoint. */
export const DASHSCOPE_DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'

/** Sample rate, in Hz, that `run-task` declares and PCM16 uploads must match. */
export const DASHSCOPE_SAMPLE_RATE = 16000

/**
 * One sentence verdict decoded from a `result-generated` event. Frames for an
 * unfinished sentence accumulate text, so a later frame for the same sentence
 * replaces the earlier text rather than extending it.
 */
export interface RecognitionSentence {
  /** Sentence text as accumulated by the service at this frame. */
  readonly text: string
  /** Whether the service closed this sentence; only closed sentences join the transcript. */
  readonly final: boolean
  /** Service-assigned speaker, present when the deployment enables diarization. */
  readonly speaker?: string
}

/** Decoded service frame; `ignored` retains an unrecognized event name for diagnostics. */
export type RecognitionEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'sentence'; readonly sentence: RecognitionSentence }
  | { readonly kind: 'finished' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ignored'; readonly event: string }

/** A service frame this provider cannot decode; the recognition session cannot continue. */
export class RecognitionProtocolError extends Error {
  /**
   * @param message - what the offending frame violated.
   */
  constructor(message: string) {
    super(message)
    this.name = 'RecognitionProtocolError'
  }
}

/** Event names that end the session in failure. */
const FAILURE_EVENTS: ReadonlySet<string> = new Set(['task-failed', 'failed', 'error'])

/** Read a nested property without asserting the intermediate value's type. */
function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/** Read a string property, or `undefined` when absent or another type. */
function stringMember(value: unknown, key: string): string | undefined {
  const found = member(value, key)
  return typeof found === 'string' ? found : undefined
}

/**
 * Read the sentence text of one `result-generated` payload. The service nests it
 * under `payload.output.sentence` for realtime models and flattens it under
 * `payload.output` for others.
 * @param payload - the frame's `payload` member.
 * @returns sentence text and completion flag, or `undefined` when the frame carries no result.
 */
function sentenceOf(payload: unknown): { text: string; final: boolean; speaker?: string } | undefined {
  const output = member(payload, 'output')
  const sentence = member(output, 'sentence')
  const source = sentence === undefined ? output : sentence
  const text = stringMember(source, 'text')
  if (text === undefined || text.length === 0) return undefined
  const speaker = stringMember(source, 'speaker_id')
  return {
    text,
    final: member(source, 'sentence_end') === true,
    ...speaker === undefined ? {} : { speaker },
  }
}

/**
 * Build the `run-task` frame that opens one recognition session.
 * @param taskId - correlation id every following frame repeats.
 * @param model - realtime recognition model name.
 * @param parameters - extra recognition parameters merged over the PCM16 defaults.
 * @returns the JSON text to send as the session's first frame.
 */
export function runTaskFrame(taskId: string, model: string, parameters: Record<string, unknown> = {}): string {
  return JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model,
      parameters: { format: 'pcm', sample_rate: DASHSCOPE_SAMPLE_RATE, ...parameters },
      input: {},
    },
  })
}

/**
 * Build the `finish-task` frame; the service answers with its remaining results
 * before `task-finished`.
 * @param taskId - the same correlation id used by `run-task`.
 * @returns the JSON text to send after the last audio chunk.
 */
export function finishTaskFrame(taskId: string): string {
  return JSON.stringify({ header: { action: 'finish-task', task_id: taskId }, payload: { input: {} } })
}

/**
 * Append the API key as an `authorization` query parameter. A browser-shaped
 * WebSocket cannot set request headers, so the endpoint reads the bearer token
 * from the query instead.
 * @param baseUrl - configured endpoint in WebSocket or HTTP form.
 * @param apiKey - resolved bearer token.
 * @returns the endpoint to connect to, with scheme and authorization applied.
 */
export function authorizedUrl(baseUrl: string, apiKey: string): string {
  const upgraded = baseUrl.replace(/^http(s?):/, 'ws$1:')
  const url = new URL(upgraded)
  url.searchParams.set('authorization', `Bearer ${apiKey}`)
  return url.toString()
}

/**
 * Decode one service frame.
 * @param raw - the text of one WebSocket message.
 * @returns the decoded event.
 * @throws {RecognitionProtocolError} The frame is not a JSON object carrying an event name.
 */
export function parseRecognitionEvent(raw: string): RecognitionEvent {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new RecognitionProtocolError('Recognition frame is not JSON')
  }
  const header = member(decoded, 'header')
  const event = stringMember(header, 'event') ?? stringMember(header, 'action')
  if (event === undefined) throw new RecognitionProtocolError('Recognition frame carries no event name')
  if (event === 'task-started') return { kind: 'started' }
  if (event === 'task-finished') return { kind: 'finished' }
  if (FAILURE_EVENTS.has(event)) {
    const message = stringMember(header, 'error_message')
      ?? stringMember(header, 'status_message')
      ?? stringMember(member(decoded, 'payload'), 'message')
    return { kind: 'failed', message: message === undefined || message.length === 0 ? event : message }
  }
  if (event === 'result-generated') {
    const sentence = sentenceOf(member(decoded, 'payload'))
    return sentence === undefined ? { kind: 'ignored', event } : { kind: 'sentence', sentence }
  }
  return { kind: 'ignored', event }
}
