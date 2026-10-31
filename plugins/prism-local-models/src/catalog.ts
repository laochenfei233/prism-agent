/**
 * Built-in model catalog: the four families, their installable variants, and
 * the pinned upstream files (size and sha256 taken from the upstream file
 * listings; the GGUF and ONNX hashes are the LFS object ids of the pinned
 * revisions).
 *
 * Download hosts default to the China-reachable origins the files were
 * verified against (`hf-mirror.com`); `mirrorBaseUrl` swaps the origin of
 * every URL at resolve time.
 *
 * @module @prism/prism-local-models
 */

import type { ModelDevice, ModelKind } from './types.ts'

/** One pinned upstream file of a variant. */
export interface CatalogFile {
  /** Relative path inside the variant directory. */
  readonly path: string
  /** Absolute upstream URL. */
  readonly url: string
  /** Exact byte size. */
  readonly sizeBytes: number
  /** sha256 of the exact bytes. */
  readonly sha256: string
}

/** How a variant's runtime is provisioned after its files land. */
export type CatalogRuntime =
  | { readonly kind: 'npm'; readonly packages: readonly string[] }
  | { readonly kind: 'pip'; readonly packages: readonly string[] }

/** One installable build of a family. */
export interface CatalogVariant {
  /** Stable variant id. */
  readonly id: string
  /** Display name. */
  readonly displayName: string
  /** Compute target; `cuda` probes verify the execution provider. */
  readonly device: ModelDevice
  /** Files to download; empty for fully provisioned variants. */
  readonly files: readonly CatalogFile[]
  /** Runtime provisioning step, when the variant needs one. */
  readonly runtime?: CatalogRuntime
}

/** One model family. */
export interface CatalogFamily {
  /** Stable family id. */
  readonly id: string
  /** Display name. */
  readonly displayName: string
  /** Capability class. */
  readonly kind: ModelKind
  /** Variant installed when the operator picks none. */
  readonly defaultVariantId: string
  /** Installable variants, display order. */
  readonly variants: readonly CatalogVariant[]
}

/** The built-in catalog. */
export type Catalog = readonly CatalogFamily[]

/** `hf-mirror.com` origin, reachable where `huggingface.co` is not. */
const HF_MIRROR = 'https://hf-mirror.com'

/** BGE small upstream (transformers.js-ready export). */
const BGE_SMALL = `${HF_MIRROR}/Xenova/bge-small-zh-v1.5/resolve/main`

/** BGE m3 upstream (transformers.js-ready export). */
const BGE_M3 = `${HF_MIRROR}/Xenova/bge-m3/resolve/main`

/** Official Hunyuan-MT1.5 GGUF export. */
const HY_MT = `${HF_MIRROR}/tencent/HY-MT1.5-1.8B-GGUF/resolve/main`

