/**
 * Google Cloud Speech-to-Text v1 synchronous recognition: one JSON envelope
 * carrying the base64 WAV and the recognition config, authenticated with an
 * API key query parameter. The endpoint admits roughly 60 seconds of audio.
 * @module speech-to-text-http/google
 */

import type { SpeechInput } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Locale tags the service accepts, keyed by language hint. */
const LANGUAGE_CODES: Record<string, string> = {
  zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
}

/** One Google Speech deployment the adapter speaks to. */
export interface GoogleSpeechOptions {
  /** Recognition model the service runs, e.g. `latest_long`; absent leaves the default. */
  readonly model?: string
}

/**
 * Build the `speech:recognize` request for one recording; the API key rides the
 * configured endpoint URL, so it never enters the body.
 * @param options - deployment-selected recognition model.
 * @param input - complete canonical WAV bytes and the resolved language hint.
 * @param signal - deadline signal covering the request.
 * @returns the fetch request descriptor.
 */
export function googleSpeechRequest(options: GoogleSpeechOptions, input: SpeechInput, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: input.language === 'auto' ? undefined : LANGUAGE_CODES[input.language] ?? undefined,
        ...(options.model === undefined ? {} : { model: options.model }),
      },
      audio: { content: Buffer.from(input.audio).toString('base64') },
    }),
    signal,
  }
}

/**
 * Read the recognized text of one `speech:recognize` answer.
 * @param body - the response body text.
 * @param name - the service display name for the failure messages.
 * @returns the recognized text; empty when the service recognized no speech.
 */
export function readGoogleResult(body: string, name: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Speech service ${name} did not answer a JSON object`)
  }
  const envelope = parsed as Record<string, unknown>
  if (typeof envelope.error === 'object' && envelope.error !== null) {
    const failure = envelope.error as Record<string, unknown>
    throw new Error(`Speech service ${name} answered ${String(failure.status)}: ${String(failure.message)}`)
  }
  const results = envelope.results
  if (!Array.isArray(results) || results.length === 0) return ''
  const text = results
    .map(result => Array.isArray((result as Record<string, unknown>)?.alternatives)
      ? ((result as { alternatives: { transcript?: unknown }[] }).alternatives[0]?.transcript ?? '')
      : '')
    .filter(part => typeof part === 'string' && part.length > 0)
    .join('\n')
  return text
}
