/** Model selection: capability reporting, validation, and per-call forwarding. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SpeechToText from '../src/index.ts'
import type { SpeechProvider, SpeechProviderId, Transcript } from '../src/types.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const result: Transcript = { text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 }
const audio = new Uint8Array([1, 2])
const input = new AbortController().signal

/** One recognizer offering a live session, so both resolution paths are reachable. */
function provider(id: string, models?: readonly string[]) {
  const transcribe = vi.fn(async () => result)
  const open = vi.fn(async () => ({
    push: async () => {},
    close: async () => {},
    cancel: async () => {},
    async *events(): AsyncIterable<never> {},
  }))
  const recognizer: SpeechProvider = {
    info: { id: id as SpeechProviderId, name: id, location: 'cloud', languages: ['auto', 'zh'],
      ...models === undefined ? {} : { models } },
    transcribe,
    streaming: { mode: 'duplex', open },
  }
  return { recognizer, transcribe, open }
}

/** Mount the service behind Loader with a settings stub that writes patches into its live entry config. */
async function mounted(config: object) {
  const ctx = new Context()
  const live = await liveConfig(ctx, SpeechToText, config)
  const writes: object[] = []
  ctx.provide('settings', {
    update: async (_entry: string, patch: Record<string, unknown>) => { writes.push(patch); await live.update(patch) },
  } as never)
  return { ctx, speech: ctx.get('speechToText')!, writes }
}

describe('model selection', () => {
  it('reports the models each recognizer offers', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText, { defaultProvider: 'choosy', language: 'auto' })
    await base
    try {
      const speech = ctx.get('speechToText')!
      speech.register(provider('choosy', ['small', 'large']).recognizer)
      speech.register(provider('fixed').recognizer)
      expect(speech.snapshot().providers.map(view => view.models)).toEqual([['small', 'large'], undefined])
      expect(speech.snapshot().selection).toEqual({ providerId: 'choosy', language: 'auto' })
    } finally { await base.dispose() }
  })

  it('persists the chosen model and forwards it to the recognizer', async () => {
    const { ctx, speech, writes } = await mounted({ defaultProvider: 'choosy', language: 'auto' })
    try {
      const choosy = provider('choosy', ['small', 'large'])
      speech.register(choosy.recognizer)
      await speech.configure({ model: 'large' })
      expect(writes).toEqual([{ model: 'large' }])
      expect(speech.snapshot().selection).toEqual({ providerId: 'choosy', language: 'auto', model: 'large' })
      const spec = speech.resolve({ audio })
      expect(spec).toMatchObject({ language: 'auto', model: 'large' })
      expect(await speech.transcribe(spec, input)).toEqual(result)
      expect(choosy.transcribe).toHaveBeenCalledWith(
        { audio, language: 'auto', model: 'large' },
        expect.any(AbortSignal),
      )
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves the model out when the recognizer keeps its own default', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText, { defaultProvider: 'choosy', language: 'auto' })
    await base
    try {
      const speech = ctx.get('speechToText')!
      const choosy = provider('choosy', ['small', 'large'])
      speech.register(choosy.recognizer)
      const spec = speech.resolve({ audio })
      expect(spec).toEqual({ provider: choosy.recognizer, audio, language: 'auto' })
      await speech.transcribe(spec, input)
      expect(choosy.transcribe).toHaveBeenCalledWith({ audio, language: 'auto' }, expect.any(AbortSignal))
    } finally { await base.dispose() }
  })

  it('refuses a model the selected recognizer does not offer', async () => {
    const { ctx, speech, writes } = await mounted({ defaultProvider: 'choosy', language: 'auto' })
    try {
      speech.register(provider('choosy', ['small']).recognizer)
      speech.register(provider('fixed').recognizer)
      await expect(speech.configure({ model: 'large' })).rejects.toThrow('does not offer model: large')
      expect(writes).toEqual([])
      expect(speech.snapshot().selection).toEqual({ providerId: 'choosy', language: 'auto' })
      expect(() => speech.resolve({ audio, model: 'large' })).toThrow('does not offer model: large')
      expect(() => speech.resolveStream({ model: 'large' })).toThrow('does not offer model: large')
      await expect(speech.configure({ providerId: 'fixed' as SpeechProviderId, model: 'any' }))
        .rejects.toThrow('does not offer model: any')
      expect(writes).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('drops the previous model when another recognizer is selected', async () => {
    const { ctx, speech, writes } = await mounted({ defaultProvider: 'choosy', language: 'auto' })
    try {
      speech.register(provider('choosy', ['small', 'large']).recognizer)
      speech.register(provider('fixed').recognizer)
      await speech.configure({ model: 'large' })
      await speech.configure({ providerId: 'fixed' as SpeechProviderId })
      expect(speech.snapshot().selection).toEqual({ providerId: 'fixed', language: 'auto' })
      await expect(speech.configure({ providerId: 'fixed' as SpeechProviderId, model: 'large' }))
        .rejects.toThrow('does not offer model: large')
      expect(writes).toEqual([{ model: 'large' }, { defaultProvider: 'fixed', model: '' }])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps the chosen model when the same recognizer is named again', async () => {
    const { ctx, speech } = await mounted({ defaultProvider: 'choosy', language: 'auto' })
    try {
      speech.register(provider('choosy', ['small', 'large']).recognizer)
      await speech.configure({ model: 'large' })
      await speech.configure({ providerId: 'choosy' as SpeechProviderId })
      expect(speech.snapshot().selection).toEqual({ providerId: 'choosy', language: 'auto', model: 'large' })
    } finally { await ctx.fiber.dispose() }
  })

  it('carries the chosen model into a live session', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText, { defaultProvider: 'choosy', language: 'zh', model: 'large' })
    await base
    try {
      const speech = ctx.get('speechToText')!
      const choosy = provider('choosy', ['small', 'large'])
      speech.register(choosy.recognizer)
      const spec = speech.resolveStream({})
      expect(spec).toMatchObject({ language: 'zh', model: 'large' })
      await speech.openStream(spec, input)
      expect(choosy.open).toHaveBeenCalledWith({ language: 'zh', model: 'large' }, expect.any(AbortSignal))
      expect(() => speech.resolveStream({ model: 'missing' })).toThrow('does not offer model: missing')
    } finally { await base.dispose() }
  })
})
