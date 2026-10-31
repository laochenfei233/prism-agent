/**
 * Local-models host service: catalog reads, install lifecycle, and the
 * capability entry points (`embed`, `ocr`, `translate`) future Prism features
 * consume. Claimed on the host context as `prismLocalModels`.
 *
 * @module @prism/prism-local-models
 */

import { join } from 'node:path'
import { LocalModelsError } from './errors.ts'
import type { ResolvedConfig } from './config.ts'
import type { CatalogView, ModelFamilyView, ProbeOutcome, StatusView } from './types.ts'

/**
 * Owns model state under the models root and drives installs and inference.
 * One active operation per family; different families run concurrently.
 */
export class PrismLocalModelsService {
  /** Absolute directory every model installs into. */
  readonly modelsRoot: string

  /**
   * @param config - validated plugin configuration.
   * @param home - harness home directory, the default parent of the models root.
   */
  constructor(config: ResolvedConfig, home: string) {
    this.modelsRoot = config.modelsRoot ?? join(home, 'models')
  }

  /** Read the full catalog: families, variants, lifecycle state, probe results. */
  async catalog(): Promise<CatalogView> {
    return { modelsRoot: this.modelsRoot, families: this.families() }
  }

  /** Read the pollable per-family lifecycle snapshot. */
  async status(): Promise<StatusView> {
    const families: StatusView['families'] = {}
    for (const family of this.families()) {
      families[family.id] = { status: family.status, ...(family.error !== undefined ? { error: family.error } : {}), ...(family.progress !== undefined ? { progress: family.progress } : {}) }
    }
    return { families }
  }

  /**
   * Install one variant: download the files, verify integrity, provision the
   * runtime, and rescan.
   * @param modelId - target family id.
   * @param variantId - variant to install.
   */
  async install(modelId: string, variantId: string): Promise<void> {
    throw new LocalModelsError('not-implemented', `install ${modelId}/${variantId} arrives with the catalog task`)
  }

  /** Stop the active download or provisioning of one family and clean its temp files. */
  async cancel(modelId: string): Promise<void> {
    throw new LocalModelsError('not-implemented', `cancel ${modelId} arrives with the download task`)
  }

  /** Delete the installed variant directory and reset the family to idle. */
  async remove(modelId: string): Promise<void> {
    throw new LocalModelsError('not-implemented', `remove ${modelId} arrives with the download task`)
  }

  /** Run one smoke inference against the installed variant. */
  async probe(modelId: string): Promise<ProbeOutcome> {
    throw new LocalModelsError('not-implemented', `probe ${modelId} arrives with the inference tasks`)
  }

  /** Capability entry point for RAG and memory consumers. */
  async embed(_texts: readonly string[]): Promise<number[][]> {
    throw new LocalModelsError('not-implemented', 'embedding arrives with the BGE task')
  }

  /** Capability entry point for image text extraction. */
  async ocr(_image: { readonly bytes: Uint8Array; readonly mime: string }): Promise<string> {
    throw new LocalModelsError('not-implemented', 'OCR arrives with the engine tasks')
  }

  /** Capability entry point for translation through HY-MT1.5. */
  async translate(_text: string, _opts: { readonly to: string; readonly from?: string }): Promise<string> {
    throw new LocalModelsError('not-implemented', 'translation arrives with the HY-MT task')
  }

  /** Release engines, the sidecar process, and any in-flight download. */
  dispose(): void {}

  /** Catalog families; the catalog task replaces the empty stub. */
  private families(): ModelFamilyView[] {
    return []
  }
}
