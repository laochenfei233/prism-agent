/**
 * Register config-driven HTTP transcription providers with `ctx.speechToText`:
 * every configured service becomes one immediately-ready recognizer speaking
 * the OpenAI `/audio/transcriptions` multipart form, an audio-bearing
 * chat-completions request, or a raw-bytes upload with the recognized text
 * mapped from a dot path in the answer. Third-party ASR services join
 * voice-input and the meeting page by configuration alone.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-http
 */

import type { Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` merge that a live rewrite emits.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HttpSpeechProvider } from './provider.ts'

export { HTTP_ASR_TIMEOUT_CODE, HttpSpeechProvider } from './provider.ts'
export type { HttpAsrServiceOptions, SpeechHttpMode } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-to-text-http'

/** The speech registry this provider registers into. */
export const inject = ['speechToText']

/** One configured third-party transcription service. */
export interface HttpServiceConfig {
  /** Registration identity this recognizer occupies. */
  providerId: string
  /** Operator-facing display name; omitted names show the model, then the id. */
  name?: string
  /** Complete POST URL of the transcription endpoint; `raw-body` services carry fixed query parameters here. */
  endpoint: string
  /** Request form the service speaks; defaults to the OpenAI multipart form. */
  mode: 'transcriptions' | 'chat-completions' | 'raw-body' | 'tencent-sentence' | 'xfyun-filetrans'
    | 'volcano-flash' | 'google-speech' | 'azure-fasttranscribe' | 'aws-transcribe'
  /** Literal API key; prefer {@link HttpServiceConfig.apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference holding the key. */
  apiKeyEnv: string
  /** Transcription model named in the request; omitted models send no model field. */
  model?: string
  /** Language hints this recognizer accepts, including `auto`. */
  languages: readonly string[]
  /** Response field carrying the recognized text, as a dot path. */
  textField: string
  /** Credential header; defaults to `authorization`. */
  authHeader?: string
  /** Credential value prefix; defaults to the `Bearer` scheme. */
  authStyle: 'bearer' | 'token' | 'raw'
  /** Engine model the `tencent-sentence` form names in its body. */
  engineModel: string
  /** Literal Tencent SecretId; {@link HttpServiceConfig.secretIdEnv} keeps it out of configuration files. */
  secretId?: string
  /** Credential reference holding the Tencent SecretId. */
  secretIdEnv?: string
  /** Literal iFlytek AppId; {@link HttpServiceConfig.appIdEnv} keeps it out of configuration files. */
  appId?: string
  /** Credential reference holding the iFlytek AppId. */
  appIdEnv?: string
  /** AWS region hosting the transcription job and S3 bucket; required for `aws-transcribe`. */
  awsRegion?: string
  /** S3 bucket receiving the upload and the transcript; required for `aws-transcribe`. */
  awsBucket?: string
  /** Delay between job progress polls, in milliseconds. */
  pollIntervalMs: number
  /** Rejected recording size in bytes. */
  maxAudioBytes: number
  /** Rejected recording duration in seconds. */
  maxDurationSeconds: number
  /** Deadline, in milliseconds, covering upload and answer. */
  timeoutMs: number
}

/** Plugin configuration; every entry becomes one registered recognizer. */
export interface Config {
  /**
   * Services to register, in configuration order. Live: a profile rewrite of
   * this list (including one made from the speech settings page) re-registers
   * the recognizers without remounting the plugin.
   */
  services: Volatile<HttpServiceConfig[]>
}

/** Validated deployment configuration; the loader supplies the defaults. */
export const Config = z.object({
  services: z.array(z.object({
    providerId: z.string().min(1).required(),
    name: z.string().min(1),
    endpoint: z.string().min(1).required(),
    mode: z.union([
      z.const('transcriptions'),
      z.const('chat-completions'),
      z.const('raw-body'),
      z.const('tencent-sentence'),
      z.const('xfyun-filetrans'),
      z.const('volcano-flash'),
      z.const('google-speech'),
      z.const('azure-fasttranscribe'),
      z.const('aws-transcribe'),
    ]).default('transcriptions'),
    apiKey: z.string().role('secret'),
    apiKeyEnv: z.string().role('credential-ref').required(),
    model: z.string().min(1),
    languages: z.array(z.string().min(1)).default(['auto']),
    textField: z.string().min(1).default('text'),
    authHeader: z.string().min(1),
    authStyle: z.union([z.const('bearer'), z.const('token'), z.const('raw')]).default('bearer'),
    engineModel: z.string().min(1).default('16k_zh'),
    secretId: z.string().role('secret'),
    secretIdEnv: z.string().role('credential-ref'),
    appId: z.string().min(1),
    appIdEnv: z.string().role('credential-ref'),
    awsRegion: z.string().min(1),
    awsBucket: z.string().min(1),
    pollIntervalMs: z.number().step(1).min(1).default(5000),
    maxAudioBytes: z.natural().min(46).default(25 * 1024 * 1024),
    maxDurationSeconds: z.number().min(1).default(7200),
    timeoutMs: z.number().step(1).min(1).default(600_000),
  })).min(1).required().volatile(),
})

/**
 * Resolve one service's key: the literal configuration value first, then the
 * credentials plane, then the launch environment.
 * @param literal - the configured literal key, when the deployment supplied one.
 * @param ref - the credential reference naming the key; omitted skips the credentials plane.
 * @param envName - the environment variable the reference names; omitted skips the launch environment.
 * @param ctx - context exposing the credential planes.
 * @returns the key, or `undefined` when no plane supplies one.
 */
export async function resolveServiceKey(
  literal: string | undefined,
  ref: CredentialRef | undefined,
  envName: string | undefined,
  ctx: Context,
): Promise<string | undefined> {
  if (literal !== undefined) return literal
  if (ref === undefined && envName === undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && ref !== undefined) return (await credentials.resolve(ref))?.value
  // Without the seam the launch environment is the whole credential plane.
  const ambient = envName === undefined ? undefined : launchEnvironmentOf(ctx).get(envName)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * Register one recognizer per configured service; every registration is
 * disposed with the plugin, and the registry rejects duplicate ids loudly.
 * @param ctx - context exposing the speech registry and credential planes.
 * @param config - validated service entries; the live list re-registers on change.
 */
export function apply(ctx: Context, config: Config): void {
  const register = (services: readonly HttpServiceConfig[]): void => {
    for (const service of services) registerService(ctx, service)
  }
  ctx.effect(() => {
    register(config.services.get())
    // A volatile rewrite (profile edit or the settings page) replaces the list:
    // the previous registrations withdraw before the new ones arrive.
    const off = ctx.on('loader/volatile-update', () => {
      // Withdraw first so a replaced list never collides with its predecessors.
      void withdrawAll(ctx).then(() => { register(config.services.get()) })
    })
    return async () => {
      off()
      await withdrawAll(ctx)
    }
  }, 'speechToTextHttp.services')
}

/** Registrations owned by one apply call, so a volatile rewrite can withdraw them. */
const registrations = new WeakMap<Context, (() => Promise<void>)[]>()

/** @returns the registrations one context currently owns. */
function owned(ctx: Context): (() => Promise<void>)[] {
  const existing = registrations.get(ctx)
  if (existing !== undefined) return existing
  const created: (() => Promise<void>)[] = []
  registrations.set(ctx, created)
  return created
}

/** Withdraw every registration the context owns. @returns after they settle. */
async function withdrawAll(ctx: Context): Promise<void> {
  const list = owned(ctx)
  const pending = list.splice(0)
  await Promise.allSettled(pending.map(dispose => dispose()))
}

/**
 * Register one recognizer for one service entry, validating the form-specific
 * credentials at load so a misconfigured row fails loud.
 * @param ctx - context exposing the speech registry and credential planes.
 * @param service - one configured service entry.
 */
function registerService(ctx: Context, service: HttpServiceConfig): void {
  {
    const ref = credentialRef(service.apiKeyEnv)
    const literalApiKey = nonEmpty(service.apiKey)
    const literalSecretId = nonEmpty(service.secretId)
    const literalAppId = nonEmpty(service.appId)
    if (service.mode === 'tencent-sentence' && literalSecretId === undefined && service.secretIdEnv === undefined) {
      throw new Error(`Service ${service.providerId} speaks tencent-sentence and must configure a SecretId`)
    }
    if (service.mode === 'xfyun-filetrans' && literalAppId === undefined && service.appIdEnv === undefined) {
      throw new Error(`Service ${service.providerId} speaks xfyun-filetrans and must configure an AppId`)
    }
    if (service.mode === 'aws-transcribe' && (service.awsRegion === undefined || service.awsBucket === undefined
      || (literalSecretId === undefined && service.secretIdEnv === undefined))) {
      throw new Error(`Service ${service.providerId} speaks aws-transcribe and must configure a region, a bucket, and an access key id`)
    }
    const dispose = ctx.speechToText.register(new HttpSpeechProvider({
      id: service.providerId,
      ...(service.name === undefined ? {} : { name: service.name }),
      endpoint: service.endpoint,
      ...(service.mode === 'transcriptions' ? {} : { mode: service.mode }),
      ...(service.model === undefined ? {} : { model: service.model }),
      languages: service.languages,
      textField: service.textField,
      ...(service.authHeader === undefined ? {} : { authHeader: service.authHeader }),
      ...(service.authStyle === 'bearer' ? {} : { authStyle: service.authStyle }),
      engineModel: service.engineModel,
      ...(literalSecretId === undefined && service.secretIdEnv === undefined ? {}
        : { resolveSecretId: () => resolveServiceKey(literalSecretId,
          service.secretIdEnv === undefined ? undefined : credentialRef(service.secretIdEnv), service.secretIdEnv, ctx) }),
      ...(literalAppId === undefined && service.appIdEnv === undefined ? {}
        : { resolveAppId: () => resolveServiceKey(literalAppId,
          service.appIdEnv === undefined ? undefined : credentialRef(service.appIdEnv), service.appIdEnv, ctx) }),
      ...(service.awsRegion === undefined ? {} : { awsRegion: service.awsRegion }),
      ...(service.awsBucket === undefined ? {} : { awsBucket: service.awsBucket }),
      pollIntervalMs: service.pollIntervalMs,
      maxAudioBytes: service.maxAudioBytes,
      maxDurationSeconds: service.maxDurationSeconds,
      timeoutMs: service.timeoutMs,
      resolveApiKey: () => resolveServiceKey(literalApiKey, ref, service.apiKeyEnv, ctx),
    }))
    owned(ctx).push(dispose)
  }
}

/** @returns the non-empty string, or `undefined` when the value is blank. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
