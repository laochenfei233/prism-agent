/**
 * Wire and domain types shared by the host service, the API routes, and the
 * browser card.
 *
 * @module @prism/prism-local-models
 */

/** Lifecycle of one model family. `provisioning` covers runtime setup after the files land. */
export type ModelStatus = 'idle' | 'downloading' | 'provisioning' | 'ready' | 'error'

/** What the model family is for; the card renders it as a chip. */
export type ModelKind = 'ocr' | 'translation' | 'embedding'

/** Compute target requested by a variant; probes fail loud when unavailable. */
export type ModelDevice = 'cpu' | 'cuda'

/** One installable build of a model family. */
export interface ModelVariant {
  /** Stable variant id used in install requests and on disk. */
  readonly id: string
  /** Display name shown by the variant selector. */
  readonly displayName: string
  /** Compute target; `cuda` probes verify the execution provider before claiming readiness. */
  readonly device: ModelDevice
  /** Download size of all files together, in bytes. */
  readonly sizeBytes: number
  /** Whether this variant is the family's installed and verified one. */
  readonly installed: boolean
}

/** Progress of the active download or provisioning step. */
export interface ModelProgress {
  /** Family-local phase the progress figure belongs to. */
  readonly phase: 'download' | 'provision'
  /** Bytes or steps completed so far. */
  readonly done: number
  /** Total bytes or steps, when known. */
  readonly total?: number
  /** Human-oriented label of the current item (file name or provisioning step). */
  readonly label: string
}

/** One model family as the catalog and status routes report it. */
export interface ModelFamilyView {
  /** Stable family id (`rapidocr`, `paddleocr`, `hy-mt-1.5`, `bge`). */
  readonly id: string
  /** Display name. */
  readonly displayName: string
  /** Capability class rendered as the card chip. */
  readonly kind: ModelKind
  /** Variant installed or selected for install. */
  readonly selectedVariantId: string
  /** Installable variants, catalog order. */
  readonly variants: readonly ModelVariant[]
  /** Current lifecycle state. */
  readonly status: ModelStatus
  /** Actionable failure text when `status` is `error`. */
  readonly error?: string
  /** Progress while `downloading` or `provisioning`. */
  readonly progress?: ModelProgress
  /** Probe outcome reported by the most recent probe run, if any. */
  readonly probe?: ProbeOutcome
}

/** Result of one smoke-inference probe run. */
export interface ProbeOutcome {
  /** Whether the smoke inference produced a result. */
  readonly ok: boolean
  /** Observed result summary on success (dimensions, recognized text, translation). */
  readonly detail?: string
  /** Actionable failure text on failure. */
  readonly error?: string
}

/** `GET /api/local-models/catalog` body. */
export interface CatalogView {
  /** Absolute models root directory. */
  readonly modelsRoot: string
  /** One entry per model family, catalog order. */
  readonly families: readonly ModelFamilyView[]
}

/** `GET /api/local-models/status` body: the pollable subset of the catalog. */
export interface StatusView {
  /** Per-family lifecycle state, keyed by family id. */
  readonly families: Record<string, Pick<ModelFamilyView, 'status' | 'error' | 'progress'> | undefined>
}

/** `POST /api/local-models/install` body. */
export interface InstallRequest {
  readonly modelId: string
  readonly variantId: string
}

/** `POST /api/local-models/cancel` body. */
export interface TargetRequest {
  readonly modelId: string
}
