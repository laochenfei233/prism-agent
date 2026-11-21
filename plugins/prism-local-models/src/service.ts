/**
 * Local-models host service: catalog reads, the install lifecycle, and the
 * capability entry points (`embed`, `ocr`, `translate`) future Prism features
 * consume. Claimed on the host context as `prismLocalModels`.
 *
 * One active operation per family; different families run concurrently. The
 * first awaited method lazily resolves the catalog (override merge, mirror
 * rewrite) and rescans the models root, so manual placement shows up without
 * a restart. `install` starts the operation and returns at once; the card
 * follows progress through `status`.
 *
 * @module @prism/prism-local-models
 */

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyCatalogOverride, BUILTIN_CATALOG, resolveCatalogUrls, type Catalog, type CatalogFamily, type CatalogVariant } from './catalog.ts'
import { downloadFile } from './download.ts'
import { LocalModelsError } from './errors.ts'
import { BgeEngine } from './engines/bge.ts'
import { HyMtEngine } from './engines/hymt.ts'
import { PaddleOcrSidecar } from './engines/paddleocr.ts'
import { RapidOcrEngine } from './engines/rapidocr.ts'
import { ModelRegistry, type FamilyRecord, type FileRecord, type RegistryDocument } from './registry.ts'
import { provisionRuntime } from './runtimes.ts'
import type { ResolvedConfig } from './config.ts'
import type { CatalogView, ModelFamilyView, ModelProgress, ModelStatus, ModelVariant, ProbeOutcome, StatusView } from './types.ts'

/** Anything an open engine must expose for teardown. */
interface EngineLike {
  dispose(): void
}

/** One running install with its cancellation and live progress. */
interface ActiveInstall {
  /** Cancels the download in flight. */
  readonly abort: () => void
  /** Live progress; mutated by the running download. */
  progress: ModelProgress
}

/** Whether one variant-directory name is safe to delete inside a family tree. */
function isSafeVariantId(variantId: string): boolean {
  return variantId.length > 0 && variantId !== '.' && variantId !== '..'
    && variantId.includes('/') === false && variantId.includes('\\') === false
}

/**
 * Owns model state under the models root and drives installs and inference.
 */
export class PrismLocalModelsService {
  /** Absolute directory every model installs into. */
  readonly modelsRoot: string

  private readonly config: ResolvedConfig
  private readonly registry: ModelRegistry
  private readonly init: Promise<void>
  private readonly active = new Map<string, ActiveInstall>()
  private readonly engines = new Map<string, { readonly variantId: string; readonly engine: EngineLike }>()
  private catalogImpl: Catalog = []
  private document: RegistryDocument = { version: 1, families: {} }

  /**
   * @param config - validated plugin configuration.
   * @param home - harness home directory, the default parent of the models root.
   */
  constructor(config: ResolvedConfig, home: string) {
    this.config = config
    this.modelsRoot = config.modelsRoot ?? join(home, 'models')
    this.registry = new ModelRegistry(this.modelsRoot)
    this.init = this.initialize()
  }

  /** Read the full catalog: families, variants, lifecycle state, probe results. */
  async catalog(): Promise<CatalogView> {
    await this.init
    await this.rescan()
    return { modelsRoot: this.modelsRoot, families: this.families() }
  }

  /** Read the pollable per-family lifecycle snapshot. */
  async status(): Promise<StatusView> {
    await this.init
    const families: StatusView['families'] = {}
    for (const family of this.families()) {
      families[family.id] = { status: family.status, ...(family.error !== undefined ? { error: family.error } : {}), ...(family.progress !== undefined ? { progress: family.progress } : {}) }
    }
    return { families }
  }

  /**
   * Start installing one variant: download the files, verify integrity, and
   * record the result. Returns immediately; the card polls `status`.
   * Installing the already-ready variant is a no-op.
   * @param modelId - target family id.
   * @param variantId - variant to install.
   */
  async install(modelId: string, variantId: string): Promise<void> {
    await this.init
    const variant = this.requireVariant(modelId, variantId)
    const record = this.document.families[modelId]
    if (this.active.has(modelId)) {
      throw new LocalModelsError('busy', `"${modelId}" already has an operation running`)
    }
    if (record?.status === 'ready' && record.variantId === variant.id) return
    const abort = new AbortController()
    const firstFile = variant.files[0]
    const activeInstall: ActiveInstall = {
      abort: () => abort.abort(),
      progress: { phase: 'download', done: 0, total: firstFile?.sizeBytes ?? 0, label: firstFile?.path ?? variant.id },
    }
    this.active.set(modelId, activeInstall)
    void this.runInstall(modelId, variant, abort.signal, activeInstall)
  }

