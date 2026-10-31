---
feature: prism-local-models
status: in-progress
updated: 2026-10-31
branch: feat/prism-local-models
commits: f879732059..(filled at delivery)
---

# Prism Local Models

English | [中文](prism-local-models.zh.md)

## Report

## [S1] Problem

The settings Models page manages remote LLM providers only. The capability models Prism itself needs — OCR over images, machine translation, RAG embeddings — have no home: no install location, no lifecycle management, no capability entry point for future features. These models should live inside Prism's data directory, be installed and managed where model management already lives (the Models page), and expose typed capabilities (`embed`, `ocr`, `translate`) that Prism features can call.

## [S2] Design

### S2.1 Shape: an out-of-tree dual-face plugin; the Models page stays untouched

`plugins/prism-local-models` (`@prism/prism-local-models`) follows the `plugins/prism-pocket` shape: a node half (`lib/index.js`, ESM) loaded through a Loader bundle row, and a browser half (`lib/client.js`, CJS closure registered through `window.__ModuleLoader__`) declared by `dsh.client: { platform: 'web' }` and `exports['./client']`. Models-page integration uses exclusively the page's declared extension seat `settings.models.footer` (`packages/client/ui-settings-models/src/client/slot-contract.ts`); `ModelsSection`, the settings shell, and every other package stay byte-identical, so upstream updates to the Models page keep applying cleanly.

### S2.2 Catalog and variants

A built-in catalog module defines four model families, each with installable variants:

- `rapidocr` — the default OCR engine: the PP-OCRv4 ONNX det/cls/rec models and dict ship inside the provisioned npm model bundle (`@gutenye/ocr-models`); one `standard` variant; CPU; tens of MB.
- `paddleocr` — the alternate OCR engine, provisioned into a Python environment; variants `cpu` (paddlepaddle) and `cuda` (paddlepaddle-gpu).
- `hy-mt-1.5` — Tencent Hunyuan-MT1.5-1.8B translation model, GGUF quantizations run through llama.cpp; variants `Q4_K_M` (default) and `Q8_0`, device `cpu` or `cuda`.
- `bge` — BAAI embeddings for RAG; variants `bge-small-zh-v1.5` (default) and `bge-m3`; ONNX, CPU; a `cuda` variant exists in the catalog and its probe verifies execution-provider availability (see S2.5).

Each variant carries: `id`, `displayName`, `device` (`cpu` | `cuda`), total size, `files` (`{ path, sha256, url }`), and runtime requirements. URLs pin the China-reachable hosts the files were verified against (`hf-mirror.com`; ModelScope mirrors where they exist), and the Config `mirrorBaseUrl` swaps the origin of every URL. The exact upstream files (repo, revision, sha256 — the upstream LFS object ids) were live-verified in T2; the Hunyuan-MT1.5 GGUF comes from Tencent's official `tencent/HY-MT1.5-1.8B-GGUF` export. A Config `catalogOverride` path merges a user JSON over the built-in catalog; unknown fields fail at load.

### S2.3 Storage layout and registry

Models live under the Config `modelsRoot`, defaulting to `dshHomePath('models')`, as `<modelsRoot>/<modelId>/<variantId>/<files…>`. A `registry.json` at `modelsRoot` records per-model state: `status` (`idle | downloading | provisioning | ready | error`), selected variant, per-file integrity (`sha256` result cached with file size and mtime), progress, and error. The registry scans `modelsRoot` on load and on every catalog read: manual placement is detected by presence plus file size, then sha256-verified once and cached. Downloads write to a `.part` file and rename atomically after verification; a failed verification deletes the temp file and reports a typed error.

### S2.4 Node-half service and capability contract

`PrismLocalModelsService` claims `ctx.prismLocalModels` through declaration merging and owns: `listStatus()`, `install(modelId, variantId)` (download plus provisioning, with progress and cancel), `cancel(modelId)`, `remove(modelId)`, `probe(modelId)` (runs a smoke inference and returns the observed result), and the capability methods `embed(texts: string[]): Promise<number[][]>`, `ocr(image: { bytes, mime }): Promise<OcrResult>`, and `translate(text: string, opts: { to: string; from?: string }): Promise<string>`. Capability methods throw a typed error with an actionable message when the model or its runtime is not ready. One active operation per model; different models run concurrently. OCR: RapidOCR is the default engine; PaddleOCR is opt-in.

### S2.5 Runtime provisioning

Native runtimes are not package dependencies of the plugin (out-of-tree plugins ship without `node_modules`); they are provisioned into `<modelsRoot>/runtimes/<name>` at install time and imported through `createRequire` from the provisioned path. npm-based runtimes (`@huggingface/transformers` for BGE, `@gutenye/ocr-node` for RapidOCR — a maintained PaddleOCR-ONNX implementation on onnxruntime-node, with a hand-rolled det/cls/rec pipeline as the named contingency if the dependency audit fails) install through the detected package manager; the Python environment for PaddleOCR is a venv provisioned with pip from the Config `pythonCommand`. `node-llama-cpp` for HY-MT downloads its prebuilt binaries (CPU verified; CUDA builds best-effort on machines that have a GPU). Requesting a `cuda` variant on a machine without a working execution provider fails at probe with an actionable message — never a silent CPU fallback. The CPU paths are the verified ones this iteration.

### S2.6 Inference wiring