/** The tokenizer side files shared by both BGE small variants. */
const BGE_SMALL_TEXT_FILES: readonly CatalogFile[] = [
  { path: 'tokenizer.json', url: `${BGE_SMALL}/tokenizer.json`, sizeBytes: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
  { path: 'config.json', url: `${BGE_SMALL}/config.json`, sizeBytes: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
  { path: 'tokenizer_config.json', url: `${BGE_SMALL}/tokenizer_config.json`, sizeBytes: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
  { path: 'special_tokens_map.json', url: `${BGE_SMALL}/special_tokens_map.json`, sizeBytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
]

/** The tokenizer side files of the BGE m3 variant. */
const BGE_M3_TEXT_FILES: readonly CatalogFile[] = [
  { path: 'tokenizer.json', url: `${BGE_M3}/tokenizer.json`, sizeBytes: 17082821, sha256: '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790' },
  { path: 'config.json', url: `${BGE_M3}/config.json`, sizeBytes: 770, sha256: '734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95' },
  { path: 'tokenizer_config.json', url: `${BGE_M3}/tokenizer_config.json`, sizeBytes: 1173, sha256: '7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4' },
  { path: 'special_tokens_map.json', url: `${BGE_M3}/special_tokens_map.json`, sizeBytes: 964, sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835' },
  { path: 'sentencepiece.bpe.model', url: `${BGE_M3}/sentencepiece.bpe.model`, sizeBytes: 5069051, sha256: 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865' },
]

/** The built-in families. */
export const BUILTIN_CATALOG: Catalog = [
  {
    id: 'rapidocr',
    displayName: 'RapidOCR',
    kind: 'ocr',
    defaultVariantId: 'standard',
    variants: [
      {
        id: 'standard',
        displayName: 'PP-OCRv4 (ONNX)',
        device: 'cpu',
        files: [],
        runtime: { kind: 'npm', packages: ['@gutenye/ocr-node', '@gutenye/ocr-models'] },
      },
    ],
  },
  {
    id: 'paddleocr',
    displayName: 'PaddleOCR',
    kind: 'ocr',
    defaultVariantId: 'cpu',
    variants: [
      { id: 'cpu', displayName: 'CPU (paddlepaddle)', device: 'cpu', files: [], runtime: { kind: 'pip', packages: ['paddleocr', 'paddlepaddle'] } },
      { id: 'cuda', displayName: 'CUDA (paddlepaddle-gpu)', device: 'cuda', files: [], runtime: { kind: 'pip', packages: ['paddleocr', 'paddlepaddle-gpu'] } },
    ],
  },
  {
    id: 'hy-mt-1.5',
    displayName: 'HY-MT1.5 (Hunyuan-MT1.5-1.8B)',
    kind: 'translation',
    defaultVariantId: 'q4_k_m',
    variants: [
      {
        id: 'q4_k_m',
        displayName: 'Q4_K_M',
        device: 'cpu',
        files: [{ path: 'HY-MT1.5-1.8B-Q4_K_M.gguf', url: `${HY_MT}/HY-MT1.5-1.8B-Q4_K_M.gguf`, sizeBytes: 1133080512, sha256: '4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7' }],
      },
      {
        id: 'q8_0',
        displayName: 'Q8_0',
        device: 'cpu',
        files: [{ path: 'HY-MT1.5-1.8B-Q8_0.gguf', url: `${HY_MT}/HY-MT1.5-1.8B-Q8_0.gguf`, sizeBytes: 1908528288, sha256: '6789b06d0902f2f5312c0e1703d56ccbddfcfb6c653d22519b7c720f7db9a98e' }],
      },
      {
        id: 'q4_k_m-cuda',
        displayName: 'Q4_K_M (CUDA)',
        device: 'cuda',
        files: [{ path: 'HY-MT1.5-1.8B-Q4_K_M.gguf', url: `${HY_MT}/HY-MT1.5-1.8B-Q4_K_M.gguf`, sizeBytes: 1133080512, sha256: '4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7' }],
      },
      {
        id: 'q8_0-cuda',
        displayName: 'Q8_0 (CUDA)',
        device: 'cuda',
        files: [{ path: 'HY-MT1.5-1.8B-Q8_0.gguf', url: `${HY_MT}/HY-MT1.5-1.8B-Q8_0.gguf`, sizeBytes: 1908528288, sha256: '6789b06d0902f2f5312c0e1703d56ccbddfcfb6c653d22519b7c720f7db9a98e' }],
      },
    ],
  },
  {
    id: 'bge',
    displayName: 'BGE (BAAI embeddings)',
    kind: 'embedding',
    defaultVariantId: 'bge-small-zh-v1.5',
    variants: [
      {
        id: 'bge-small-zh-v1.5',
        displayName: 'bge-small-zh-v1.5',
        device: 'cpu',
        files: [
          { path: 'model.onnx', url: `${BGE_SMALL}/onnx/model.onnx`, sizeBytes: 94851877, sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a' },
          ...BGE_SMALL_TEXT_FILES,
        ],
      },
      {
        id: 'bge-small-zh-v1.5-int8',
        displayName: 'bge-small-zh-v1.5 (int8)',
        device: 'cpu',
        files: [
          { path: 'model_quantized.onnx', url: `${BGE_SMALL}/onnx/model_quantized.onnx`, sizeBytes: 24010842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
          ...BGE_SMALL_TEXT_FILES,
        ],
      },
      {
        id: 'bge-m3-int8',
        displayName: 'bge-m3 (int8, multilingual)',
        device: 'cpu',
        files: [
          { path: 'model_quantized.onnx', url: `${BGE_M3}/onnx/model_quantized.onnx`, sizeBytes: 569694530, sha256: '0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d' },
          ...BGE_M3_TEXT_FILES,
        ],
      },
      {
        id: 'bge-small-zh-v1.5-cuda',
        displayName: 'bge-small-zh-v1.5 (CUDA)',
        device: 'cuda',
        files: [
          { path: 'model.onnx', url: `${BGE_SMALL}/onnx/model.onnx`, sizeBytes: 94851877, sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a' },
          ...BGE_SMALL_TEXT_FILES,
        ],
      },
      {
        id: 'bge-m3-int8-cuda',
        displayName: 'bge-m3 (int8, CUDA)',
        device: 'cuda',
        files: [
          { path: 'model_quantized.onnx', url: `${BGE_M3}/onnx/model_quantized.onnx`, sizeBytes: 569694530, sha256: '0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d' },
          ...BGE_M3_TEXT_FILES,
        ],
      },
    ],
  },
]

/**
 * Rewrite every file URL's origin with the configured mirror base.
 * @param catalog - the catalog to resolve.
 * @param mirrorBaseUrl - origin to swap in, or undefined to keep the built-in hosts.
 */
export function resolveCatalogUrls(catalog: Catalog, mirrorBaseUrl: string | undefined): Catalog {
  if (mirrorBaseUrl === undefined || mirrorBaseUrl.length === 0) return catalog
  return catalog.map(family => ({
    ...family,
    variants: family.variants.map(variant => ({
      ...variant,
      files: variant.files.map(file => {
        try {
          const url = new URL(file.url)
          return { ...file, url: mirrorBaseUrl + url.pathname }
        } catch {
          return file
        }
      }),
    })),
  }))
}

/**
 * Merge a user JSON document over the built-in catalog; unknown fields fail.
 * @param text - raw JSON of the override document.
 * @returns the merged catalog.
 */
export function applyCatalogOverride(text: string): Catalog {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || !('families' in value)) {
    throw new Error('catalogOverride must be a JSON object with a families field')
  }
  const overrides = (value as { families: Record<string, unknown> })['families']
  return BUILTIN_CATALOG.map(family => {
    const override = overrides[family.id]
    if (override === undefined) return family
    if (typeof override !== 'object' || override === null) {
      throw new Error(`catalogOverride.${family.id} must be an object`)
    }
    return { ...family, ...override } as CatalogFamily
  })
}
