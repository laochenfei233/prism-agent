/**
 * Register the DashScope realtime recognizer with `ctx.speechToText`. The provider
 * streams one recording per duplex WebSocket session and reports plain closed
 * sentences; it owns no preparation download and writes no Session event.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-dashscope
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { DASHSCOPE_DEFAULT_MODEL, DASHSCOPE_DEFAULT_URL } from './protocol.ts'
import { DashScopeSpeechProvider } from './provider.ts'

export {
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_URL,
  DASHSCOPE_SAMPLE_RATE,
  RecognitionProtocolError,
  authorizedUrl,
  finishTaskFrame,
  parseRecognitionEvent,
  runTaskFrame,
} from './protocol.ts'
export type { RecognitionEvent, RecognitionSentence } from './protocol.ts'
export { DASHSCOPE_DRAIN_TIMEOUT_CODE, DASHSCOPE_TIMEOUT_CODE, DashScopeSpeechProvider, DashScopeTimeoutError } from './provider.ts'
export type { DashScopeProviderOptions, DashScopeTimeoutPhase } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'experimental-speech-to-text-dashscope'

/** The speech registry this provider registers into. */
export const inject = ['speechToText']

/** Credential reference read when the deployment supplies no literal key. */
const DEFAULT_API_KEY_ENV = 'DASHSCOPE_API_KEY'

/** Plugin configuration; every field is resolved before the provider is registered. */
export interface Config {
  /** Literal DashScope key; prefer {@link Config.apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference holding the key; defaults to `DASHSCOPE_API_KEY`. */
  apiKeyEnv: string
  /** Registration identity this recognizer occupies. */
  providerId: string
  /** Language hints this recognizer accepts. */
  languages: string[]
  /** Duplex recognition endpoint. */
  url: string
  /** Realtime recognition model name; the deployment's default and initial selection. */
  model: string
  /** Models this deployment offers for selection, in order; empty offers no choice. */
  models: string[]
  /** Whether the model labels speakers in its results. */
  speakerDiarization: boolean
  /** Maximum accepted recording duration in seconds. */
  maxDurationSeconds: number
  /** Deadline, in milliseconds, covering connect, upload, and result accumulation. */
  timeoutMs: number
  /** Deadline, in milliseconds, for the results sent after `task-finish`. */
  drainTimeoutMs: number
}

/** Validated deployment configuration; the loader supplies every default. */
export const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  providerId: z.string().min(1).default('dashscope-funasr'),
  languages: z.array(z.string().min(1)).default(['zh']),
  url: z.string().min(1).default(DASHSCOPE_DEFAULT_URL),
  model: z.string().min(1).default(DASHSCOPE_DEFAULT_MODEL),
  models: z.array(z.string().min(1)).default([]),
  speakerDiarization: z.boolean().default(true),
  maxDurationSeconds: z.number().min(1).default(4 * 3600),
  timeoutMs: z.number().step(1).min(1).default(600_000),
  drainTimeoutMs: z.number().step(1).min(1).default(30_000),
})

/**
 * Register the realtime recognizer; the registration is disposed with the plugin.
 * @param ctx - context exposing the speech registry and credential planes.
 * @param config - validated endpoint, model, limits, and key reference.
 */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  ctx.effect(() => ctx.speechToText.register(new DashScopeSpeechProvider({
    id: brandString<SpeechProviderId>(config.providerId),
    name: `DashScope ${config.model}`,
    url: config.url,
    model: config.model,
    models: config.models,
    languages: config.languages,
    speakerDiarization: config.speakerDiarization,
    maxDurationSeconds: config.maxDurationSeconds,
    timeoutMs: config.timeoutMs,
    drainTimeoutMs: config.drainTimeoutMs,
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
