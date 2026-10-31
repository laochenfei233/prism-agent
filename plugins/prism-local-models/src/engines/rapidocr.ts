/**
 * RapidOCR engine over the provisioned `@gutenye/ocr-node` runtime. The
 * package is ESM-only and loads by dynamic import of its entry file; its
 * bundled PP-OCRv4 models and sharp preprocessor come with the provisioning.
 *
 * @module @prism/prism-local-models/engines/rapidocr
 */

import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalModelsError } from '../errors.ts'
import { requireFrom, runtimeDir } from '../runtimes.ts'

/** The slice of the @gutenye/ocr-node API this engine drives. */
interface OcrInstance {
  detect(input: string): Promise<{ readonly texts: readonly { readonly text: string }[] }>
}

/** The module shape of `@gutenye/ocr-node`. */
interface OcrModule {
  readonly default: {
    create(options?: { readonly models?: Record<string, string> }): Promise<OcrInstance>
  }
}

/** Text extraction engine for the RapidOCR family. */
export class RapidOcrEngine {
  private constructor(private readonly ocr: OcrInstance, private readonly runtimePath: string) {}

  /**
   * Open the engine from a provisioned runtime directory.
   * @param modelsRoot - the models root holding `runtimes/rapidocr`.
   * @throws {LocalModelsError} `runtime-unavailable` when the runtime is missing or fails to initialize.
   */
  static async open(modelsRoot: string): Promise<RapidOcrEngine> {
    const runtimePath = runtimeDir(modelsRoot, 'rapidocr')
    const entry = join(runtimePath, 'node_modules', '@gutenye', 'ocr-node', 'build', 'index.js')
    let module: OcrModule
    try {
      module = (await import(pathToFileURL(entry).href)) as OcrModule
    } catch (error) {
      throw new LocalModelsError('runtime-unavailable', `the RapidOCR runtime is not provisioned (install the model from the card first): ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const ocr = await module.default.create()
      return new RapidOcrEngine(ocr, runtimePath)
    } catch (error) {
      throw new LocalModelsError('runtime-unavailable', `the RapidOCR runtime failed to initialize: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Extract text from one image.
   * @param image - raw image bytes with their MIME type.
   * @returns the detected lines joined with newlines.
   */
  async detectText(image: { readonly bytes: Uint8Array; readonly mime: string }): Promise<string> {
    const extension = image.mime.includes('png') ? 'png' : image.mime.includes('jpeg') ? 'jpg' : 'png'
    const temp = join(tmpdir(), `prism-local-models-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`)
    try {
      await writeFile(temp, image.bytes)
      const result = await this.ocr.detect(temp)
      return result.texts.map(detection => detection.text).join('\n')
    } catch (error) {
      throw new LocalModelsError('runtime-unavailable', `RapidOCR detection failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Temp cleanup is best-effort; the detection failure itself is reported.
      await rm(temp, { force: true }).catch((cleanupError: unknown) => {
        void cleanupError
      })
    }
  }

  /**
   * Render one probe image (sharp comes with the provisioning) and OCR it.
   * @returns the recognized text.
   */
  async probe(): Promise<string> {
    const sharp = requireFrom(this.runtimePath)('sharp') as { (input: Buffer): { png(): { toBuffer(): Promise<Buffer> } } }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="480" height="120" fill="white"/><text x="24" y="72" font-family="Arial" font-size="48" fill="black">PRISM LOCAL OCR</text></svg>'
    const bytes = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer()
    return this.detectText({ bytes, mime: 'image/png' })
  }

  /** The engine holds no exclusive resources; nothing to release. */
  dispose(): void {}
}