  /**
   * Stop the active download of one family and clean its temp files. A known
   * family without an active operation cancels nothing successfully.
   * @param modelId - target family id.
   */
  async cancel(modelId: string): Promise<void> {
    await this.init
    this.requireFamily(modelId)
    this.active.get(modelId)?.abort()
  }

  /**
   * Delete the installed variant directory and reset the family to idle.
   * @param modelId - target family id.
   */
  async remove(modelId: string): Promise<void> {
    await this.init
    this.requireFamily(modelId)
    if (this.active.has(modelId)) {
      throw new LocalModelsError('busy', `"${modelId}" has an operation running; cancel it first`)
    }
    const record = this.document.families[modelId]
    if (record?.variantId !== undefined && isSafeVariantId(record.variantId)) {
      await rm(join(this.modelsRoot, modelId, record.variantId), { recursive: true, force: true })
    }
    const staleEngine = this.engines.get(modelId)
    if (staleEngine !== undefined) {
      this.engines.delete(modelId)
      void staleEngine.engine.dispose()
    }
    await this.writeFamilyRecord(modelId, { status: 'idle' })
  }

  /** Run one smoke inference against the installed variant and persist the outcome. */
  async probe(modelId: string): Promise<ProbeOutcome> {
    await this.init
    this.requireFamily(modelId)
    const outcome = await this.runProbe(modelId)
    const record = this.document.families[modelId]
    if (record !== undefined) await this.writeFamilyRecord(modelId, { ...record, probe: outcome })
    return outcome
  }

  /** Dispatch one smoke inference to the family's engine. */
  private async runProbe(modelId: string): Promise<ProbeOutcome> {
    if (modelId === 'bge') return this.probeEmbedding()
    if (modelId === 'rapidocr') {
      const engine = await this.rapidOcrEngine()
      const text = await engine.probe()
      return text.trim().length > 0
        ? { ok: true, detail: text.slice(0, 120) }
        : { ok: false, error: 'the probe image produced no text' }
    }
    if (modelId === 'paddleocr') {
      const sidecar = await this.paddleOcrSidecar()
      const text = await sidecar.probe()
      return text.trim().length > 0
        ? { ok: true, detail: text.slice(0, 120) }
        : { ok: false, error: 'the probe image produced no text' }
    }
    if (modelId === 'hy-mt-1.5') {
      const translation = await this.translate('今天天气很好，适合出门散步。', { to: 'en' })
      return translation.length > 0
        ? { ok: true, detail: translation.slice(0, 120) }
        : { ok: false, error: 'the probe translation came back empty' }
    }
    throw new LocalModelsError('not-implemented', `probe ${modelId} arrives with its inference task`)
  }

  /** Capability entry point for RAG and memory consumers. */
  async embed(texts: readonly string[]): Promise<number[][]> {
    await this.init
    const engine = await this.engineFor('bge')
    return engine.embed(texts)
  }

  /**
   * Extract text from one image through the ready OCR engine: RapidOCR by
   * default, the PaddleOCR sidecar when RapidOCR is not installed.
   */
  async ocr(image: { readonly bytes: Uint8Array; readonly mime: string }): Promise<string> {
    await this.init
    const record = this.document.families['rapidocr']
    if (record?.status === 'ready') return (await this.rapidOcrEngine()).detectText(image)
    const paddle = this.document.families['paddleocr']
    if (paddle?.status === 'ready') return this.paddleOcr(image)
    throw new LocalModelsError('not-installed', 'no OCR engine is ready; install RapidOCR (default) or PaddleOCR from the Models page card')
  }

