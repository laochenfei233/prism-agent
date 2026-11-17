/**
 * Amazon Transcribe batch recognition: the WAV uploads to a configured S3
 * bucket, a transcription job transcribes it, and the finished job's
 * transcript file is read back. Every request signs with SigV4 over the
 * access key pair; the adapter owns no bucket lifecycle.
 * @module speech-to-text-http/aws
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readJsonObject, sleepFor } from './answer.ts'

/** Signing algorithm label. */
const ALGORITHM = 'AWS4-HMAC-SHA256'

/** Request signing terminator in the credential scope. */
const TERMINATOR = 'aws4_request'

/** Language codes the service accepts, keyed by language hint. */
const LANGUAGE_CODES: Record<string, string> = {
  zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
}

/** One Amazon Transcribe deployment the adapter speaks to. */
export interface AwsTranscribeOptions {
  /** AWS region the job and bucket live in. */
  readonly region: string
  /** S3 bucket receiving the uploaded recording and the transcript output. */
  readonly bucket: string
  /** Base URL of the Transcribe endpoint, e.g. `https://transcribe.us-east-1.amazonaws.com`. */
  readonly endpoint: string
  /** Delay between job polls, in milliseconds. */
  readonly pollIntervalMs: number
  /** HTTP entry, injectable for tests. */
  readonly doFetch: typeof fetch
}

/** One recognized Amazon Transcribe job, in flight or settled. */
interface AwsJob {
  readonly status: string
  readonly failureReason?: string
  readonly transcriptFileUri?: string
}

/** Job status meaning the transcript is ready to read. */
const STATUS_COMPLETED = 'COMPLETED'

/** Job status meaning the service abandoned the job. */
const STATUS_FAILED = 'FAILED'

/** One Amazon Transcribe task adapter bound to one deployment. */
export class AwsTranscribe {
  private readonly options: AwsTranscribeOptions

  /**
   * @param options - region, bucket, endpoint, polling, and HTTP entry.
   */
  constructor(options: AwsTranscribeOptions) {
    this.options = options
  }

  /**
   * Run the upload → job → poll → read flow for one recording.
   * @param audio - complete canonical WAV bytes.
   * @param language - resolved language hint; `auto` turns on language identification.
   * @param signal - deadline signal covering the whole job.
   * @param accessKeyId - the SigV4 key identifier.
   * @param secretAccessKey - the SigV4 signing key.
   * @returns the recognized transcript text.
   */
  async transcribe(audio: Uint8Array, language: string, signal: AbortSignal, accessKeyId: string,
    secretAccessKey: string): Promise<string> {
    const jobName = `prism-asr-${randomUUID()}`
    const objectKey = `prism-asr/${jobName}.wav`
    const s3Host = `s3.${this.options.region}.amazonaws.com`
    const s3Path = `/${this.options.bucket}/${objectKey}`
    await this.sign('PUT', s3Host, s3Path, [], audio, accessKeyId, secretAccessKey, 's3', signal,
      { 'x-amz-content-sha256': sha256Hex(audio) })
    const region = this.options.region
    const jobBody = JSON.stringify({
      TranscriptionJobName: jobName,
      MediaFormat: 'wav',
      ...(language === 'auto' ? { IdentifyLanguage: true } : { LanguageCode: LANGUAGE_CODES[language] ?? 'en-US' }),
      Media: { MediaFileUri: `s3://${this.options.bucket}/${objectKey}` },
      OutputBucketName: this.options.bucket,
    })
    const submitted = await this.transcribeCall('StartTranscriptionJob', jobBody, accessKeyId, secretAccessKey, region, signal)
    const started = readJob(submitted, 'StartTranscriptionJob')
    for (;;) {
      signal.throwIfAborted()
      if (started.status === STATUS_COMPLETED) break
      if (started.status === STATUS_FAILED) {
        throw new Error(`Speech service task failed: ${started.failureReason ?? 'unspecified reason'}`)
      }
      const polled = readJob(await this.transcribeCall('GetTranscriptionJob',
        JSON.stringify({ TranscriptionJobName: jobName }), accessKeyId, secretAccessKey, region, signal),
      'GetTranscriptionJob')
      if (polled.status === STATUS_FAILED) {
        throw new Error(`Speech service task failed: ${polled.failureReason ?? 'unspecified reason'}`)
      }
      if (polled.status === STATUS_COMPLETED && polled.transcriptFileUri !== undefined) {
        return await this.readTranscript(polled.transcriptFileUri, accessKeyId, secretAccessKey, signal)
      }
      await sleepFor(this.options.pollIntervalMs, signal)
    }
    if (started.transcriptFileUri === undefined) {
      throw new Error('Speech service answered without a transcript file URI')
    }
    return await this.readTranscript(started.transcriptFileUri, accessKeyId, secretAccessKey, signal)
  }