- BGE: transformers.js embedding pipeline (tokenizer included), mean pooling, L2 normalization; CPU; `probe` embeds a fixed string and returns the vector dimension.
- RapidOCR: det → optional cls → rec over the installed ONNX models; `probe` OCRs a bundled sample image and returns the recognized text.
- PaddleOCR: the plugin writes a stdlib-only HTTP sidecar script into the runtimes directory, spawns it with the provisioned venv python, and POSTs images for OCR; health-checked, terminated on teardown; without a usable Python the row reports the missing-Python state.
- HY-MT1.5: an in-process llama.cpp context with the Hunyuan-MT prompt template; `probe` translates a fixed zh→en sentence. It is an internal capability only — no `ctx.llm` adapter, never selectable as a chat model.

### S2.7 HTTP API

Exact Fetch routes registered through `connection.fetch.register` under `/api/local-models` (the prism-pocket / prism-meeting pattern, authenticated by the shared `/api` carrier): `GET /catalog` (models, variants, status, integrity, paths), `GET /status` (progress snapshot), `POST /install` `{modelId, variantId}`, `POST /cancel` `{modelId}`, `POST /remove` `{modelId}`, `POST /probe` `{modelId}`. The browser half polls `GET /status` at 1 s while one of its operations is active; no new forwardable events are proposed.

### S2.8 Browser half: the Models-page card

The client half injects `['slots', 'locale']`, registers a `settings.models.footer` list entry, and renders one "本地模型 / Local models" card: a header with the models root path, and one row per family showing the name, a kind chip (OCR / 翻译 / 向量), a variant selector fed from the catalog, size, status or download progress, and 安装 / 取消 / 删除 / 检测 actions with their results; an OCR note states that RapidOCR is the default engine and PaddleOCR requires a Python environment. All copy routes through `ctx.locale` with merged zh/en dictionaries and a `LocaleNamespaceMap` entry; styling reuses app theme tokens.

## [S3] Scope

- In scope: the dual-face plugin (skeleton, patch rows, tsdown two-face build), the catalog and variant model, registry and manual-placement scan, download engine with integrity verification, runtime provisioning, the four model integrations with probes, the HTTP API, the Models-page footer card, zh/en locale, plugin README (en/zh), unit tests, the bilingual spec pair.
- Out of scope: any edit to `packages/` or `apps/`; registering HY-MT as a chat provider; OCR or embedding auto-integration into attachments/fs/memory pipelines (consumers adopt the `ctx.prismLocalModels` contract later); download resume; quantization tooling; platforms other than this Windows machine are best-effort, not gated; GPU execution is verified only as far as this machine allows, with fail-loud probes elsewhere.

## Tasks

- [ ] T1: plugin skeleton — package.json (`@prism/prism-local-models`, `dsh.bundle.patch`, `dsh.client`, `./client` export), cordis.patch.yml rows, tsdown two-face build, tsconfig, vitest (covers: S2.1)
- [ ] T2: catalog module (four families, variants, pinned upstream files with live-checked URLs and sha256), Config schema (`modelsRoot`, `mirrorBaseUrl`, `pythonCommand`, `catalogOverride`), registry store with scan/verify/manual placement (covers: S2.2, S2.3)
- [ ] T3: download engine (progress, cancel, sha256, atomic rename) and the six API routes over `connection.fetch.register` (covers: S2.4, S2.7)
- [ ] T4: runtime provisioning + BGE embedding on CPU; cuda variant probe fails loud with an actionable message (covers: S2.5, S2.6)
- [ ] T5: RapidOCR det/cls/rec inference and probe (covers: S2.6)
- [ ] T6: PaddleOCR sidecar script, venv provisioning, Python detection, teardown (covers: S2.6)
- [ ] T7: HY-MT1.5 GGUF translation through node-llama-cpp with the Hunyuan-MT prompt (covers: S2.6)
- [ ] T8: browser-half footer card, variant selector, status polling, zh/en locale dictionaries (covers: S2.8)
- [ ] T9: unit tests — catalog validation, registry state machine and manual placement, download verification, route handlers, provisioning command planning, pure UI logic, locale key parity (covers: S2.2, S2.3, S2.5, S2.7, S2.8)
- [ ] T10: README en/zh, spec pair + pairing record, verification — build both faces, typecheck, focused tests, boot a web profile with the plugin, screenshot the Models page card (covers: S4)

## [S4] Acceptance

- `git diff master..HEAD -- packages/ apps/` is empty; the Models page gains the 本地模型 card through `settings.models.footer` and renders correct zh/en copy.
- Installing BGE `bge-small-zh-v1.5` downloads into `<modelsRoot>`, passes sha256, shows progress, and `probe` returns a 512-dimension vector; the `cuda` variant probe fails with an actionable message on this machine.
- RapidOCR `probe` extracts the expected text from the bundled sample image; it is presented as the default OCR engine.
- PaddleOCR reports a missing-Python state without a configured interpreter; with one, the sidecar serves OCR and terminates on teardown.
- HY-MT1.5 `probe` translates a fixed zh→en sentence through the installed GGUF.
- `cancel` stops a download and removes its temp file; `remove` deletes the variant directory; manually placed complete files are detected and verified on the next scan.
- Unit tests pass; typecheck and the two-face build pass; `verify-translation-pairing` passes for the spec pair; README exists in en and zh.