  /** Capability entry point for translation through HY-MT1.5. */
  async translate(text: string, opts: { readonly to: string; readonly from?: string }): Promise<string> {
    await this.init
    const record = this.document.families['hy-mt-1.5']
    if (record?.status !== 'ready' || record.variantId === undefined) {
      throw new LocalModelsError('not-installed', 'install the HY-MT1.5 model from the Models page card first')
    }
    const cached = this.engines.get('hy-mt-1.5')
    let engine: HyMtEngine
    if (cached?.variantId === record.variantId && cached.engine instanceof HyMtEngine) {
      engine = cached.engine
    } else {
      const stale = this.engines.get('hy-mt-1.5')
      if (stale !== undefined) {
        this.engines.delete('hy-mt-1.5')
        stale.engine.dispose()
      }
      const variant = this.requireVariant('hy-mt-1.5', record.variantId)
      engine = await HyMtEngine.open(this.modelsRoot, record.variantId, { device: variant.device })
      this.engines.set('hy-mt-1.5', { variantId: record.variantId, engine })
    }
    return engine.translate(text, { to: opts.to })
  }

  /** Cancel every in-flight download and release engines; sidecars arrive with their tasks. */
  dispose(): void {
    for (const install of this.active.values()) install.abort()
    for (const entry of this.engines.values()) void entry.engine.dispose()
    this.engines.clear()
  }

  /** The BGE engine over the installed variant, opening and caching on demand. */
  private async engineFor(modelId: 'bge'): Promise<BgeEngine> {
    const record = this.document.families[modelId]
    if (record?.status !== 'ready' || record.variantId === undefined) {
      throw new LocalModelsError('not-installed', 'install the BGE model from the Models page card first')
    }
    const cached = this.engines.get(modelId)
    if (cached?.variantId === record.variantId && cached.engine instanceof BgeEngine) return cached.engine
    const stale = this.engines.get(modelId)
    if (stale !== undefined) {
      this.engines.delete(modelId)
      stale.engine.dispose()
    }
    const variant = this.requireVariant(modelId, record.variantId)
    const quantized = variant.files.some(file => file.path.includes('quantized'))
    const engine = await BgeEngine.open(this.modelsRoot, ModelRegistry.variantDir(this.modelsRoot, modelId, record.variantId), { quantized, device: variant.device })
    this.engines.set(modelId, { variantId: record.variantId, engine })
    return engine
  }

  /** Probe the BGE family with a fixed string and report the vector width. */
  private async probeEmbedding(): Promise<ProbeOutcome> {
    const vectors = await this.embed(['本地模型探针 local models probe'])
    return { ok: true, detail: `${vectors[0]?.length ?? 0} dims` }
  }

  /** The RapidOCR engine over the installed family, opening and caching on demand. */
  private async rapidOcrEngine(): Promise<RapidOcrEngine> {
    const record = this.document.families['rapidocr']
    if (record?.status !== 'ready' || record.variantId === undefined) {
      throw new LocalModelsError('not-installed', 'install the RapidOCR model from the Models page card first')
    }
    const cached = this.engines.get('rapidocr')
    if (cached?.variantId === record.variantId && cached.engine instanceof RapidOcrEngine) return cached.engine
    const engine = await RapidOcrEngine.open(this.modelsRoot)
    this.engines.set('rapidocr', { variantId: record.variantId, engine })
    return engine
  }

  /** The PaddleOCR sidecar over the provisioned venv, starting and caching on demand. */
  private async paddleOcrSidecar(): Promise<PaddleOcrSidecar> {
    const record = this.document.families['paddleocr']
    if (record?.status !== 'ready' || record.variantId === undefined) {
      throw new LocalModelsError('not-installed', 'install a PaddleOCR variant from the Models page card first (this provisions a Python venv)')
    }
    const cached = this.engines.get('paddleocr')
    if (cached?.variantId === record.variantId && cached.engine instanceof PaddleOcrSidecar) return cached.engine
    const stale = this.engines.get('paddleocr')
    if (stale !== undefined) {
      this.engines.delete('paddleocr')
      stale.engine.dispose()
    }
    const sidecar = await PaddleOcrSidecar.open(this.modelsRoot)
    this.engines.set('paddleocr', { variantId: record.variantId, engine: sidecar })
    return sidecar
  }

  /** The PaddleOCR sidecar call, after RapidOCR. */
  private async paddleOcr(image: { readonly bytes: Uint8Array; readonly mime: string }): Promise<string> {
    return (await this.paddleOcrSidecar()).detectText(image)
  }

