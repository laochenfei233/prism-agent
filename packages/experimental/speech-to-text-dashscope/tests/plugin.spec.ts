/** Plugin registration, configuration defaults, and credential resolution. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it } from 'vitest'
import * as DashScopeProvider from '../src/index.ts'
import { FakeDashScopeService, waveRecording, type ServiceScript } from './fake-service.fixture.ts'

/** Configuration as the loader schema accepts it, with defaults still optional. */
type PluginConfig = Parameters<typeof DashScopeProvider.Config>[0]

const cleanups: Array<() => Promise<void>> = []
const services: FakeDashScopeService[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await Promise.all(services.splice(0).map(service => service.close()))
})

/** Register teardown; later registrations run first. */
function cleanup(task: () => Promise<void>): void {
  cleanups.push(task)
}

/** Start one stand-in service that this suite closes after the test. */
async function start(script: ServiceScript = {}): Promise<FakeDashScopeService> {
  const service = await FakeDashScopeService.start(script)
  services.push(service)
  return service
}

/**
 * Boot the seam and this plugin over one fresh context.
 * @param config - plugin configuration; the provider row this test registers.
 * @param ambient - values the inherited process layer supplies.
 * @returns The booted context with a live `speechToText` service.
 */
async function boot(config: PluginConfig, ambient: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  cleanup(async () => { await ctx.fiber.dispose() })
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: ambient }]))
  await ctx.plugin(SpeechToText, { defaultProvider: 'dashscope-funasr', language: 'zh' })
  await ctx.plugin(DashScopeProvider, DashScopeProvider.Config(config))
  return ctx
}

/**
 * Write one credential store holding a single reference.
 * @param name - credential reference name.
 * @param value - stored value.
 * @returns The store's path.
 */
async function credentialStore(name: string, value: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dashscope-credentials-'))
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
  const spec = speech.resolve({ audio: waveRecording(1), language: 'zh' })
  return (await speech.transcribe(spec, new AbortController().signal)).text
}

describe('the DashScope recognizer plugin', () => {
  it('registers its configured facts and withdraws them on disposal', async () => {
    const service = await start()
    const ctx = await boot({
      providerId: 'my-asr', model: 'my-model', url: service.url, languages: ['zh', 'en'], models: ['my-model', 'other'],
    })
    const speech = ctx.get('speechToText')!
    expect(speech.listProviders()).toEqual([{
      id: 'my-asr',
      name: 'DashScope my-model',
      location: 'cloud',
      languages: ['zh', 'en'],
      model: 'my-model',
      models: ['my-model', 'other'],
    }])
    await ctx.fiber.dispose()
    expect(speech.listProviders()).toEqual([])
  })

  it('applies the documented defaults when only the endpoint is configured', async () => {
    const service = await start()
    const ctx = await boot({ url: service.url })
    expect(ctx.get('speechToText')!.listProviders()).toEqual([{
      id: 'dashscope-funasr',
      name: 'DashScope fun-asr-realtime',
      location: 'cloud',
      languages: ['zh'],
      model: 'fun-asr-realtime',
    }])
  })

  it('prefers a pinned literal key over the credential plane', async () => {
    const service = await start({ sentences: [{ text: 'ok', final: true }] })
    const path = await credentialStore('DASHSCOPE_API_KEY', 'sk-stored')
    const ctx = await boot({ url: service.url, apiKey: 'sk-literal' })
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    expect(await transcribe(ctx)).toBe('ok')
    expect(service.authorizations).toEqual(['Bearer sk-literal'])
  })

  it('reads the key the credential reference names', async () => {
    const service = await start({ sentences: [{ text: 'ok', final: true }] })
    const path = await credentialStore('MY_ASR_KEY', 'sk-gateway')
    const ctx = await boot({ url: service.url, apiKeyEnv: 'MY_ASR_KEY' })
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    expect(await transcribe(ctx)).toBe('ok')
    expect(service.authorizations).toEqual(['Bearer sk-gateway'])
  })

  it('falls back to the launch environment when no credential plane is mounted', async () => {
    const service = await start({ sentences: [{ text: 'ok', final: true }] })
    const ctx = await boot({ url: service.url }, { DASHSCOPE_API_KEY: 'sk-ambient' })
    expect(await transcribe(ctx)).toBe('ok')
    expect(service.authorizations).toEqual(['Bearer sk-ambient'])
  })

  it.each([[{}], [{ DASHSCOPE_API_KEY: '' }]])(
    'reports a missing key when the environment supplies %o',
    async (ambient) => {
      const service = await start()
      const ctx = await boot({ url: service.url }, ambient)
      await expect(transcribe(ctx)).rejects.toThrow('requires an API key')
      expect(service.requests).toEqual([])
    },
  )
})
