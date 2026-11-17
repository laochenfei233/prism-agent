/**
 * Azure AI Speech fast transcription: one multipart request carrying the WAV
 * and a `definition` JSON, authenticated with the subscription key header.
 * The answer reports sentence phrases in milliseconds.
 * @module speech-to-text-http/azure
 */

import type { SpeechInput, SpeechSegment } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Locale tags the service accepts, keyed by language hint. */
const LOCALES: Record<string, string> = {
  zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
}

/**
 * Build the fast-transcription request for one recording; the endpoint URL
 * names the region resource and API version.
 * @param apiKey - the Speech resource subscription key.
 * @param input - complete canonical WAV bytes and the resolved language hint.
 * @param signal - deadline signal covering the request.
 * @returns the fetch request descriptor.
 */
export function azureFastTranscribeRequest(apiKey: string, input: SpeechInput, signal: AbortSignal): RequestInit {
  const form = new FormData()
  form.append('audio', new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }), 'audio.wav')
  form.append('definition', JSON.stringify({
    ...(input.language === 'auto' ? {} : { locales: [LOCALES[input.language] ?? 'en-US'] }),
  }))
  return {
    method: 'POST',
    headers: { 'ocp-apim-subscription-key': apiKey },
    body: form,
    signal,
  }
}

/**
 * Read the recognized text and sentence segments of one fast-transcription answer.
 * @param body - the response body text.
 * @param name - the service display name for the failure messages.
 * @returns the combined text with sentence segments; silence answers empty.
 */
export function readAzureResult(body: string, name: string): { text: string; segments?: readonly SpeechSegment[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Speech service ${name} did not answer a JSON object`)
  }
  const answer = parsed as Record<string, unknown>
  const combined = answer.combinedPhrases
  const text = Array.isArray(combined)
    ? combined.map(phrase => typeof (phrase as Record<string, unknown>)?.text === 'string'
      ? (phrase as { text: string }).text : '').join(' ').trim()
    : ''
  const phrases = answer.phrases
  const segments = Array.isArray(phrases)
    ? phrases.flatMap((phrase): SpeechSegment[] => {
      if (typeof phrase !== 'object' || phrase === null) return []
      const span = phrase as Record<string, unknown>
      if (typeof span.text !== 'string') return []
      return [{
        text: span.text,
        ...(typeof span.offsetMilliseconds === 'number' ? { start: span.offsetMilliseconds / 1000 } : {}),
        ...(typeof span.offsetMilliseconds === 'number' && typeof span.durationMilliseconds === 'number'
          ? { end: (span.offsetMilliseconds + span.durationMilliseconds) / 1000 } : {}),
        ...(typeof span.speaker === 'number' && span.speaker > 0 ? { speaker: String(span.speaker) } : {}),
      }]
    })
    : []
  return { text, ...segments.length === 0 ? {} : { segments } }
}
