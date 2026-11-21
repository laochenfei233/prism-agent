/**
 * Model-callable meeting minutes: transcribe one recording through `ctx.speechToText`,
 * store the transcript beside it, and hand the model the structure to fill in.
 *
 * This tool does not write the minutes. The calling agent owns the minutes text and
 * writes it with its own file tools.
 * @module @deepseek-ai/dsh-experimental-tool-meeting-minutes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MINUTES_TEMPLATE, MINUTES_TEMPLATES, MINUTES_TEMPLATE_IDS } from './templates.ts'
import type { MinutesTemplateId } from './templates.ts'
import { previewTranscript, renderTranscriptDocument } from './transcript.ts'

export const name = 'experimental-tool-meeting-minutes'

/** The registries and filesystem this tool reads recordings through. */
export const inject = ['tools', 'fs', 'speechToText']

/** Suffix of the transcript document written beside the recording. */
const TRANSCRIPT_SUFFIX = '.transcript.md'

/** Suffix of the minutes document the model is asked to write. */
const MINUTES_SUFFIX = '.minutes.md'

/** Meeting-minutes tool configuration. */
export interface Config {
  /** Largest recording this tool reads into memory, in bytes. */
  maxAudioBytes: number
  /** Characters of the transcript carried into the model-visible result. */
  maxPreviewCharacters: number
}

/** Schemastery configuration for the meeting-minutes tool. */
export const Config: z<Config> = z.object({
  maxAudioBytes: z.natural().min(46).default(512 * 1024 * 1024),
  maxPreviewCharacters: z.natural().min(1).default(4000),
})

/**
 * Replace a path's final extension, keeping the caller's path space (relative stays
 * relative, and a backend-specific separator is never synthesized).
 * @param path - the path the caller supplied.
 * @param suffix - the suffix to apply, including its leading dot.
 * @returns the path with the final extension replaced, or the suffix appended.
 */
function withSuffix(path: string, suffix: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  return dot > separator ? `${path.slice(0, dot)}${suffix}` : `${path}${suffix}`
}

/**
 * The final path segment, used as the meeting title when the caller names none.
 * @param path - a workspace path.
 * @returns the last segment.
 */
function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** Filesystem resolution options shared with the model-facing file tools. */
function resolveOptions(exec: ToolExecution): { cwd?: string; signal: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd
  return { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }
}

/** Model-facing description of the tool's contract. */
function describe(): string {
  return [
    'Transcribe one meeting recording and prepare a meeting-minutes structure for it.',
    'The recording must be a 16 kHz mono 16-bit PCM WAV file; convert anything else first.',
    'This tool writes the transcript next to the recording and returns a preview of it.',
    'It does NOT write the minutes: read the returned transcript (the file, when the preview is truncated),',
    'then write the minutes yourself to the suggested path, filling in the returned structure.',
  ].join(' ')
}

/**
 * Register the meeting-minutes tool; disposing the plugin unregisters it.
 * @param ctx - context exposing the tool registry, filesystem, and speech registry.
 * @param config - validated read and preview limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'meeting_minutes',
    description: describe(),
    parameters: {
      audio_path: {
        type: 'string',
        required: true,
        description: 'Path to the recording, relative to the workspace or absolute. Must be 16 kHz mono PCM16 WAV.',
      },
      title: {
        type: 'string',
        description: 'Meeting title. Defaults to the recording file name.',
      },
      participants: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of the people in the meeting. The recognizer does not identify speakers, so only what you are told.',
      },
      template: {
        type: 'string',
        enum: [...MINUTES_TEMPLATE_IDS],
        description: 'Minutes structure to fill. Defaults to default.',
      },
      language: {
        type: 'string',
        description: 'Language hint for the recognizer; omit to use this composition\'s configured default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordingPath: { type: 'string', required: true },
          transcriptPath: { type: 'string', required: true },
          minutesPath: { type: 'string', required: true },
          transcriptCharacters: { type: 'integer', required: true },
          transcriptPreview: { type: 'string', required: true },
          previewTruncated: { type: 'boolean', required: true },
          audioSeconds: { type: 'number', required: true },
          inferenceSeconds: { type: 'number', required: true },
          template: { type: 'string', required: true, enum: [...MINUTES_TEMPLATE_IDS] },
          minutesTemplate: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Transcribed ${value.recordingPath}: ${value.audioSeconds.toFixed(1)}s of audio, ${value.transcriptCharacters} characters of transcript.`,
          `Transcript written to ${value.transcriptPath}.`,
          ...value.previewTruncated
            ? [`Only the first ${value.transcriptPreview.length} characters follow; read ${value.transcriptPath} for the rest.`]
            : [],
          '',
          value.transcriptPreview,
          '',
          `Write the minutes to ${value.minutesPath} using this structure:`,
          '',
          value.minutesTemplate,
        ].join('\n'),
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Transcribe ${args.audio_path}`,
      kind: 'read',
      locations: [{ path: args.audio_path }],
    }),
    async execute(args, exec) {
      const source = await ctx.fs.resolve(args.audio_path, resolveOptions(exec))
      const info = await ctx.fs.stat(source, exec.signal)
      if (info === undefined) {
        throw new FsError(`cannot transcribe "${source.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot transcribe "${source.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      const audio = await ctx.fs.readBytes(source, exec.signal, config.maxAudioBytes)
      const spec = ctx.speechToText.resolve({
        audio,
        ...args.language === undefined ? {} : { language: args.language },
      })
      const transcript = await ctx.speechToText.transcribe(spec, exec.signal)
      const prefix = withSuffix(args.audio_path, '')
      const transcriptPath = `${prefix}${TRANSCRIPT_SUFFIX}`
      const minutesPath = `${prefix}${MINUTES_SUFFIX}`
      const document = renderTranscriptDocument({
        title: args.title ?? baseName(args.audio_path),
        participants: args.participants ?? [],
        transcribedAt: new Date(),
        audioSeconds: transcript.audioSeconds,
        recordingPath: source.displayPath,
        text: transcript.text,
      })
      const target = await ctx.fs.resolve(transcriptPath, resolveOptions(exec))
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, document, intent, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      const { preview, truncated } = previewTranscript(transcript.text, config.maxPreviewCharacters)
      const template: MinutesTemplateId = args.template ?? DEFAULT_MINUTES_TEMPLATE
      return {
        recordingPath: source.displayPath,
        transcriptPath: target.displayPath,
        minutesPath,
        transcriptCharacters: transcript.text.length,
        transcriptPreview: preview,
        previewTruncated: truncated,
        audioSeconds: transcript.audioSeconds,
        inferenceSeconds: transcript.inferenceSeconds,
        template,
        minutesTemplate: MINUTES_TEMPLATES[template],
      }
    },
  }))
}
