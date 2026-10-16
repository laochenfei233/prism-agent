/**
 * The failure vocabulary both transcription entry points raise: the deadline code
 * and error, and the missing-credential message.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-openai/errors
 */

/** Timeout code stamped on the deadline covering one transcription request. */
export const OPENAI_TIMEOUT_CODE = 'OPENAI_TRANSCRIPTION_TIMEOUT'

/** Message every entry point uses when no usable key reached the request. */
export const OPENAI_API_KEY_ERROR =
  'OpenAI-compatible transcription requires an API key: set the plugin apiKey or its credential reference'

/** Raised when one transcription request outlives its configured deadline. */
export class OpenAiTimeoutError extends Error {
  /** @param timeoutMs - the deadline that elapsed. */
  constructor(readonly timeoutMs: number) {
    super(`OpenAI-compatible transcription exceeded its ${timeoutMs}ms deadline`)
    this.name = 'OpenAiTimeoutError'
  }
}

/**
 * Present a caught value as an Error.
 * @param thrown - the value a failed operation raised.
 * @returns The value itself when it is already an Error, else an Error carrying its text.
 */
export function failureOf(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}
