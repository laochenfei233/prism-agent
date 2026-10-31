/**
 * BGE embedding engine over a provisioned `@huggingface/transformers`
 * runtime. The module is loaded from the runtime directory at open time; the
 * local structural interfaces stand in for its types.
 *
 * @module @prism/prism-local-models/engines/bge
 */

import { LocalModelsError } from '../errors.ts'
import { requireFrom, runtimeDir } from '../runtimes.ts'
import type { ModelDevice } from '../types.ts'

/** The slice of the transformers.js API this engine drives. */
interface Extractor {
  (texts: readonly string[], options?: { readonly pooling?: string; readonly normalize?: boolean }): Promise<{ dims: readonly number[]; data: Float32Array }>
  dispose?(): Promise<void>
}

/** The slice of the transformers.js module this engine requires. */
interface TransformersModule {
  pipeline(task: 'feature-extraction', model: string, options?: {
    readonly local_files_only?: boolean
    readonly dtype?: 'fp32' | 'quantized'
    readonly device?: ModelDevice
  }): Promise<Extractor>
}

/** Embedding engine for one installed BGE variant directory. */
export class BgeEngine {
  private constructor(private readonly extractor: Extractor) {}

  /**
   * Open the engine over an installed variant directory.
   * @param modelsRoot - the models root holding `runtimes/bge` and the variant trees.
   * @param variantDir - directory holding `config.json`, tokenizer files, and the ONNX model.
   * @param options - `quantized` selects `model_quantized.onnx`; `device` selects the execution provider.
   * @throws {LocalModelsError} `runtime-unavailable` when the provisioned runtime is missing or the requested provider cannot initialize.
   */
  static async open(modelsRoot: string, variantDir: string, options: { readonly quantized: boolean; readonly device: ModelDevice }): Promise<BgeEngine> {
    let module: TransformersModule
    try {
      module = requireFrom(runtimeDir(modelsRoot, 'bge'))('@huggingface/transformers') as TransformersModule
    } catch (error) {
      throw new LocalModelsError('runtime-unavailable', `the BGE runtime is not provisioned (install the model from the card first): ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const extractor = await module.pipeline('feature-extraction', variantDir, {
        local_files_only: true,
        dtype: options.quantized ? 'quantized' : 'fp32',
        device: options.device,
      })
      return new BgeEngine(extractor)
    } catch (error) {
      throw new LocalModelsError('runtime-unavailable', `the ${options.device} execution provider failed to initialize for BGE: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Embed texts with mean pooling and L2 normalization.
   * @returns one vector per input text.
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const output = await this.extractor(texts, { pooling: 'mean', normalize: true })
    const dimensions = output.dims[output.dims.length - 1]
    if (output.dims.length !== 2 || dimensions === undefined) {
      throw new LocalModelsError('runtime-unavailable', `unexpected embedding tensor shape [${output.dims.join(', ')}]`)
    }
    const vectors: number[][] = []
    for (let index = 0; index < output.dims[0]; index += 1) {
      vectors.push([...output.data.slice(index * dimensions, (index + 1) * dimensions)])
    }
    return vectors
  }

  /** Release the underlying session, when the runtime exposes a disposer. */
  async dispose(): Promise<void> {
    await this.extractor.dispose?.().catch(() => {})
  }
}