  /** Resolve the catalog and take the first scan of the models root. */
  private async initialize(): Promise<void> {
    let catalog = BUILTIN_CATALOG
    if (this.config.catalogOverride !== undefined) {
      catalog = applyCatalogOverride(await readFile(this.config.catalogOverride, 'utf8'))
    }
    this.catalogImpl = resolveCatalogUrls(catalog, this.config.mirrorBaseUrl)
    this.document = await this.registry.load()
    await this.rescan()
  }

  /** The running install: downloads, verifies, provisions, and records. */
  private async runInstall(modelId: string, variant: CatalogVariant, signal: AbortSignal, activeInstall: ActiveInstall): Promise<void> {
    const dir = ModelRegistry.variantDir(this.modelsRoot, modelId, variant.id)
    const files: Record<string, FileRecord> = {}
    const staleEngine = this.engines.get(modelId)
    if (staleEngine !== undefined) {
      this.engines.delete(modelId)
      void staleEngine.engine.dispose()
    }
    try {
      await mkdir(dir, { recursive: true })
      for (const file of variant.files) {
        activeInstall.progress = { phase: 'download', done: 0, total: file.sizeBytes, label: file.path }
        const destPath = join(dir, file.path)
        await mkdir(dirname(destPath), { recursive: true })
        await downloadFile({
          url: file.url,
          destPath,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          signal,
          onProgress: done => {
            activeInstall.progress = { phase: 'download', done, total: file.sizeBytes, label: file.path }
          },
        })
        const stats = await stat(destPath)
        files[file.path] = { sizeBytes: file.sizeBytes, mtimeMs: stats.mtimeMs, verified: true }
      }
      if (variant.runtime !== undefined) {
        activeInstall.progress = { phase: 'provision', done: 0, total: 1, label: `${variant.runtime.kind} provisioning` }
        await provisionRuntime(this.modelsRoot, modelId, variant.runtime, this.config.pythonCommand, signal)
        activeInstall.progress = { phase: 'provision', done: 1, total: 1, label: `${variant.runtime.kind} provisioned` }
      }
      if (signal.aborted) throw new LocalModelsError('download-failed', 'cancelled')
      await this.writeFamilyRecord(modelId, { variantId: variant.id, status: 'ready', error: undefined, files })
      await this.removePreviousVariant(modelId, variant.id)
    } catch (error) {
      if (signal.aborted) {
        await this.writeFamilyRecord(modelId, { variantId: variant.id, status: 'idle', error: undefined, probe: this.document.families[modelId]?.probe })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof LocalModelsError ? error.code : 'download-failed'
        await this.writeFamilyRecord(modelId, {
          variantId: variant.id,
          status: 'error',
          error: code === 'integrity-failed' || code === 'download-failed' ? message : `install failed: ${message}`,
        })
      }
    } finally {
      this.active.delete(modelId)
    }
  }

  /** Re-verify every recorded variant tree and detect manual placements. */
  private async rescan(): Promise<void> {
    for (const family of this.catalogImpl) {
      const record = this.document.families[family.id]
      if (record?.variantId === undefined) await this.detectManualPlacement(family)
      else await this.rescanFamily(family.id)
    }
  }

  /** Detect a fully present variant tree for a family with no record yet. */
  private async detectManualPlacement(family: CatalogFamily): Promise<void> {
    for (const variant of family.variants) {
      if (variant.files.length === 0) continue
      const outcome = await this.verifyVariantTree(family.id, variant, { variantId: variant.id, status: 'idle' })
      if (outcome?.status === 'ready') {
        await this.writeFamilyRecord(family.id, { ...outcome, variantId: variant.id })
        return
      }
    }
  }

  /** Re-verify one family's recorded variant tree against the catalog pins. */
  private async rescanFamily(modelId: string): Promise<void> {
    const family = this.catalogImpl.find(candidate => candidate.id === modelId)
    if (family === undefined) return
    const record = this.document.families[modelId]
    if (record?.variantId === undefined) return
    const variant = family.variants.find(candidate => candidate.id === record.variantId)
    if (variant === undefined) return
    const outcome = await this.verifyVariantTree(modelId, variant, record)
    if (outcome !== undefined) await this.writeFamilyRecord(modelId, outcome)
  }

