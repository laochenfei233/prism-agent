/**
 * Tencent Cloud one-sentence recognition (`SentenceRecognition`): one JSON
 * request carrying the base64 WAV, authenticated with TC3-HMAC-SHA256 signing
 * over SecretId and SecretKey. The endpoint admits 60 seconds of audio per call.
 * @module speech-to-text-http/tencent
 */

import { createHash, createHmac } from 'node:crypto'
import type { SpeechInput } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Tencent Cloud service name signed into the credential scope. */
const SERVICE = 'asr'

/** Algorithm label of the TC3 signing scheme. */
export const TENCENT_ALGORITHM = 'TC3-HMAC-SHA256'

/** Headers whose names appear in the SignedHeaders list, in sorted order. */
const SIGNED_HEADERS = 'content-type;host;x-tc-action'

/** JSON content type the signed canonical request pins. */
const CONTENT_TYPE = 'application/json; charset=utf-8'

/** One Tencent Cloud deployment the adapter speaks to. */
export interface TencentSentenceOptions {
  /** Engine model the service runs, e.g. `16k_zh`. */
  readonly engineModel: string
  /** Complete POST URL of the endpoint. */
  readonly endpoint: string
}

/**
 * Build the signed `SentenceRecognition` request for one recording.
 * @param secretId - the SecretId signing identity.
 * @param secretKey - the SecretKey signing credential.
 * @param options - deployment-selected engine model and endpoint.
 * @param input - complete canonical WAV bytes; the language hint rides the engine model.
 * @param signal - deadline signal covering the request.
 * @returns the fetch request descriptor.
 */
export function tencentSentenceRequest(
  secretId: string,
  secretKey: string,
  options: TencentSentenceOptions,
  input: SpeechInput,
  signal: AbortSignal,
): RequestInit {
  const body = JSON.stringify({
    SubServiceType: 2,
    ProjectId: 0,
    EngSerViceType: options.engineModel,
    SourceType: 1,
    VoiceFormat: 'wav',
    Data: Buffer.from(input.audio).toString('base64'),
    DataLen: input.audio.byteLength,
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const host = new URL(options.endpoint).host
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:${CONTENT_TYPE}\n`,
    `host:${host}\n`,
    'x-tc-action:sentencerecognition\n',
    '',
    SIGNED_HEADERS,
    sha256Hex(body),
  ].join('\n')
  const stringToSign = [
    TENCENT_ALGORITHM,
    timestamp,
    `${date}/${SERVICE}/tc3_request`,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const keyDate = hmacBuffer(Buffer.from(`TC3${secretKey}`), date)
  const keyService = hmacBuffer(keyDate, SERVICE)
  const keySigning = hmacBuffer(keyService, 'tc3_request')
  const signature = createHmac('sha256', keySigning).update(stringToSign).digest('hex')
  return {
    method: 'POST',
    headers: {
      'content-type': CONTENT_TYPE,
      host,
      'x-tc-action': 'SentenceRecognition',
      'x-tc-version': '2019-06-14',
      'x-tc-timestamp': String(timestamp),
      authorization: `${TENCENT_ALGORITHM} Credential=${secretId}/${date}/${SERVICE}/tc3_request, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    },
    body,
    signal,
  }
}

/**
 * Read the recognized text of one `SentenceRecognition` answer.
 * @param body - the response body text.
 * @param name - the service display name for the failure messages.
 * @returns the recognized text; empty when the service recognized no speech.
 */
export function readTencentResult(body: string, name: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${reasonOf(error)}`)
  }
  const envelope = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>).Response
    : undefined
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error(`Speech service ${name} did not answer a Tencent Response envelope`)
  }
  const response = envelope as Record<string, unknown>
  if (typeof response.Error === 'object' && response.Error !== null) {
    const failure = response.Error as Record<string, unknown>
    throw new Error(`Speech service ${name} answered ${String(failure.Code)}: ${String(failure.Message)}`)
  }
  if (typeof response.Result !== 'string') {
    throw new Error(`Speech service ${name} answered without a "Response.Result" text`)
  }
  return response.Result
}

/** @returns lowercase hex SHA-256 of one string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** @returns one HMAC-SHA256 keyed digest. */
function hmacBuffer(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
