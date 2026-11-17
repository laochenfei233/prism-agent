/**
 * Register config-driven HTTP transcription providers with `ctx.speechToText`:
 * every configured service becomes one immediately-ready recognizer speaking
 * the OpenAI `/audio/transcriptions` multipart form, an audio-bearing
 * chat-completions request, or a raw-bytes upload with the recognized text
 * mapped from a dot path in the answer. Third-party ASR services join
 * voice-input and the meeting page by configuration alone.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-http
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
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
  mode: 'transcriptions' | 'chat-completions' | 'raw-body' | 'tencent-sentence' | 'xfyun-filetrans' | 'volcano-flash'
  /** Literal API key; prefer {@link HttpServiceConfig.apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference holding the key. */
  apiKeyEnv: string
  /** Transcription model named in the request; omitted models send no model field. */
  model?: string
  /** Language hints this recognizer accepts, including `auto`. */
  languages: string[]
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
  /** Delay between iFlytek progress polls, in milliseconds. */
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
  /** Third-party services to register, in configuration order. */
  services: HttpServiceConfig[]
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
    pollIntervalMs: z.number().step(1).min(1).default(5000),
    maxAudioBytes: z.natural().min(46).default(25 * 1024 * 1024),
    maxDurationSeconds: z.number().min(1).default(7200),
    timeoutMs: z.number().step(1).min(1).default(600_000),
  })).min(1).required(),
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
 * @param config - validated service entries.
 */
export function apply(ctx: Context, config: Config): void {
  for (const service of config.services) {
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
    ctx.effect(() => ctx.speechToText.register(new HttpSpeechProvider({
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
      pollIntervalMs: service.pollIntervalMs,
      maxAudioBytes: service.maxAudioBytes,
      maxDurationSeconds: service.maxDurationSeconds,
      timeoutMs: service.timeoutMs,
      resolveApiKey: () => resolveServiceKey(literalApiKey, ref, service.apiKeyEnv, ctx),
    })), `speechToTextHttp.${brandString<SpeechProviderId>(service.providerId)}`)
  }
}

/** @returns the non-empty string, or `undefined` when the value is blank. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
