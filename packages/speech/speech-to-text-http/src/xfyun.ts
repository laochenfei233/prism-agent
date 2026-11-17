/**
 * iFlytek long-form transcription (`lfasr`): prepare one task, upload the WAV
 * in ≤10 MiB slices, merge, poll the progress, and read the sentence result.
 * Requests authenticate with `signa` = base64(HMAC-SHA1(secretKey, MD5(appId+ts))).
 * @module speech-to-text-http/xfyun
 */

import { createHash, createHmac } from 'node:crypto'
import { readJsonObject, sleepFor } from './answer.ts'
import type { SpeechSegment } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Upload slice size the service prescribes. */
const SLICE_BYTES = 10 * 1024 * 1024

/** Alphabet of the ordered slice ids the service expects (`aaaaaaaaaa`, `aaaaaaaaab`, …). */
const SLICE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

/** Progress status meaning the transcription result is ready to fetch. */
const STATUS_COMPLETED = 9

/** One iFlytek lfasr deployment the adapter speaks to. */
export interface XfyunFiletransOptions {
  /** Resolves the console AppId of the voice-transcription service. */
  readonly resolveAppId: () => Promise<string | undefined>
  /** Base URL of the API, e.g. `https://raasr.xfyun.cn`. */
  readonly endpoint: string
  /** Delay between progress polls, in milliseconds. */
  readonly pollIntervalMs: number
  /** Read the SecretKey signing credential; `undefined` fails the recognition. */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** HTTP entry, injectable for tests. */
  readonly doFetch: typeof fetch
}

/** One ordered sentence of a completed transcription. */
interface XfyunSentence {
  /** Sentence start, in milliseconds. */
  readonly bg: number
  /** Sentence end, in milliseconds. */
  readonly ed: number
  /** Sentence text. */
  readonly onebest: string
  /** Service-assigned speaker label; 0 when speaker separation is off. */
  readonly speaker: number
}

/** One iFlytek lfasr task adapter bound to one deployment. */
export class XfyunFiletrans {
  private readonly options: XfyunFiletransOptions

  /**
   * @param options - deployment-selected app id, endpoint, polling, credentials, and HTTP entry.
   */
  constructor(options: XfyunFiletransOptions) {
    this.options = options
  }

  /**
   * Run the prepare → upload → merge → poll → result flow for one recording.
   * @param audio - complete canonical WAV bytes.
   * @param language - resolved language hint; `zh` maps to the `cn` corpus, `en` to `en`.
   * @param signal - deadline signal covering the whole job.
   * @returns the recognized text and sentence segments.
   */
  async transcribe(audio: Uint8Array, language: string, signal: AbortSignal):
  Promise<{ text: string; segments?: readonly SpeechSegment[] }> {
    const [appId, secretKey] = await Promise.all([this.options.resolveAppId(), this.options.resolveApiKey()])
    if (appId === undefined || appId.length === 0) {
      throw new Error('Speech service has no AppId; configure the credential its deployment names')
    }
    if (secretKey === undefined || secretKey.length === 0) {
      throw new Error('Speech service has no SecretKey; configure the credential its deployment names')
    }
    const prepared = await this.post('prepare', { file_len: String(audio.byteLength), file_name: 'audio.wav',
      slice_num: String(this.sliceIds(audio.byteLength).length),
      ...(language === 'zh' ? { language: 'cn' } : language === 'en' ? { language: 'en' } : {}) },
    appId, secretKey)
    const taskId = prepared.data
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error(`Speech service answered without a task id: ${JSON.stringify(prepared)}`)
    const slices = this.sliceIds(audio.byteLength)
    for (const [index, [offset, length]] of this.sliceRanges(audio.byteLength).entries()) {
      await this.uploadSlice(taskId, slices[index]!, audio.subarray(offset, offset + length), appId, secretKey, signal)
    }
    await this.post('merge', {}, appId, secretKey, taskId)
    await this.awaitCompletion(taskId, appId, secretKey, signal)
    const result = await this.post('getResult', {}, appId, secretKey, taskId)
    const sentences = readSentences(result)
    return {
      text: sentences.map(sentence => sentence.onebest).join(''),
      segments: sentences.map(sentence => ({
        text: sentence.onebest,
        start: sentence.bg / 1000,
        end: sentence.ed / 1000,
        ...(sentence.speaker > 0 ? { speaker: String(sentence.speaker) } : {}),
      })),
    }
  }

  /** @returns the upload slice id of one ordered index (`aaaaaaaaaa`, `aaaaaaaaab`, …). */
  private sliceIds(byteLength: number): readonly string[] {
    const count = Math.max(1, Math.ceil(byteLength / SLICE_BYTES))
    return Array.from({ length: count }, (_, index) => {
      let digits = ''
      let value = index
      for (let position = 0; position < 10; position++) {
        digits = SLICE_ID_ALPHABET[value % 26]! + digits
        value = Math.floor(value / 26)
      }
      return digits
    })
  }