  /** @returns one signed Transcribe JSON-RPC answer, rejecting service errors. */
  private async transcribeCall(target: string, body: string, accessKeyId: string, secretAccessKey: string,
    region: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const host = new URL(this.options.endpoint).host
    const envelope = await readJsonObject(await this.sign('POST', host, '/', [], Buffer.from(body), accessKeyId, secretAccessKey,
      'transcribe', signal, {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `Com.amazonawstranscribe.TranscribeService.${target}`,
      }, region))
    if (typeof envelope.__type === 'string') {
      throw new Error(`Speech service ${target} failed: ${envelope.__type.replace(/^.*#/, '')}`)
    }
    return envelope
  }

  /** @returns the transcript text of one signed fetch of the job's transcript file. */
  private async readTranscript(uri: string, accessKeyId: string, secretAccessKey: string,
    signal: AbortSignal): Promise<string> {
    const parsed = new URL(uri)
    const response = await this.sign('GET', parsed.host, parsed.pathname, [...parsed.searchParams.entries()],
      new Uint8Array(0), accessKeyId, secretAccessKey, 's3', signal,
      { 'x-amz-content-sha256': sha256Hex(new Uint8Array(0)) })
    const text = await response.text()
    if (!response.ok) throw new Error(`Speech service transcript fetch answered ${response.status}: ${text}`)
    let result: unknown
    try {
      result = JSON.parse(text)
    } catch (error) {
      throw new Error(`Speech service transcript JSON is malformed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const transcripts = (result as Record<string, unknown>)?.results !== undefined
      ? ((result as { results?: Record<string, unknown> }).results?.transcripts)
      : undefined
    const transcript = Array.isArray(transcripts) ? (transcripts[0] as Record<string, unknown> | undefined)?.transcript : undefined
    if (typeof transcript !== 'string') throw new Error('Speech service transcript carries no text')
    return transcript
  }

  /**
   * Fetch with one SigV4-signed request.
   * @returns the service response.
   */
  private async sign(method: string, host: string, path: string, query: readonly (readonly [string, string])[],
    payload: Uint8Array, accessKeyId: string, secretAccessKey: string, service: string, signal: AbortSignal,
    extraHeaders: Record<string, string>, region?: string): Promise<Response> {
    const timestamp = Math.floor(Date.now() / 1000)
    const amzDate = new Date(timestamp * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const scopeDate = amzDate.slice(0, 8)
    const scope = `${scopeDate}/${region ?? this.options.region}/${service}/${TERMINATOR}`
    const payloadHash = sha256Hex(payload)
    const canonicalUri = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
    const canonicalQuery = [...query].map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).sort().join('&')
    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      ...extraHeaders,
    }
    const sortedNames = Object.keys(headers).map(name => name.toLowerCase()).sort()
    const canonicalHeaders = sortedNames.map(name => `${name}:${String(headers[headerName(headers, name)]).trim()}\n`).join('')
    const canonicalRequest = [method, canonicalUri || '/', canonicalQuery, canonicalHeaders, sortedNames.join(';'), payloadHash].join('\n')
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
    const key = hmacChain(secretAccessKey, scopeDate, region ?? this.options.region, service)
    const signature = createHmac('sha256', key).update(stringToSign).digest('hex')
    const authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${sortedNames.join(';')}, Signature=${signature}`
    return await this.options.doFetch(`https://${host}${canonicalUri}${canonicalQuery.length > 0 ? `?${canonicalQuery}` : ''}`, {
      method,
      headers: { ...headers, authorization },
      ...(payload.byteLength > 0 ? { body: new Uint8Array(payload) } : {}),
      signal,
    })
  }
}

/** @returns the job status, failure reason, and transcript URI of one Transcribe answer. */
function readJob(envelope: Record<string, unknown>, target: string): AwsJob {
  const job = envelope.TranscriptionJob
  if (typeof job !== 'object' || job === null) {
    throw new Error(`Speech service ${target} answered without a TranscriptionJob`)
  }
  const answer = job as Record<string, unknown>
  const transcriptUri = (answer.Transcript as Record<string, unknown> | undefined)?.TranscriptFileUri
  return {
    status: typeof answer.TranscriptionJobStatus === 'string' ? answer.TranscriptionJobStatus : '',
    ...(typeof answer.FailureReason === 'string' ? { failureReason: answer.FailureReason } : {}),
    ...(typeof transcriptUri === 'string' ? { transcriptFileUri: transcriptUri } : {}),
  }
}

/** @returns the SigV4 signing key chain for one scope. */
function hmacChain(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac('sha256', Buffer.from(`AWS4${secretAccessKey}`)).update(date).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update(service).digest()
  return createHmac('sha256', kService).update(TERMINATOR).digest()
}

/** @returns the header record's own key matching one lowercased name. */
function headerName(headers: Record<string, string>, lower: string): string {
  return Object.keys(headers).find(name => name.toLowerCase() === lower) ?? lower
}

/** @returns lowercase hex SHA-256 of one string or byte sequence. */
function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
