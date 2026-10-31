# @prism/prism-local-models

English | [中文](README.zh.md)

Local capability models for Prism — OCR, translation, and RAG embeddings — installed under the Prism data directory and managed from the settings Models page through its `settings.models.footer` extension seat. The Models page itself is never edited.

## Model families

| Family | Kind | Variants | Runtime |
|---|---|---|---|
| RapidOCR (default OCR engine) | OCR | `standard` (PP-OCRv4 ONNX, models bundled in the npm package) | `@gutenye/ocr-node` provisioned into `<modelsRoot>/runtimes/rapidocr` |
| PaddleOCR | OCR | `cpu`, `cuda` | a Python venv provisioned from `pythonCommand`; a stdlib-only HTTP sidecar speaks to it on loopback |
| HY-MT1.5 (Hunyuan-MT1.5-1.8B, official GGUF export) | translation | `q4_k_m` (default), `q8_0`, plus `cuda` twins | `node-llama-cpp` provisioned into `<modelsRoot>/runtimes/hy-mt-1.5` |
| BGE (BAAI embeddings) | embedding | `bge-small-zh-v1.5` (default), its int8 build, `bge-m3` int8, plus `cuda` twins | `@huggingface/transformers` + `onnxruntime-node` provisioned into `<modelsRoot>/runtimes/bge` |

Download URLs pin the China-reachable hosts the files were verified against (`hf-mirror.com`); `mirrorBaseUrl` swaps the origin of every URL. Every downloaded file carries a pinned byte size and sha256; downloads stream through a `.part` temp file and rename only after the digest matches. Manually placed files are detected by the models-root scan and verified once.

## Storage

`<modelsRoot>` defaults to `<home>/models` (`modelsRoot` in the config). Layout: `<modelsRoot>/<familyId>/<variantId>/…`, with `registry.json` at the root holding per-family lifecycle state and cached integrity results. `runtimes/<familyId>` holds provisioned runtimes; each records a `.provisioned` marker listing its packages.

## Capability contract

The host half claims `ctx.prismLocalModels` (structural; see `src/service.ts`) with:

- `embed(texts): Promise<number[][]>` — BGE, mean pooling, L2 normalized.
- `ocr({ bytes, mime }): Promise<string>` — RapidOCR when ready, else the PaddleOCR sidecar.
- `translate(text, { to }): Promise<string>` — HY-MT1.5 with the Hunyuan-MT instruction template.
- `install/cancel/remove/probe/catalog/status` drive the Models-page card.

Every call fails with a typed `LocalModelsError` (`code` + actionable message) when the model or runtime is not ready. Features adopt these methods directly; wiring them into attachment or memory pipelines is deliberately left to their owners.

## Config (cordis.patch.yml row `local-models`)

- `modelsRoot?: string` — models directory; default `<home>/models`.
- `mirrorBaseUrl?: string` — origin swapped into every file URL.
- `pythonCommand?: string` — interpreter for the PaddleOCR venv; default `python`.
- `catalogOverride?: string` — path to a JSON document merged over the built-in catalog; unknown shapes fail at load.

## HTTP API

Authenticated `/api/local-models/*` routes via `connection.fetch.register`: `GET /catalog`, `GET /status`, `POST /install|cancel|remove|probe` with `{modelId[, variantId]}`. Typed failures answer as `{code, message}` with a mapped HTTP status.

## Limitations

- CPU paths are the verified ones. `cuda` variants exist for variant selection and their probes verify the execution provider; on a machine without a working provider the probe fails loudly — never a silent CPU fallback.
- The PaddleOCR venv downloads its own models on first use; the first probe can take minutes.
- `node-llama-cpp` downloads prebuilt binaries at provisioning; CUDA builds are best-effort on machines that have a GPU.
- HY-MT1.5 is an internal translation capability; it is never a selectable chat model.

## Development

```sh
pnpm exec tsc -p tsconfig.json --noEmit
../../node_modules/.bin/tsdown --config tsdown.config.ts
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
```

The desktop runtime picks the plugin up through `plugins/` copy at bundle time; see `docs/compose/spec/prism-local-models.md` for the full design and verification record.
