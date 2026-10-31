/**
 * HY-MT1.5 translation engine over a provisioned `node-llama-cpp` runtime.
 * The GGUF carries Hunyuan-MT's chat template; prompts follow the official
 * Hunyuan-MT instruction format. Loaded through the provisioned runtime —
 * CJS require first, dynamic ESM import as the fallback.
 *
 * @module @prism/prism-local-models/engines/hymt
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalModelsError } from '../errors.ts'
import { requireFrom, runtimeDir } from '../runtimes.ts'
import type { ModelDevice } from '../types.ts'

/** One loaded llama.cpp context's sequence handle. */
interface ContextSequence {
  getSequence(): unknown
}

/** The slice of node-llama-cpp this engine drives. */
interface LlamaModule {
  getLlama(options?: { readonly gpu?: false | 'auto' | 'cuda' }): Promise<{
    loadModel(options: { readonly modelPath: string; readonly gpuLayers?: number }): Promise<{
      createContext(): Promise<ContextSequence>
      dispose?(): void
    }>
  }>
  LlamaChatSession: new (options: { readonly contextSequence: unknown }) => {
    prompt(prompt: string): Promise<string>
  }
}

/** Language-name mapping for the Hunyuan-MT instruction template. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
}

/** Translation engine for the HY-MT1.5 family. */
export class HyMtEngine {
  private constructor(private readonly session: InstanceType<LlamaModule['LlamaChatSession']>, private readonly model: { dispose?(): void }) {}

  /**
   * Open the engine over an installed variant directory.
   * @param modelsRoot - the models root holding the provisioned runtime and the variant tree.
   * @param variantId - installed variant id; its directory holds the GGUF.
   * @param options - `cuda` requests the CUDA llama.cpp build; failures surface typed.
   */
  static async open(modelsRoot: string, variantId: string, options: { readonly device: ModelDevice }): Promise<HyMtEngine> {
    const runtimePath = runtimeDir(modelsRoot, 'hy-mt-1.5')
    const module = await loadModule(runtimePath)
    try {
      const llama = await module.getLlama(options.device === 'cuda' ? { gpu: 'cuda' } : { gpu: false })
      const modelPath = await ggufPath(modelsRoot, variantId)
      const model = await llama.loadModel({ modelPath, gpuLayers: options.device === 'cuda' ? undefined : 0 })
      const context = await model.createContext()
      const session = new module.LlamaChatSession({ contextSequence: context.getSequence() })
      return new HyMtEngine(session, model)
    } catch (error) {
      if (error instanceof LocalModelsError) throw error
      throw new LocalModelsError('runtime-unavailable', `the ${options.device} llama.cpp runtime failed for HY-MT1.5: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Translate one text with the Hunyuan-MT instruction template.
   * @param text - source text.
   * @param opts - `to` is an ISO-ish code or a language name; `from` is unused (the model auto-detects).
   */
  async translate(text: string, opts: { readonly to: string }): Promise<string> {
    const target = LANGUAGE_NAMES[opts.to.toLowerCase()] ?? opts.to
    const prompt = `把下面的文本翻译成${target}，不要额外解释。${text}`
    return (await this.session.prompt(prompt)).trim()
  }

  /** Release the model session; the process-wide llama instance tears down with it. */
  dispose(): void {
    this.model.dispose?.()
  }
}

/** Load node-llama-cpp from the provisioned runtime; CJS require first. */
async function loadModule(runtimePath: string): Promise<LlamaModule> {
  try {
    return requireFrom(runtimePath)('node-llama-cpp') as LlamaModule
  } catch {
    // Fall through to the ESM entry.
  }
  try {
    return await import(pathToFileURL(join(runtimePath, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')).href) as LlamaModule
  } catch (error) {
    throw new LocalModelsError('runtime-unavailable', `the HY-MT1.5 runtime is not provisioned (install the model from the card first): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The single GGUF inside one installed variant directory. */
async function ggufPath(modelsRoot: string, variantId: string): Promise<string> {
  const dir = join(modelsRoot, 'hy-mt-1.5', variantId)
  const files = await readdir(dir)
  const gguf = files.find(file => file.toLowerCase().endsWith('.gguf'))
  if (gguf === undefined) {
    throw new LocalModelsError('not-installed', `no GGUF found under ${dir}; install the HY-MT1.5 model from the Models page card first`)
  }
  return join(dir, gguf)
}