  /** @returns byte ranges of one recording split into service-sized slices. */
  private sliceRanges(byteLength: number): readonly (readonly [number, number])[] {
    const ranges: [number, number][] = []
    for (let offset = 0; offset < byteLength; offset += SLICE_BYTES) {
      ranges.push([offset, Math.min(SLICE_BYTES, byteLength - offset)])
    }
    return ranges.length === 0 ? [[0, 0]] : ranges
  }

  /** @returns one form-urlencoded response envelope, rejecting service failures. */
  private async post(action: string, fields: Record<string, string>, appId: string, secretKey: string, taskId?: string):
  Promise<Record<string, unknown>> {
    const ts = Math.floor(Date.now() / 1000)
    const body = new URLSearchParams({
      app_id: appId,
      signa: signa(appId, ts, secretKey),
      ts: String(ts),
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...fields,
    })
    const envelope = await readJsonObject(await this.options.doFetch(`${this.options.endpoint}/api/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    }))
    if (envelope.ok !== 0) {
      throw new Error(`Speech service ${action} failed: ${String(envelope.err_no)} ${String(envelope.failed)}`)
    }
    return envelope
  }

  /** Upload one slice as multipart form data under its ordered id. */
  private async uploadSlice(taskId: string, sliceId: string, content: Uint8Array, appId: string, secretKey: string,
    signal: AbortSignal): Promise<void> {
    const ts = Math.floor(Date.now() / 1000)
    const form = new FormData()
    form.append('app_id', appId)
    form.append('signa', signa(appId, ts, secretKey))
    form.append('ts', String(ts))
    form.append('task_id', taskId)
    form.append('slice_id', sliceId)
    form.append('content', new Blob([new Uint8Array(content)], { type: 'application/octet-stream' }))
    const parsed = await readJsonObject(await this.options.doFetch(`${this.options.endpoint}/api/upload`, { method: 'POST', body: form, signal }))
    if (parsed.ok !== 0) throw new Error(`Speech service upload failed: ${JSON.stringify(parsed)}`)
  }

  /** Poll the task progress until the result is ready, failing on any other settled status. */
  private async awaitCompletion(taskId: string, appId: string, secretKey: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      const progress = await this.post('getProgress', {}, appId, secretKey, taskId)
      const status = readProgressStatus(progress.data)
      if (status === STATUS_COMPLETED) return
      // Statuses 0–5 describe work in flight; the remaining statuses report
      // a settled failure the service will not recover from.
      if (status !== undefined && status > 5) {
        throw new Error(`Speech service task failed with status ${status}`)
      }
      await sleepFor(this.options.pollIntervalMs, signal)
    }
  }
}

/**
 * Read the task status of one `getProgress` answer; the service sends the
 * status object as a JSON-encoded string inside `data`.
 * @param data - the `data` member of the response envelope.
 * @returns the status number, or `undefined` when the answer carries none.
 */
function readProgressStatus(data: unknown): number | undefined {
  let parsed: unknown = data
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch {
      // An empty string is the documented idle answer; anything else unparsable fails below.
      if (data.length > 0) throw new Error('Speech service answered an unparsable progress status')
      return undefined
    }
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const status = (parsed as Record<string, unknown>).status
    if (typeof status === 'number') return status
  }
  return undefined
}

/**
 * Read the sentence array of one `getResult` answer; the service sends the
 * sentences as a JSON-encoded string inside `data`.
 * @param envelope - the parsed response envelope.
 * @returns the sentences in service order.
 */
function readSentences(envelope: Record<string, unknown>): readonly XfyunSentence[] {
  const raw = envelope.data
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Speech service result JSON is malformed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!Array.isArray(parsed)) throw new Error('Speech service answered without a sentence array')
  const sentences: XfyunSentence[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const sentence = entry as Record<string, unknown>
    if (typeof sentence.onebest !== 'string') continue
    sentences.push({
      bg: typeof sentence.bg === 'number' ? sentence.bg : 0,
      ed: typeof sentence.ed === 'number' ? sentence.ed : 0,
      onebest: sentence.onebest,
      speaker: typeof sentence.speaker === 'number' ? sentence.speaker : 0,
    })
  }
  return sentences
}

/** @returns the `signa` credential: base64(HMAC-SHA1(secretKey, MD5(appId+ts))). */
function signa(appId: string, ts: number, secretKey: string): string {
  const base = createHash('md5').update(`${appId}${ts}`).digest('hex')
  return createHmac('sha1', secretKey).update(base).digest('base64')
}
