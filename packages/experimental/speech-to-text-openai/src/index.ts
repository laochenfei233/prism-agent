/**
 * Register an OpenAI-compatible transcription endpoint with `ctx.speechToText`.
 * The provider sends one already-recorded WAV per request and also publishes the
 * seam's incremental-output streaming capability; it owns no preparation download
 * and writes no Session event.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-openai
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { OPENAI_DEFAULT_BASE_URL } from './protocol.ts'
import { OpenAiSpeechProvider } from './provider.ts'

export { AUTO_LANGUAGE, OPENAI_DEFAULT_BASE_URL, decodeJson, failureDetail, transcriptText, transcriptionUrl } from './protocol.ts'
export { OPENAI_TIMEOUT_CODE, OpenAiSpeechProvider, OpenAiTimeoutError } from './provider.ts'
export { OpenAiStreaming } from './stream.ts'
export type { OpenAiProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'experimental-speech-to-text-openai'

/** The speech registry this provider registers into. */
export const inject = ['speechToText']

/** Credential reference read when the deployment supplies no literal key. */
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'

/** Documented OpenAI upload ceiling, in bytes; other endpoints override it. */
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Plugin configuration; every field is resolved before the provider is registered. */
export interface Config {
  /** Literal bearer token; prefer {@link Config.apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference holding the token; defaults to `OPENAI_API_KEY`. */
  apiKeyEnv: string
  /** Registration identity this recognizer occupies. */
  providerId: string
  /** Display name shown by speech surfaces. */
  name: string
  /** Language hints this recognizer accepts. */
  languages: string[]
  /** API root the transcription path is joined to. */
  baseUrl: string
  /** Transcription model the endpoint serves; the deployment's default and initial selection. */
  model: string
  /** Models this deployment offers for selection, in order; empty offers no choice. */
  models: string[]
  /** Maximum accepted recording duration in seconds. */
  maxDurationSeconds: number
  /** Maximum accepted upload size in bytes. */
  maxUploadBytes: number
  /** Deadline, in milliseconds, covering one request end to end. */
  timeoutMs: number
}

/** Validated deployment configuration; the loader supplies every default. */
export const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  providerId: z.string().min(1).default('openai-transcription'),
  name: z.string().min(1).default('OpenAI-compatible transcription'),
  languages: z.array(z.string().min(1)).default(['auto']),
  baseUrl: z.string().min(1).default(OPENAI_DEFAULT_BASE_URL),
  model: z.string().min(1).required(),
  models: z.array(z.string().min(1)).default([]),
  maxDurationSeconds: z.number().min(1).default(3600),
  maxUploadBytes: z.number().step(1).min(1).default(DEFAULT_MAX_UPLOAD_BYTES),
  timeoutMs: z.number().step(1).min(1).default(120_000),
})

/**
 * Register the recognizer; the registration is disposed with the plugin.
 * @param ctx - context exposing the speech registry and credential planes.
 * @param config - validated endpoint, model, limits, and key reference.
 */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  ctx.effect(() => ctx.speechToText.register(new OpenAiSpeechProvider({
    id: brandString<SpeechProviderId>(config.providerId),
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
    models: config.models,
    languages: config.languages,
    maxDurationSeconds: config.maxDurationSeconds,
    maxUploadBytes: config.maxUploadBytes,
    timeoutMs: config.timeoutMs,
    resolveApiKey: async () => {
      if (literalApiKey !== undefined) return literalApiKey
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the launch environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
  })))
}
