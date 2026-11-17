/** Page-store join: config form × credential state × recognizer roster. */
import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SpeechSettingsStore, type SpeechHttpSection, type SpeechServiceConfig } from '../src/client/store.ts'
import type { SpeechSettingsOperations } from '../src/client/operations.ts'

/** One scripted config form over a mutable services document. */
function fakeForm(initial: SpeechServiceConfig[]): {
  readonly form: ConfigForm<SpeechHttpSection>
  readonly ops: { path: readonly string[]; value?: unknown }[]
} {
  let services = initial
  const listeners = new Set<() => void>()
  const ops: { path: readonly string[]; value?: unknown }[] = []
  let revision = 7
  const form: ConfigForm<SpeechHttpSection> = {
    getSnapshot: (): ConfigFormSnapshot<SpeechHttpSection> => ({
      status: 'ready', value: { services }, base: undefined, user: undefined,
      revision, writable: true,
    }),
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async mutations => {
      for (const mutation of mutations) ops.push({ path: mutation.path, value: mutation.value })
      const mutation = mutations[0]
      if (mutation !== undefined && mutation.path[0] === 'services') {
        services = mutation.value as SpeechServiceConfig[]
        revision++
        for (const listener of listeners) listener()
      }
      return true
    },
    set: async () => true,
    unset: async () => true,
  }
  return { form, ops }
}

/** One scripted operations face recording its calls. */
function fakeOperations(configured: Record<string, boolean> = {}): {
  readonly operations: SpeechSettingsOperations
  readonly calls: { keys: number; stored: [string, string][]; removed: string[]; selected: string[] }
} {
  const calls = { keys: 0, stored: [] as [string, string][], removed: [] as string[], selected: [] as string[] }
  return {
    calls,
    operations: {
      describeKeys: async refs => {
        calls.keys++
        return Object.fromEntries(refs.map(ref => [ref, configured[ref] ?? false]))
      },
      storeKey: async (ref, value) => { calls.stored.push([ref, value]); configured[ref] = true; return undefined },
      removeKey: async ref => { calls.removed.push(ref); configured[ref] = false; return undefined },
      roster: async () => ({
        providers: [
          { id: 'sensevoice-local', name: 'SenseVoiceSmall (INT8)', phase: 'ready', languages: ['auto', 'zh'] },
          { id: 'deepseek-asr', name: 'DeepSeek ASR', phase: 'ready', languages: ['auto'] },
        ],
        selected: 'sensevoice-local',
        language: 'zh',
      }),
      configure: async providerId => { calls.selected.push(providerId); return undefined },
    },
  }
}

const SERVICES: SpeechServiceConfig[] = [
  { providerId: 'deepseek-asr', name: 'DeepSeek ASR', endpoint: 'https://api.deepseek.com/v1/tools/asr',
    apiKeyEnv: 'DEEPSEEK_API_KEY', maxDurationSeconds: 120 },
  { providerId: 'dashscope-qwen3', endpoint: 'https://dashscope.example/transcriptions',
    apiKeyEnv: 'DASHSCOPE_API_KEY', model: 'qwen3-asr-flash' },
]

function mounted(initial: SpeechServiceConfig[] = SERVICES, configured: Record<string, boolean> = { DEEPSEEK_API_KEY: true }):
  { store: SpeechSettingsStore; ops: { path: readonly string[]; value?: unknown }[]; calls: ReturnType<typeof fakeOperations>['calls'] } {
  const { form, ops } = fakeForm(initial)
  const { operations, calls } = fakeOperations(configured)
  return { store: new SpeechSettingsStore(form, operations), ops, calls }
}

describe('speech settings store', () => {
  it('mirrors the document, credential state, and roster after one refresh', async () => {
    const { store } = mounted()
    const listener = vi.fn()
    store.subscribe(listener)
    await store.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.services).toHaveLength(2)
    expect(snapshot.writable).toBe(true)
    expect(snapshot.keyConfigured).toEqual({ DEEPSEEK_API_KEY: true, DASHSCOPE_API_KEY: false })
    expect(snapshot.roster?.selected).toBe('sensevoice-local')
    expect(snapshot.notice).toBeUndefined()
    expect(listener).toHaveBeenCalled()
  })

  it('saves one card as a whole-list set operation', async () => {
    const { store, ops } = mounted()
    await store.saveService(0, { name: 'Renamed' })
    expect(ops).toEqual([{ path: ['services'], value: expect.anything() }])
    expect(ops[0]?.value[0]).toMatchObject({ providerId: 'deepseek-asr', name: 'Renamed', endpoint: 'https://api.deepseek.com/v1/tools/asr' })
    expect(ops[0]?.value[1]).toMatchObject({ providerId: 'dashscope-qwen3' })
  })

  it('removes one service and clears the notice on accepted writes', async () => {
    const { store } = mounted()
    await store.removeService(1)
    expect(store.getSnapshot().services.map(service => service.providerId)).toEqual(['deepseek-asr'])
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('appends draft services with distinct ids', async () => {
    const { store } = mounted([])
    await store.addService()
    await store.addService()
    expect(store.getSnapshot().services.map(service => service.providerId)).toEqual(['new-service', 'new-service-1'])
    expect(store.getSnapshot().services[0]).toMatchObject({ mode: 'transcriptions', apiKeyEnv: 'NEW_ASR_API_KEY' })
  })

  it('stores and removes keys through the credential face and re-reads their state', async () => {
    const { store, calls } = mounted(SERVICES, configuredRecord())
    await store.storeKey('DASHSCOPE_API_KEY', 'sk-new')
    expect(calls.stored).toEqual([['DASHSCOPE_API_KEY', 'sk-new']])
    expect(store.getSnapshot().keyConfigured.DASHSCOPE_API_KEY).toBe(true)
    await store.removeKey('DEEPSEEK_API_KEY')
    expect(calls.removed).toEqual(['DEEPSEEK_API_KEY'])
    expect(store.getSnapshot().keyConfigured.DEEPSEEK_API_KEY).toBe(false)
  })

  it('switches the default recognizer through the speech face', async () => {
    const { store, calls } = mounted()
    await expect(store.selectProvider('deepseek-asr')).resolves.toBeUndefined()
    expect(calls.selected).toEqual(['deepseek-asr'])
  })

  it('re-reads the document when the form publishes a replacement', async () => {
    const { store } = mounted()
    const listener = vi.fn()
    store.subscribe(listener)
    await store.addService()
    expect(listener).toHaveBeenCalled()
    expect(store.getSnapshot().services).toHaveLength(3)
  })
})

function configuredRecord(): Record<string, boolean> {
  return { DEEPSEEK_API_KEY: true }
}
