/**
 * Register config-driven HTTP transcription providers with `ctx.speechToText`:
 * every configured service becomes one immediately-ready recognizer speaking
 * the OpenAI `/audio/transcriptions` request shape. Third-party ASR services
 * join voice-input and the meeting page by configuration alone.
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
export type { HttpAsrServiceOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-to-text-http'

/** The speech registry this provider registers into. */
export const inject = ['speechToText']

/** One configured third-party transcription service. */
export interface HttpServiceConfig {
  /** Registration identity this recognizer occupies. */
  providerId: string
  /** Operator-facing display name; omitted names show the model. */
  name?: string
  /** Complete POST URL of the transcription endpoint. */
  endpoint: string
  /** Literal API key; prefer {@link HttpServiceConfig.apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference holding the bearer key. */
  apiKeyEnv: string
  /** Transcription model named in the form. */
  model: string
  /** Language hints this recognizer accepts, including `auto`. */
  languages: string[]
  /** Top-level JSON response field carrying the recognized text. */
  textField: string
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
    apiKey: z.string().role('secret'),
    apiKeyEnv: z.string().role('credential-ref').required(),
    model: z.string().min(1).required(),
    languages: z.array(z.string().min(1)).default(['auto']),
    textField: z.string().min(1).default('text'),
    maxAudioBytes: z.natural().min(46).default(25 * 1024 * 1024),
    maxDurationSeconds: z.number().min(1).default(7200),
    timeoutMs: z.number().step(1).min(1).default(600_000),
  })).min(1).required(),
})

/**
 * Resolve one service's bearer key: the literal configuration value first,
 * then the credentials plane, then the launch environment.
 * @param literal - the configured literal key, when the deployment supplied one.
 * @param ref - the credential reference naming the key.
 * @param envName - the environment variable the reference names.
 * @param ctx - context exposing the credential planes.
 * @returns the key, or `undefined` when no plane supplies one.
 */
export async function resolveServiceKey(
  literal: string | undefined,
  ref: CredentialRef,
  envName: string,
  ctx: Context,
): Promise<string | undefined> {
  if (literal !== undefined) return literal
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  // Without the seam the launch environment is the whole credential plane.
  const ambient = launchEnvironmentOf(ctx).get(envName)
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
    const literalApiKey = service.apiKey !== undefined && service.apiKey.length > 0 ? service.apiKey : undefined
    ctx.effect(() => ctx.speechToText.register(new HttpSpeechProvider({
      id: service.providerId,
      ...(service.name === undefined ? {} : { name: service.name }),
      endpoint: service.endpoint,
      model: service.model,
      languages: service.languages,
      textField: service.textField,
      maxAudioBytes: service.maxAudioBytes,
      maxDurationSeconds: service.maxDurationSeconds,
      timeoutMs: service.timeoutMs,
      resolveApiKey: () => resolveServiceKey(literalApiKey, ref, service.apiKeyEnv, ctx),
    })), `speechToTextHttp.${brandString<SpeechProviderId>(service.providerId)}`)
  }
}
