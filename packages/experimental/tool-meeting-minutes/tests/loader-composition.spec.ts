// Proves the tool's whole contract through a REAL Loader composition: a cordis.yml
// boots the tool beside the filesystem and speech seams, the model-facing call runs
// through the ordinary tool pipeline, and the transcript file lands on disk.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as SpeechToTextDefinition from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import * as FileSystemLocal from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MeetingMinutes from '../src/index.ts'

/** Transcript the stub recognizer returns; long enough to exercise the preview bound. */
const STUB_TRANSCRIPT = Array.from({ length: 40 }, (_, index) => `第${index + 1}句讨论内容`).join('\n')

/** A recognizer with no external dependency, registered into the real speech registry. */
const StubSpeechProvider = {
  name: 'stub-speech-provider',
  inject: ['speechToText'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.speechToText.register({
      info: { id: 'stub' as SpeechProviderId, name: 'Stub recognizer', location: 'cloud', languages: ['zh'] },
      transcribe: async () => ({ text: STUB_TRANSCRIPT, audioSeconds: 90, inferenceSeconds: 0.25 }),
    }))
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a canonical 16 kHz mono PCM16 WAV recording of silence. */
function waveRecording(seconds: number): Buffer {
  const samples = 16_000 * seconds
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

/** Produce a recording inside the test workspace and return its absolute path. */
async function recording(name: string, bytes: Buffer = waveRecording(1)): Promise<string> {
  const path = join(root as string, name)
  await writeFile(path, bytes)
  return path
}

async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('meeting-minutes-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml composing the tool with the filesystem and speech seams.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-meeting-minutes-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-experimental-speech-to-text'",
    '  config:',
    '    defaultProvider: stub',
    '    language: zh',
    "- name: 'stub-speech-provider'",
    "- name: '@deepseek-ai/dsh-experimental-tool-meeting-minutes'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', FileSystemLocal],
    ['@deepseek-ai/dsh-experimental-speech-to-text', SpeechToTextDefinition],
    ['stub-speech-provider', StubSpeechProvider],
    ['@deepseek-ai/dsh-experimental-tool-meeting-minutes', MeetingMinutes],
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

describe('meeting_minutes real Loader composition through cordis.yml', () => {
  it('transcribes a recording, writes the transcript beside it, and returns the minutes structure', async () => {
    const ctx = await boot()
    const audioPath = await recording('weekly.wav')
    const owner = await agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('minutes'),
      name: 'meeting_minutes',
      arguments: { audio_path: audioPath, title: 'Weekly sync', participants: ['Ada', 'Grace'], template: 'action-focused' },
      agent: owner,
    })

    expect(result.isError).toBe(false)
    const text = resultText(result)
    expect(text).toContain('90.0s of audio')
    expect(text).toContain(join(root as string, 'weekly.minutes.md'))
    expect(text).toContain('## 行动项清单')

    const transcriptPath = join(root as string, 'weekly.transcript.md')
    const written = await readFile(transcriptPath, 'utf8')
    expect(written).toContain('# Transcript: Weekly sync')
    expect(written).toContain('- Participants: Ada, Grace')
    expect(written).toContain('- Duration: 1:30')
    expect(written).toContain(STUB_TRANSCRIPT)
    expect(text).toContain(transcriptPath)
  }, 60_000)

  it('applies the default structure when the model chooses none', async () => {
    const ctx = await boot()
    const audioPath = await recording('standup.wav')
    const owner = await agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('default-template'),
      name: 'meeting_minutes',
      arguments: { audio_path: audioPath },
      agent: owner,
    })
    expect(resultText(result)).toContain('## 议题与讨论')
    expect(resultText(result)).toContain(join(root as string, 'standup.minutes.md'))
  }, 60_000)

  it('bounds the returned transcript by its configured preview length', async () => {
    const ctx = await boot(['    maxPreviewCharacters: 12'])
    const audioPath = await recording('long.wav')
    const owner = await agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('bounded'),
      name: 'meeting_minutes',
      arguments: { audio_path: audioPath },
      agent: owner,
    })
    const text = resultText(result)
    expect(text).toContain(STUB_TRANSCRIPT.slice(0, 12))
    expect(text).not.toContain(STUB_TRANSCRIPT)
    expect(text).toContain('read ')
  }, 60_000)

  it('rejects a recording that does not exist', async () => {
    const ctx = await boot()
    const owner = await agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('missing'),
      name: 'meeting_minutes',
      arguments: { audio_path: join(root as string, 'absent.wav') },
      agent: owner,
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('not found')
  }, 60_000)

  it('fails loading when a configured limit is not a positive count', async () => {
    await expect(boot(['    maxPreviewCharacters: 0'])).rejects.toThrow('$.maxPreviewCharacters')
  }, 60_000)
})
