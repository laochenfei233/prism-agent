/**
 * Browser bridge over the Host's Remote namespaces: the plugin's own settings
 * section, the web service's provider selection, and the model catalog the
 * Models page owns. The model list is never hardcoded; it is whatever the
 * deployment's configured providers currently advertise.
 *
 * @module @prism/prism-search/client/bridge
 */

/** Settings namespace of this plugin's Host row. */
export const NAMESPACE = 'prism-search'

/** Settings namespace of the web service row. */
export const WEB_NAMESPACE = 'web'

/** Provider id this plugin registers and the web row selects. */
export const PROVIDER_ID = 'prism-search'

/** One Remote call's answer. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** One path-addressed settings edit. */
export type SettingsOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: string }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** One settings namespace as the Host describes it. */
export interface SettingsNamespaceView {
  /** Namespace key. */
  readonly ns: string
  /** Redacted resolved value. */
  readonly value: unknown
  /** Revision this value was read at. */
  readonly revision: number
}

/** The settings page's read answer. */
export interface SettingsDescribeValue {
  /** Whether the profile accepts writes. */
  readonly writable: boolean
  /** One view per active profile entry. */
  readonly namespaces: readonly SettingsNamespaceView[]
}

/** One model advertised by a configured provider. */
export interface ModelCatalogModel {
  /** Provider model id. */
  readonly id: string
  /** Display name. */
  readonly name: string
}

/** One provider's advertised models. */
export interface ModelProviderGroup {
  /** Provider route id. */
  readonly id: string
  /** Provider display name. */
  readonly name: string
  /** Advertised models. */
  readonly models: readonly ModelCatalogModel[]
}

/** The model catalog the Models page builds. */
export interface ModelCatalog {
  /** Provider-grouped models. */
  readonly groups: readonly ModelProviderGroup[]
}

/** The Remote namespaces this bundle calls. */
export interface RemoteLike {
  readonly settings: {
    /** Read every namespace with its revision. */
    describe(): Promise<RemoteResult<SettingsDescribeValue>>
    /**
     * Apply path edits to one namespace.
     * @param ns - namespace key.
     * @param ops - edits to apply.
     * @param expectedRevision - revision the caller read.
     */
    mutate(ns: string, ops: readonly SettingsOp[], expectedRevision?: number): Promise<RemoteResult<SettingsNamespaceView>>
  }
  readonly session: {
    /** Describe every routable model. */
    modelCatalog(): Promise<RemoteResult<ModelCatalog>>
  }
}

/** One selectable model route. */
export interface ModelOption {
  /** Provider route. */
  readonly provider: string
  /** Provider display name. */
  readonly providerName: string
  /** Model id. */
  readonly model: string
  /** Model display name. */
  readonly modelName: string
}

/** Everything the settings section renders. */
export interface SearchSettingsView {
  /** Whether the profile accepts writes. */
  readonly writable: boolean
  /** Whether the web row currently selects this provider. */
  readonly enabled: boolean
  /** The web row's effective search provider id, empty when it inherits. */
  readonly currentProvider: string
  /** Configured ordering provider route. */
  readonly rerankProvider: string
  /** Configured ordering model id. */
  readonly rerankModel: string
  /** Every model the Models page currently advertises. */
  readonly models: readonly ModelOption[]
  /** Why the catalog read failed, empty when it succeeded. */
  readonly catalogError: string
  /** Revision of the web row's settings. */
  readonly webRevision: number
  /** Revision of this plugin's settings. */
  readonly ownRevision: number
}

/** One staged save. */
export interface SaveRequest {
  /** Whether the web row should select this provider. */
  readonly enabled: boolean
  /** Whether that selection differs from what was read. */
  readonly enabledChanged: boolean
  /** The chosen ordering model, or undefined to disable ordering. */
  readonly model: ModelOption | undefined
  /** Revision read for the web row. */
  readonly webRevision: number
  /** Revision read for this plugin's row. */
  readonly ownRevision: number
}

/** A bridge answer: the value or an actionable message. */
export type BridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/** The settings section's data operations. */
export interface SettingsBridge {
  /** Read the current selection and the model catalog. */
  load(): Promise<BridgeResult<SearchSettingsView>>
  /**
   * Persist the staged choice.
   * @param request - provider switch, model, and the revisions that were read.
   */
  save(request: SaveRequest): Promise<BridgeResult<void>>
}

/**
 * Build the bridge over the Host's Remote namespaces.
 * @param remote - the Client Remote service.
 * @returns the settings operations the section calls.
 */
export function createSettingsBridge(remote: RemoteLike): SettingsBridge {
  return {
    async load(): Promise<BridgeResult<SearchSettingsView>> {
      const [described, catalog] = await Promise.all([remote.settings.describe(), remote.session.modelCatalog()])
      if (!described.ok) return { ok: false, message: described.error.message }
      const own = described.value.namespaces.find(view => view.ns === NAMESPACE)
      const web = described.value.namespaces.find(view => view.ns === WEB_NAMESPACE)
      if (own === undefined) return { ok: false, message: `the ${NAMESPACE} settings section is not composed` }
      if (web === undefined) return { ok: false, message: `the ${WEB_NAMESPACE} settings section is not composed` }
      const ownValue = objectOf(own.value)
      const webValue = objectOf(web.value)
      const currentProvider = stringOf(webValue?.['searchProvider']) ?? ''
      const models = catalog.ok
        ? catalog.value.groups.flatMap(group => group.models.map((model): ModelOption => ({
          provider: group.id,
          providerName: group.name,
          model: model.id,
          modelName: model.name,
        })))
        : []
      return {
        ok: true,
        value: {
          writable: described.value.writable,
          enabled: currentProvider === PROVIDER_ID,
          currentProvider,
          rerankProvider: stringOf(ownValue?.['rerankProvider']) ?? '',
          rerankModel: stringOf(ownValue?.['rerankModel']) ?? '',
          models,
          catalogError: catalog.ok ? '' : catalog.error.message,
          webRevision: web.revision,
          ownRevision: own.revision,
        },
      }
    },

    async save(request: SaveRequest): Promise<BridgeResult<void>> {
      const own = await remote.settings.mutate(NAMESPACE, [
        { op: 'set', path: ['rerankProvider'], value: request.model?.provider ?? '' },
        { op: 'set', path: ['rerankModel'], value: request.model?.model ?? '' },
      ], request.ownRevision)
      if (!own.ok) return { ok: false, message: own.error.message }
      if (!request.enabledChanged) return { ok: true, value: undefined }
      const web = await remote.settings.mutate(WEB_NAMESPACE, request.enabled
        ? [{ op: 'set', path: ['searchProvider'], value: PROVIDER_ID }]
        : [{ op: 'unset', path: ['searchProvider'] }], request.webRevision)
      if (!web.ok) return { ok: false, message: web.error.message }
      return { ok: true, value: undefined }
    },
  }
}

/** Narrow a settings value to a plain object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a non-empty string member. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
