// Proves the recognizer composes the way a profile loads it: a cordis.yml naming
// both rows is composed through the real Loader, the seam comes up with the
// configured default, and a transcription reaches the endpoint that row named.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import * as SpeechToTextDefinition from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, describe, expect, it } from 'vitest'
import * as OpenAiProvider from '../src/index.ts'
import { startFakeEndpoint, waveRecording, type FakeTranscriptionEndpoint } from './fake-endpoint.fixture.ts'

let root: string | undefined
let context: Context | undefined
const endpoints: FakeTranscriptionEndpoint[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()))
})

/** Import mapped source modules without claiming support for Node's HMR internals. */
function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/**
 * Compose the seam and this recognizer from a cordis.yml through the real Loader.
 * @param baseUrl - endpoint the recognizer row names.
 * @returns The booted context.
 */
async function boot(baseUrl: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- id: speech-to-text",
    "  name: '@deepseek-ai/dsh-experimental-speech-to-text'",
    '  config:',
    '    defaultProvider: openai-transcription',
    '    language: auto',
    "- id: speech-to-text-openai",
    "  name: '@deepseek-ai/dsh-experimental-speech-to-text-openai'",
    '  config:',
    '    model: whisper-1',
    `    baseUrl: ${baseUrl}`,
    '    apiKey: sk-composed',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-experimental-speech-to-text', SpeechToTextDefinition],
    ['@deepseek-ai/dsh-experimental-speech-to-text-openai', OpenAiProvider],
  ])
  ctx.loader.internal = sourceModuleLoader(async (specifier) => {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('the OpenAI-compatible recognizer composition', () => {
  it('loads the seam and the recognizer from the configured rows', async () => {
    const endpoint = await startFakeEndpoint({ response: '{"text":"composed"}' })
    endpoints.push(endpoint)
    const ctx = await boot(endpoint.url)
    expect(ctx.get('speechToText')?.listProviders()).toEqual([{
      id: 'openai-transcription',
      name: 'OpenAI-compatible transcription',
      location: 'cloud',
      languages: ['auto'],
      model: 'whisper-1',
    }])
  }, 60_000)

  it('transcribes through the row that named the endpoint', async () => {
    const endpoint = await startFakeEndpoint({ response: '{"text":"composed"}' })
    endpoints.push(endpoint)
    const ctx = await boot(endpoint.url)
    const speech = ctx.get('speechToText')!
    const transcript = await speech.transcribe(
      speech.resolve({ audio: waveRecording(1) }),
      new AbortController().signal,
    )
    expect(transcript.text).toBe('composed')
    expect(transcript.audioSeconds).toBe(1)
    expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-composed')
  }, 60_000)
})
