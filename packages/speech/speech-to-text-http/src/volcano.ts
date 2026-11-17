/**
 * ByteDance Doubao recording-file recognition, flash edition: one request
 * carrying the base64 WAV under `audio.data`, with the status reported in the
 * `X-Api-Status-Code` response header and the text and sentence segments in
 * the JSON body.
 * @module speech-to-text-http/volcano
 */

import { randomUUID } from 'node:crypto'
import { parseAnswerText, readBody } from './answer.ts'
import type { SpeechInput, SpeechSegment } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Header carrying the outcome code of one flash call. */
const STATUS_HEADER = 'x-api-status-code'

/** Message header carrying the operator-readable outcome. */
const MESSAGE_HEADER = 'x-api-message'

/** Status meaning one successful transcription. */
const STATUS_OK = '20000000'

/** Status meaning the service heard no speech. */
const STATUS_SILENT = '20000003'

/** Resource id of the flash edition the adapter speaks to. */
const FLASH_RESOURCE = 'volc.bigasr.auc_turbo'

/**
 * Build one flash recognition request: the canonical WAV travels base64-encoded,
 * the language hint maps onto the service's locale tags, and the fixed resource
 * id names the flash edition.
 * @param apiKey - the console APP Key.
 * @param input - complete canonical WAV bytes and the resolved language hint.
 * @param signal - deadline signal covering the request.
 * @returns the fetch request descriptor.
 */
export function volcanoFlashRequest(apiKey: string, input: SpeechInput,
  signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-api-resource-id': FLASH_RESOURCE,
      'x-api-request-id': randomUUID(),
      'x-api-sequence': '-1',
    },
    body: JSON.stringify({
      user: { uid: 'prism-agent' },
      audio: { data: Buffer.from(input.audio).toString('base64'), format: 'wav',
        ...(input.language === 'auto' ? {} : { language: volcanoLanguage(input.language) }) },
      request: { model_name: 'bigmodel', enable_punc: true, show_utterances: true },
    }),
    signal,
  }
}

/**
 * Read the recognized text and sentence segments of one flash answer.
 * @param response - the service response.
 * @param name - the service display name for the failure messages.
 * @returns the recognized text with sentence segments; silence answers empty.
 */
export async function readVolcanoResult(response: Response,
  name: string): Promise<{ text: string; segments?: readonly SpeechSegment[] }> {
  const status = response.headers.get(STATUS_HEADER)
  const body = await readBody(response)
  if (status !== STATUS_OK && status !== STATUS_SILENT) {
    throw new Error(`Speech service ${name} answered ${status ?? response.status}: ${response.headers.get(MESSAGE_HEADER) ?? body}`)
  }
  if (status === STATUS_SILENT) return { text: '' }
  const parsed = parseAnswerText(body, name)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Speech service ${name} did not answer a JSON body`)
  }
  const result = (parsed as Record<string, unknown>).result
  if (typeof result !== 'object' || result === null) {
    throw new Error(`Speech service ${name} answered without a "result" object`)
  }
  const text = (result as Record<string, unknown>).text
  if (typeof text !== 'string') {
    throw new Error(`Speech service ${name} answered without a "result.text" text`)
  }
  const utterances = (result as Record<string, unknown>).utterances
  const segments = Array.isArray(utterances)
    ? utterances.flatMap((utterance): SpeechSegment[] => {
      if (typeof utterance !== 'object' || utterance === null) return []
      const span = utterance as Record<string, unknown>
      if (typeof span.text !== 'string') return []
      return [{ text: span.text,
        ...(typeof span.start_time === 'number' ? { start: span.start_time / 1000 } : {}),
        ...(typeof span.end_time === 'number' ? { end: span.end_time / 1000 } : {}) }]
    })
    : []
  return { text, ...segments.length === 0 ? {} : { segments } }
}

/** @returns the service locale tag of one language hint; unknown hints run auto detection. */
function volcanoLanguage(language: string): string | undefined {
  const tags: Record<string, string> = {
    zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', yue: 'yue-CN',
  }
  return tags[language]
}
