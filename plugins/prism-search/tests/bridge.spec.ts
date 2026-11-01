/**
 * Settings bridge: reads the model catalog and both settings namespaces, writes
 * the chosen route with the revision that was read, and switches the web row's
 * provider only when that choice changed.
 */
import { describe, expect, it, vi } from 'vitest'
import { inject as clientInject } from '../src/client/services.ts'
import {
  createSettingsBridge, NAMESPACE, PROVIDER_ID, WEB_NAMESPACE,
  type ModelCatalog, type RemoteLike, type SettingsDescribeValue,
} from '../src/client/bridge.ts'

/** Two advertised models on one provider. */
const CATALOG: ModelCatalog = {
  groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] }],
}

/** A describe answer with both namespaces the bridge reads. */
function described(overrides: { searchProvider?: string; rerankProvider?: string; rerankModel?: string } = {}): SettingsDescribeValue {
  return {
    writable: true,
    namespaces: [
      {
        ns: NAMESPACE,
        revision: 3,
        value: {
          rerankProvider: overrides.rerankProvider ?? '',
          rerankModel: overrides.rerankModel ?? '',
        },
      },
      { ns: WEB_NAMESPACE, revision: 7, value: { searchProvider: overrides.searchProvider ?? 'deepseek-official' } },
    ],
  }
}

/** A Remote stub recording every mutate call. */
function remoteOf(view: SettingsDescribeValue = described()): { remote: RemoteLike; mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn(async (ns: string) => ({
    ok: true as const,
    value: { ns, revision: 1, value: {} },
  }))
  return {
    mutate,
    remote: {
      settings: {
        describe: async () => ({ ok: true as const, value: view }),
        mutate,
      },
      session: { modelCatalog: async () => ({ ok: true as const, value: CATALOG }) },
    },
  }
}

describe('createSettingsBridge', () => {
  it('declares the Remote namespaces the bridge calls as injected services', () => {
    expect(clientInject).toEqual(expect.arrayContaining(['remote', 'remote.settings', 'remote.session']))
  })

  it('loads the selection, the provider switch, and the model catalog', async () => {
    const { remote } = remoteOf(described({ rerankProvider: 'provider-a', rerankModel: 'large' }))
    const result = await createSettingsBridge(remote).load()
    expect(result).toEqual({
      ok: true,
      value: {
        writable: true,
        enabled: false,
        currentProvider: 'deepseek-official',
        rerankProvider: 'provider-a',
        rerankModel: 'large',
        models: [
          { provider: 'provider-a', providerName: 'Provider A', model: 'small', modelName: 'Small' },
          { provider: 'provider-a', providerName: 'Provider A', model: 'large', modelName: 'Large' },
        ],
        catalogError: '',
        webRevision: 7,
        ownRevision: 3,
      },
    })
  })

  it('reports a failed catalog read while still showing the stored route', async () => {
    const { remote } = remoteOf(described({ rerankProvider: 'provider-a', rerankModel: 'large' }))
    const failing: RemoteLike = {
      ...remote,
      session: { modelCatalog: async () => ({ ok: false as const, error: { message: 'provider unreachable' } }) },
    }
    const result = await createSettingsBridge(failing).load()
    expect(result.ok && result.value.catalogError).toBe('provider unreachable')
    expect(result.ok && result.value.rerankProvider).toBe('provider-a')
  })

  it('reports the switch as on when the web row already selects this provider', async () => {
    const { remote } = remoteOf(described({ searchProvider: PROVIDER_ID }))
    const result = await createSettingsBridge(remote).load()
    expect(result.ok && result.value.enabled).toBe(true)
  })

  it('fails when a namespace is not composed', async () => {
    const { remote } = remoteOf({ writable: true, namespaces: [{ ns: NAMESPACE, revision: 1, value: {} }] })
    const result = await createSettingsBridge(remote).load()
    expect(result).toEqual({ ok: false, message: `the ${WEB_NAMESPACE} settings section is not composed` })
  })

  it('writes the model route and the provider switch with the read revisions', async () => {
    const { remote, mutate } = remoteOf()
    const bridge = createSettingsBridge(remote)
    const view = await bridge.load()
    if (!view.ok) throw new Error('load failed')
    const result = await bridge.save({
      enabled: true,
      enabledChanged: true,
      model: { provider: 'provider-a', providerName: 'Provider A', model: 'large', modelName: 'Large' },
      webRevision: view.value.webRevision,
      ownRevision: view.value.ownRevision,
    })
    expect(result.ok).toBe(true)
    expect(mutate).toHaveBeenNthCalledWith(1, NAMESPACE, [
      { op: 'set', path: ['rerankProvider'], value: 'provider-a' },
      { op: 'set', path: ['rerankModel'], value: 'large' },
    ], 3)
    expect(mutate).toHaveBeenNthCalledWith(2, WEB_NAMESPACE, [
      { op: 'set', path: ['searchProvider'], value: PROVIDER_ID },
    ], 7)
  })

  it('clears the model route and unsets the provider when ordering is off', async () => {
    const { remote, mutate } = remoteOf(described({ searchProvider: PROVIDER_ID }))
    const bridge = createSettingsBridge(remote)
    const view = await bridge.load()
    if (!view.ok) throw new Error('load failed')
    await bridge.save({ enabled: false, enabledChanged: true, model: undefined, webRevision: 7, ownRevision: 3 })
    expect(mutate).toHaveBeenNthCalledWith(1, NAMESPACE, [
      { op: 'set', path: ['rerankProvider'], value: '' },
      { op: 'set', path: ['rerankModel'], value: '' },
    ], 3)
    expect(mutate).toHaveBeenNthCalledWith(2, WEB_NAMESPACE, [
      { op: 'unset', path: ['searchProvider'] },
    ], 7)
  })

  it('does not write the web row when the switch did not change', async () => {
    const { remote, mutate } = remoteOf(described({ searchProvider: PROVIDER_ID }))
    const bridge = createSettingsBridge(remote)
    await bridge.save({ enabled: true, enabledChanged: false, model: undefined, webRevision: 7, ownRevision: 3 })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('surfaces a rejected write', async () => {
    const { remote } = remoteOf()
    const failing: RemoteLike = {
      ...remote,
      settings: {
        ...remote.settings,
        mutate: async () => ({ ok: false as const, error: { message: 'stale revision' } }),
      },
    }
    const result = await createSettingsBridge(failing).save({ enabled: false, enabledChanged: false, model: undefined, webRevision: 7, ownRevision: 3 })
    expect(result).toEqual({ ok: false, message: 'stale revision' })
  })
})
