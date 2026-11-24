/**
 * The bundle's substance is its patch file, and the online half of it is a real
 * recognizer: this reads the patch the way the Loader does and then registers
 * the composed cloud provider against the real speech service, so a bundle that
 * stops offering an online recognizer fails here.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import * as DashScope from '@deepseek-ai/dsh-experimental-speech-to-text-dashscope'
import * as Plugin from '@deepseek-ai/dsh-experimental-speech-to-text-http'

/** The bundle package root. */
const root = fileURLToPath(new URL('..', import.meta.url))

/** One inserted row as the patch document declares it. */
interface Row {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
}

/** Every row the patch inserts, in declaration order. */
function insertedRows(): Row[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const parsed = parseEntryYaml(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'))
  if (!Array.isArray(parsed)) throw new TypeError('the voice-input patch must parse to a patch list')
  const rows = (parsed as { insert?: Row[] }[]).flatMap(patch => patch.insert ?? [])
  // Every bare package the patch mounts must be resolvable from this package.
  for (const row of rows) {
    if (row.name?.startsWith('@')) expect(manifest.dependencies).toHaveProperty(row.name)
  }
  return rows
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('voice-input bundle composition', () => {
  it('mounts the recognizers, the built-in HTTP services, the server Remote, and the browser control', () => {
    const rows = insertedRows()
    expect(rows.map(row => row.id)).toEqual([
      'speech-to-text',
      'speech-to-text-sensevoice',
      'speech-to-text-dashscope',
      'speech-to-text-http',
      'api-speech-to-text',
      'ui-voice-input',
      'client-ui-settings-speech',
    ])
    expect(rows.find(row => row.id === 'speech-to-text-dashscope')?.name)
      .toBe('@deepseek-ai/dsh-experimental-speech-to-text-dashscope')
    expect(rows.find(row => row.id === 'speech-to-text-sensevoice')?.name)
      .toBe('@deepseek-ai/dsh-experimental-speech-to-text-sensevoice')
    expect(rows.find(row => row.id === 'speech-to-text-http')?.name)
      .toBe('@deepseek-ai/dsh-experimental-speech-to-text-http')
    expect(rows.find(row => row.id === 'client-ui-settings-speech')?.name)
      .toBe('@deepseek-ai/dsh-experimental-client-ui-settings-speech')
    expect(rows.find(row => row.id === 'speech-to-text-http')?.config).toEqual({
      services: [
        { providerId: 'deepseek-asr', name: 'DeepSeek ASR', endpoint: 'https://api.deepseek.com/v1/tools/asr',
          apiKeyEnv: 'DEEPSEEK_API_KEY', maxAudioBytes: 8 * 1024 * 1024, maxDurationSeconds: 120 },
        { providerId: 'dashscope-qwen3', name: 'DashScope qwen3-asr',
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions',
          apiKeyEnv: 'DASHSCOPE_API_KEY', model: 'qwen3-asr-flash' },
      ],
    })
  })

  it('keeps the local recognizer as the default and one language both accept', () => {
    const rows = insertedRows()
    expect(rows.find(row => row.id === 'speech-to-text')?.config).toEqual({
      defaultProvider: 'sensevoice-local',
      language: 'zh',
    })
  })

  it('registers the online recognizer over the real speech service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) })
    await ctx.plugin(SpeechToText, { defaultProvider: 'dashscope-funasr', language: 'zh' })
    await ctx.plugin(DashScope)

    const [provider] = ctx.speechToText.snapshot().providers
    expect(provider).toMatchObject({
      id: 'dashscope-funasr',
      location: 'cloud',
      languages: ['zh'],
      // A cloud recognizer downloads nothing, so the UI offers no setup step.
      preparation: { phase: 'ready' },
    })
    expect(ctx.speechToText.snapshot().selection).toEqual({
      providerId: 'dashscope-funasr',
      language: 'zh',
    })
  })

  it('pins the online recognizer for zh and refuses a hint it does not declare', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) })
    await ctx.plugin(SpeechToText, { defaultProvider: 'dashscope-funasr', language: 'zh' })
    await ctx.plugin(DashScope)

    const audio = new Uint8Array([1, 2, 3])
    expect(ctx.speechToText.resolve({ audio }).provider.info.id).toBe('dashscope-funasr')
    expect(() => ctx.speechToText.resolve({ audio, language: 'auto' }))
      .toThrow('Speech provider dashscope-funasr does not support language: auto')
  })

  it('registers both built-in HTTP services with their loader defaults', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) })
    await ctx.plugin(SpeechToText, { defaultProvider: 'deepseek-asr', language: 'auto' })
    await ctx.plugin(Plugin, {
      services: [
        { providerId: 'deepseek-asr', name: 'DeepSeek ASR', endpoint: 'https://api.deepseek.com/v1/tools/asr',
          apiKeyEnv: 'DEEPSEEK_API_KEY', maxAudioBytes: 8 * 1024 * 1024, maxDurationSeconds: 120 },
        { providerId: 'dashscope-qwen3', name: 'DashScope qwen3-asr',
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions',
          apiKeyEnv: 'DASHSCOPE_API_KEY', model: 'qwen3-asr-flash' },
      ],
    })
    expect(ctx.speechToText.snapshot().providers).toEqual([
      { id: 'deepseek-asr', name: 'DeepSeek ASR', location: 'cloud', languages: ['auto'],
        maxAudioSeconds: 120, preparation: { phase: 'ready' } },
      { id: 'dashscope-qwen3', name: 'DashScope qwen3-asr', location: 'cloud', languages: ['auto'],
        model: 'qwen3-asr-flash', maxAudioSeconds: 819, preparation: { phase: 'ready' } },
    ])
  })
})