  /** Delete variant directories left behind by earlier installs of this family. */
  private async removePreviousVariant(modelId: string, installedVariantId: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(join(this.modelsRoot, modelId))
    } catch {
      // No family directory yet: nothing previous to clean up.
      return
    }
    for (const entry of entries) {
      if (entry !== installedVariantId && isSafeVariantId(entry)) {
        await rm(join(this.modelsRoot, modelId, entry), { recursive: true, force: true })
      }
    }
  }

  /**
   * Verify one variant's files against the catalog pins, reusing cached
   * verifications while size and mtime are unchanged.
   * @returns the record to persist, or undefined when the record is still accurate.
   */
  private async verifyVariantTree(modelId: string, variant: CatalogVariant, record: FamilyRecord): Promise<FamilyRecord | undefined> {
    if (variant.files.length === 0) return undefined
    const files: Record<string, FileRecord> = { ...(record.files ?? {}) }
    let missing = 0
    for (const file of variant.files) {
      const absolutePath = join(ModelRegistry.variantDir(this.modelsRoot, modelId, variant.id), file.path)
      const cached = files[file.path]
      let stats
      try {
        stats = await stat(absolutePath)
      } catch {
        missing += 1
        delete files[file.path]
        continue
      }
      if (cached?.verified === true && stats.size === file.sizeBytes && stats.mtimeMs === cached.mtimeMs) continue
      const result = await ModelRegistry.verifyFile(absolutePath, file.sizeBytes, file.sha256)
      if (result === 'match') {
        files[file.path] = { sizeBytes: file.sizeBytes, mtimeMs: stats.mtimeMs, verified: true }
      } else if (result === 'hash-mismatch') {
        return {
          variantId: variant.id,
          status: 'error',
          error: `${file.path} does not match its catalog checksum; delete the variant directory and install again`,
        }
      } else {
        missing += 1
        delete files[file.path]
      }
    }
    if (missing === 0) {
      return { ...record, variantId: variant.id, status: 'ready', error: undefined, files }
    }
    if (missing === variant.files.length) {
      return { variantId: variant.id, status: 'idle', error: undefined, files: undefined, probe: record.probe }
    }
    return { variantId: variant.id, status: 'idle', error: undefined, files: Object.keys(files).length > 0 ? files : undefined, probe: record.probe }
  }

  /** Persist one family record and keep the in-memory document current. */
  private async writeFamilyRecord(modelId: string, record: FamilyRecord): Promise<void> {
    this.document = {
      version: 1,
      families: { ...this.document.families, [modelId]: record },
    }
    await this.registry.save(this.document)
  }

  /** The catalog families projected onto the wire view. */
  private families(): ModelFamilyView[] {
    return this.catalogImpl.map(family => {
      const record = this.document.families[family.id]
      const active = this.active.get(family.id)
      const selectedVariantId = record?.variantId ?? family.defaultVariantId
      const status: ModelStatus = active === undefined
        ? record?.status ?? 'idle'
        : active.progress.phase === 'provision' ? 'provisioning' : 'downloading'
      return {
        id: family.id,
        displayName: family.displayName,
        kind: family.kind,
        selectedVariantId,
        variants: family.variants.map(variant => this.variantView(variant, record)),
        status,
        ...(record?.error !== undefined && active === undefined ? { error: record.error } : {}),
        ...(active !== undefined ? { progress: active.progress } : {}),
        ...(record?.probe !== undefined ? { probe: record.probe } : {}),
      }
    })
  }

  /** One catalog variant projected onto the wire view. */
  private variantView(variant: CatalogVariant, record: FamilyRecord | undefined): ModelVariant {
    return {
      id: variant.id,
      displayName: variant.displayName,
      device: variant.device,
      sizeBytes: variant.files.reduce((total, file) => total + file.sizeBytes, 0),
      installed: record?.variantId === variant.id && record.status === 'ready',
    }
  }

  /** Look up one catalog family or fail with a typed error. */
  private requireFamily(modelId: string): CatalogFamily {
    const family = this.catalogImpl.find(candidate => candidate.id === modelId)
    if (family === undefined) throw new LocalModelsError('unknown-model', `unknown model family "${modelId}"`)
    return family
  }

  /** Look up one catalog variant or fail with a typed error. */
  private requireVariant(modelId: string, variantId: string): CatalogVariant {
    const family = this.requireFamily(modelId)
    const variant = family.variants.find(candidate => candidate.id === variantId)
    if (variant === undefined) {
      throw new LocalModelsError('unknown-variant', `unknown variant "${variantId}" for model family "${modelId}"`)
    }
    return variant
  }
}
