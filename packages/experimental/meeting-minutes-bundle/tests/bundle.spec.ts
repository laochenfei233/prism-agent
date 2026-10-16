// Proves the bundle's SHIPPED cordis.patch.yml composes the whole capability: the
// patch file is composed through the boot's own algorithm, booted through the real
// Loader, and the seam, the recognizer, and the model-facing tool all come up.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as SpeechToTextDefinition from '@deepseek-ai/dsh-experimental-speech-to-text'
import * as DashScopeProvider from '@deepseek-ai/dsh-experimental-speech-to-text-dashscope'
import * as MeetingMinutesTool from '@deepseek-ai/dsh-experimental-tool-meeting-minutes'
import FileSystemLocal from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** Plugin name prefix the bundle's patch rows carry. */
const BUNDLE_DIR = fileURLToPath(new URL('..', import.meta.url))

interface BundleManifest {
  readonly dsh: { readonly bundle: { readonly patch: string | string[] } }
}

/** The rows the shipped patch file declares, composed by the boot's own algorithm. */
function rows(): { id?: string; name?: string; config?: unknown }[] {
  const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, 'package.json'), 'utf8')) as BundleManifest
  const patches = bundlePatchPaths(BUNDLE_DIR, manifest.dsh.bundle).flatMap(file => loadOverlayPatches('dsh', file))
  return composeEntries([patches])
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the shipped patch's rows through the real Loader.
 * @returns the booted context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-meeting-bundle-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    // The surrounding composition a profile supplies: the tool registry, its prompt
    // provider, and a filesystem backend. The bundle's own patch adds only its rows.
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    ...rows().map(row => [
      `- id: ${row.id ?? ''}`,
      `  name: '${row.name ?? ''}'`,
      ...row.config === undefined || row.config === null
        ? []
        : [`  config: ${JSON.stringify(row.config)}`],
    ].join('\n')),
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', FileSystemLocal],
    ['@deepseek-ai/dsh-experimental-speech-to-text', SpeechToTextDefinition],
    ['@deepseek-ai/dsh-experimental-speech-to-text-dashscope', DashScopeProvider],
    ['@deepseek-ai/dsh-experimental-tool-meeting-minutes', MeetingMinutesTool],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('the meeting-minutes bundle patch', () => {
  it('declares the registry, its recognizer, and the model-facing tool in that order', () => {
    expect(rows().map(row => row.id)).toEqual(['speech-to-text', 'speech-to-text-dashscope', 'tool-meeting-minutes'])
    expect(rows().map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-experimental-speech-to-text',
      '@deepseek-ai/dsh-experimental-speech-to-text-dashscope',
      '@deepseek-ai/dsh-experimental-tool-meeting-minutes',
    ])
  })

  it('boots the bundled capability with the configured default recognizer', async () => {
    const ctx = await boot()
    expect(ctx.get('speechToText')).toBeDefined()
    expect(ctx.get('speechToText')?.listProviders()).toEqual([
      {
        id: 'dashscope-funasr',
        name: 'DashScope fun-asr-realtime',
        location: 'cloud',
        languages: ['zh'],
        model: 'fun-asr-realtime',
      },
    ])
    const tool = ctx.tools.schemas().find(schema => schema.name === 'meeting_minutes')
    expect(tool).toBeDefined()
    expect(tool?.description).toContain('16 kHz mono 16-bit PCM WAV')
  }, 60_000)
})
