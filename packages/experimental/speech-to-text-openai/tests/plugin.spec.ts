/** Plugin registration, configuration defaults, and credential resolution. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it } from 'vitest'
import * as OpenAiProvider from '../src/index.ts'
import { startFakeEndpoint, waveRecording, type FakeEndpointOptions, type FakeTranscriptionEndpoint } from './fake-endpoint.fixture.ts'

/** Configuration as the loader schema accepts it, with defaults still optional. */
type PluginConfig = Parameters<typeof OpenAiProvider.Config>[0]

const cleanups: Array<() => Promise<void>> = []
const endpoints: FakeTranscriptionEndpoint[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()))
})

/** Register teardown; later registrations run first. */
function cleanup(task: () => Promise<void>): void {
  cleanups.push(task)
}

/** Start one stand-in endpoint that this suite closes after the test. */
async function start(options: FakeEndpointOptions = {}): Promise<FakeTranscriptionEndpoint> {
  const endpoint = await startFakeEndpoint(options)
  endpoints.push(endpoint)
  return endpoint
}

/**
 * Boot the seam and the recognizer over one fresh context.
 * @param config - plugin configuration; `model` is required.
 * @param ambient - values the inherited process layer supplies.
 * @returns The booted context with a live `speechToText` service.
 */
async function boot(config: PluginConfig, ambient: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  cleanup(async () => { await ctx.fiber.dispose() })
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: ambient }]))
  await ctx.plugin(SpeechToText, { defaultProvider: 'openai-transcription', language: 'auto' })
  await ctx.plugin(OpenAiProvider, OpenAiProvider.Config(config))
  return ctx
}

/**
 * Write one credential store holding a single reference.
 * @param name - credential reference name.
 * @param value - stored value.
 * @returns The store's path.
 */
async function credentialStore(name: string, value: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-credentials-'))
  cleanup(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.credentials.yaml')
  await writeFile(path, `version: 1\nrefs:\n  ${name}: ${value}\n`, { mode: 0o600 })
  return path
}

/**
 * Transcribe one second of silence through the mounted recognizer.
 * @param ctx - context carrying the seam and the recognizer.
 * @returns The recognized text.
 */
async function transcribe(ctx: Context): Promise<string> {
  const speech = ctx.get('speechToText')!
  const spec = speech.resolve({ audio: waveRecording(1), language: 'auto' })
  return (await speech.transcribe(spec, new AbortController().signal)).text
}

describe('the OpenAI-compatible recognizer plugin', () => {
  it('registers its configured facts and withdraws them on disposal', async () => {
    const endpoint = await start({ response: '{"text":"ok"}' })
    const ctx = await boot({
      model: 'whisper-1', providerId: 'my-gateway', name: 'My gateway', languages: ['auto', 'zh'], baseUrl: endpoint.url,
    })
    const speech = ctx.get('speechToText')!
    expect(speech.listProviders()).toEqual([{
      id: 'my-gateway',
      name: 'My gateway',
      location: 'cloud',
      languages: ['auto', 'zh'],
      model: 'whisper-1',
    }])
    await ctx.fiber.dispose()
    expect(speech.listProviders()).toEqual([])
  })

  it('applies the documented defaults when only the model is configured', async () => {
    const ctx = await boot({ model: 'gpt-4o-transcribe' })
    expect(ctx.get('speechToText')!.listProviders()).toEqual([{
      id: 'openai-transcription',
      name: 'OpenAI-compatible transcription',
      location: 'cloud',
      languages: ['auto'],
      model: 'gpt-4o-transcribe',
    }])
  })

  it('prefers a pinned literal key over the credential plane', async () => {
    const endpoint = await start()
    const path = await credentialStore('OPENAI_API_KEY', 'sk-stored')
    const ctx = await boot({ model: 'whisper-1', baseUrl: endpoint.url, apiKey: 'sk-literal' })
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    expect(await transcribe(ctx)).toBe('hello')
    expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-literal')
  })

  it('treats an empty literal key as absent and reads the credential plane', async () => {
    const endpoint = await start()
    const path = await credentialStore('OPENAI_API_KEY', 'sk-stored')
    const ctx = await boot({ model: 'whisper-1', baseUrl: endpoint.url, apiKey: '' })
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    expect(await transcribe(ctx)).toBe('hello')
    expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-stored')
  })

  it('resolves the key through the credential reference it was configured with', async () => {
    const endpoint = await start()
    const path = await credentialStore('MY_GATEWAY_KEY', 'sk-gateway')
    const ctx = await boot({ model: 'whisper-1', baseUrl: endpoint.url, apiKeyEnv: 'MY_GATEWAY_KEY' })
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    expect(await transcribe(ctx)).toBe('hello')
    expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-gateway')
  })

  it('falls back to the launch environment when no credential plane is mounted', async () => {
    const endpoint = await start()
    const ctx = await boot({ model: 'whisper-1', baseUrl: endpoint.url }, { OPENAI_API_KEY: 'sk-ambient' })
    expect(await transcribe(ctx)).toBe('hello')
    expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-ambient')
  })

  it.each([[{}], [{ OPENAI_API_KEY: '' }]])(
    'reports a missing key when the environment supplies %o',
    async (ambient) => {
      const endpoint = await start()
      const ctx = await boot({ model: 'whisper-1', baseUrl: endpoint.url }, ambient)
      await expect(transcribe(ctx)).rejects.toThrow('requires an API key')
      expect(endpoint.requests).toEqual([])
    },
  )
})
