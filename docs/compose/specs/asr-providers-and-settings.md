---
feature: asr-providers-and-settings
status: delivered
updated: 2026-11-18
branch: feat/asr-providers-and-settings
commits: f5baf8f73f..760b99e11c
---

# ASR provider expansion: six services, duration chunking, speech settings section

English | [中文](asr-providers-and-settings.zh.md)

## Report

**What was built** — The speech registry splits any recording beyond a provider's declared request cap at quiet 20 ms windows (1 s minimum pieces) before the cap boundary, recognizes the pieces in order, and merges text, offset segment times, and duration totals; every recognizer now declares its cap. The HTTP ASR provider speaks nine request forms — OpenAI multipart with an optional model, chat-completions, raw-body, Tencent SentenceRecognition (TC3-HMAC-SHA256, golden-pinned), iFlytek lfasr (four-step job flow), Doubao flash edition, Google Speech v1, Azure fast transcription, and Amazon Transcribe (SigV4 over S3) — with a configurable credential header and dot-path response mapping, so DeepSeek, DashScope qwen3-asr, Deepgram, ElevenLabs, Groq, and Mistral join by configuration. The voice-input bundle ships deepseek-asr and dashscope-qwen3 built-ins, and a new speech settings section (order 11, after models) renders service cards with credential management plus the default-recognizer switcher.

**Verification** — 343/343 focused tests across the seven touched packages (seam chunking 35, HTTP provider 43, DashScope/OpenAI/SenseVoice/voice-input/settings-speech suites); per-package and aggregate `tsc -b` clean for every touched package and the client/host aggregates show zero errors in touched files; doc gates green for the touched surfaces (doc-standard 22/22, package-README limitations 390 files, doc budgets, doc references 5024 files, translation pairing for every edited pair, config/cordis/tool/client catalogs regenerated). Remaining aggregate reds are pre-existing (2026-11-05 baseline + later resync drift): stale bilingual records for earlier fork specs, tool-catalog zh drift, the webserver README summary, and the known Windows TMP/esbuild documentation-build issue; the duplication gate counts 27 clones with zero in the new files (13-clone baseline documented 2026-10-31, drift from later sessions). All adapter flows and signatures are fake-server and golden-vector tested; none has run against its live service in this environment.

**Journey log** — The quiet-boundary cut initially picked the first scanned window whenever windows tied in energy, shattering uniform tone into 20 ms slivers; anchoring the comparison on the target window's own energy and enforcing a 1 s minimum piece fixed it. The first TC3 golden vector agreed with the implementation because both shared the same canonical-header construction mistake (per-header newlines doubled); recomputing from Tencent's documented concatenation fixed implementation and vector together. Volcano's standard submit/query edition accepts audio URLs only, so the feature landed on the flash edition, which takes base64 bytes. The registry pre-measuring duration turned non-canonical audio into a seam-level error that shadowed providers' own Prepare failures; unparseable audio now passes through whole.

## [S1] Problem

The meeting page and voice input currently expose a narrow recognizer roster: `dashscope-funasr` (WebSocket), `sensevoice-local` (local ONNX), `openai-transcription`, plus whatever the user hand-writes into `speech-to-text-http` config in a cordis patch file. Adding any third-party ASR means editing YAML by hand; there is no settings UI surface. Mainstream Chinese-market providers are not covered: DeepSeek ASR, Aliyun DashScope qwen3-asr, ByteDance/Volcano Doubao, Tencent Cloud, and iFlytek all require per-service integration. Separately, providers cap the audio length they accept per request (MiMo 30 min, DeepSeek 120 s, Tencent sentence 60 s), so importing a long recording fails outright with "Audio exceeds N seconds" and live rollover past the cap is impossible.

## [S2] Design

### S2.1 Seam-level chunked transcription

`SpeechProviderInfo` gains an optional `maxAudioSeconds?: number`. Each provider package maps its configured request cap into the info it registers (`speech-to-text-http` per service `maxDurationSeconds`; `dashscope`, `openai`, `sensevoice` from their existing config fields; `sensevoice` derives seconds from `maxAudioBytes` as `input.ts` already does).

`packages/experimental/speech-to-text/src/wave.ts` gains `readWaveSeconds(audio)` (extracted from `validateWave`) and `sliceWave(audio, startSample, endSample)` emitting a canonical 16 kHz mono PCM16 WAV.

`SpeechToText.transcribe()` (seam, `src/index.ts`) chunks when the resolved provider declares a cap and the input exceeds it: cut points search up to 3 s before the cap boundary for the lowest-energy (quiet) 20 ms window, falling back to a hard cut; chunks are transcribed sequentially under the existing abort/pending tracking. Results merge: text joins with `\n`, provider segments keep their times shifted by the chunk start (a synthesized segment covers a chunk that returned none), `audioSeconds` and `inferenceSeconds` sum.

Under-cap input is a single provider call exactly as today; the per-provider internal validations remain as backstops. The live meeting path (8 s slices) never triggers chunking; the file-import path is the primary beneficiary.

### S2.2 speech-to-text-http flavor expansion

Service entries gain new `mode` values alongside `transcriptions` and `chat-completions`:

- `tencent-sentence` — `POST https://asr.tencentcloudapi.com`, `SentenceRecognition` / `2019-06-14`, TC3-HMAC-SHA256 signing from SecretId + SecretKey, `SourceType: 1` (base64 WAV in `Audio`), `EngSerViceType` from `engineModel` (default `16k_zh`), text read from `Response.Result`. Cap 60 s.
- `xfyun-filetrans` — iFlytek lfasr over `https://raasr.xfyun.cn/api`: prepare, ordered 10 MiB slice upload, merge, progress polling (`signa` = base64(HMAC-SHA1(secretKey, MD5(appId+ts)))), and sentence result read. Cap 5 h; polling bounded by `timeoutMs`.
- `volcano-flash` — Doubao recording-file recognition, *flash* edition: one `POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` carrying `audio.data` (base64), `X-Api-Key`, status in the `X-Api-Status-Code` response header, text and utterance segments in the body. Cap 2 h. The standard submit/query edition is URL-only and stays out of scope.

`model` becomes optional for every mode: absent `model`/`language` form fields are simply omitted (`transcriptions` keeps working for OpenAI/Groq/Qwen/DashScope compatible endpoints). DeepSeek ASR is therefore pure config: `endpoint: https://api.deepseek.com/v1/tools/asr`, no `model`, cap 120 s, `maxAudioBytes` 8 MiB.

Generic auth and response ergonomics, added to the shared request layer so several international services stay config-only or near-config-only:

- `authHeader?: string` + `authStyle?: 'bearer' | 'token' | 'raw'` — non-Authorization keys (ElevenLabs `xi-api-key`, raw) and prefixed Authorization forms (`Token <key>` for Deepgram) ride the existing key resolution instead of bespoke adapters.
- `textField` gains dot-path access (`results.channels.0.alternatives.0.transcript`).
- A `raw-body` request form: the WAV bytes as the whole request body with `audio/wav` and any fixed model or language parameters living in the endpoint URL — this is the whole Deepgram `/v1/listen` story.

Provider-specific modes on top of that:

- `deepgram-listen` — raw-body to `https://api.deepgram.com/v1/listen`, `Authorization: Token <key>`, model/language as query parameters, text at `results.channels.0.alternatives.0.transcript`.
- `google-speech-v1` — `POST https://speech.googleapis.com/v1/speech:recognize?key=<apiKey>`, JSON envelope `{config: {encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode, model}, audio: {content: <base64>}}`, join `results[].alternatives[0].transcript`. Cap 60 s.
- `azure-fasttranscribe` — `POST https://{region}.stt.speech.microsoft.com/speechtotext/fasttranscriptions:transcribe` (api-version per current doc), `Ocp-Apim-Subscription-Key` header, multipart `audio` + `definition` JSON (locales), sync response. Cap ~120 s, so long imports chunk per S2.1.

Key resolution keeps the existing three-level chain (literal → credentials → launch environment) and generalizes to the per-flavor secret fields (SecretId/SecretKey, AppId/secret key, access token, subscription key) with the same chain per field.

### S2.2.1 AWS Transcribe (S3 prerequisite)

AWS batch recognition has no inline-audio API: `StartTranscriptionJob` takes an S3 URI and the transcript lands as an S3 JSON. The `aws-transcribe` adapter therefore requires a configured S3 bucket and does: SigV4-signed `PutObject` of the WAV → SigV4-signed `StartTranscriptionJob` → poll `GetTranscriptionJob` → signed GET of the transcript URI → join transcript segments. Config: region, `accessKeyIdEnv`/`secretAccessKeyEnv`, bucket, language code; cap 4 h. This is the largest adapter in the feature and is implemented last so its weight cannot block the rest; if SigV4 + S3 proves disproportionate at implementation time, stop and re-grill rather than ship a half-tested path.

### S2.3 Built-in services in the base profile

Where the voice bundles wire their speech providers, the base profile registers `speech-to-text-http` with two built-in services:

- `deepseek-asr` — as above; `DEEPSEEK_API_KEY` (already the one credential the app ships).
- `dashscope-qwen3` — `https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions`, model `qwen3-asr-flash`, `DASHSCOPE_API_KEY`.

Cloud providers register as `ready` immediately, so both appear in the meeting-page selector without preparation. The user's existing MiMo patch entry stays; the 30-minute rollover for it comes free from S2.1 once its entry sets `maxDurationSeconds: 1800` (documented in the upgrade guide, editable in the settings section).

### S2.4 Settings section: 语音识别

New package `packages/client/ui-settings-speech` injecting `settings.section` with `id: 'speech'`, `order: 11` (immediately after models), locale namespace `settings.speech` (zh `语音识别` / en `Speech recognition`) — the same injection pattern as the data section.

Content, modeled on the models section's card layout:

- A default-recognizer switcher bound to the speech-to-text seam's persisted selection (roster `id`/`name`/`phase`/`languages` from the remote speech face).
- One card per configured `speech-to-text-http` service: name, endpoint, model, credential reference, and the API key written through `credentials/set` with a derived ref (the models-section `storeCredential` pattern). Service list edits land as settings mutations against the `speech-to-text-http` config namespace; key state (configured or not) is shown on the card. Per-form extras stay configuration-file territory.

Host wiring: the http package's `Config` registers as a settings descriptor namespace (the host `SettingsForms` projection), and the existing experimental api speech-to-text remote face grows whatever list/configure operations the section needs (verify its current surface first; extend rather than duplicate).

### S2.5 Documentation and gates

Regenerate the config catalog (both languages, pairing verified), update the http package README pair, document the new config surface and the chunking behavior in the package README pair, add changelog entries, and refresh recorded-session snapshots if the roster or settings surface appears in expected outputs.

## [S3] Scope

- In scope: seam chunked transcription; optional-`model` plus the generic auth-header/dot-path/raw-body mechanisms; domestic flavors (tencent-sentence, xfyun-filetrans, volcano-flash) and international flavors (deepgram-listen, google-speech-v1, azure-fasttranscribe, aws-transcribe); built-in `deepseek-asr` + `dashscope-qwen3`; the speech settings section; docs/catalog/snapshot/changelog updates. OpenAI-compatible international services (OpenAI, Groq, Mistral) need no code — documented as config recipes.
- Out of scope: WebSocket streaming adapters (real-time providers); speaker diarization for new providers; recognizer-selector changes on the meeting page beyond what the roster already shows; localization beyond the zh/en pair; Azure batch transcription and any provider whose audio input is a URL only (Doubao standard submit/query edition).

## Tasks

- [x] T1: seam chunked transcription — info cap field, wave read/slice helpers, quiet-boundary chunk loop, merge semantics, unit tests (depends: none)
- [x] T2: generic request layer — optional model, authHeader/authStyle, dot-path textField, raw-body form (depends: none)
- [x] T3: domestic flavors — tencent-sentence, xfyun-filetrans, volcano-flash, per-flavor key fields, unit tests (depends: T2)
- [x] T4: international flavors — deepgram-listen, google-speech-v1, azure-fasttranscribe, aws-transcribe (last; re-grill point), unit tests (depends: T2)
- [x] T5: built-in deepseek-asr + dashscope-qwen3 in the base voice profile (depends: T3)
- [x] T6: speech settings section package + host face wiring (depends: T3, T4)
- [x] T7: docs, catalog, upgrade guide, changelog, snapshots (depends: T1–T6)

## [S4] Acceptance

- [ ] A fresh profile with `DEEPSEEK_API_KEY` shows `deepseek-asr` in the meeting roster and transcribes an 8 s clip through `/v1/tools/asr` (no `model` field sent).
- [ ] A profile with `DASHSCOPE_API_KEY` shows `dashscope-qwen3` and transcribes through the compatible-mode endpoint.
- [ ] Importing a 40-minute WAV into a service capped below 40 minutes produces a merged transcript (text joined, segment times offset, totals summed) with no "Audio exceeds" error; unit tests cover the chunk boundary, merge, and quiet-boundary fallback.
- [ ] `tencent-sentence` produces a deterministic TC3 signature against a fixed clock (unit test) and parses `Response.Result`.
- [ ] `xfyun-filetrans` uploads, polls to completion, and returns text (fake-server unit test).
- [ ] `volcano-flash` sends base64 audio with the documented headers and reads text plus utterance segments (fake-server unit test).
- [ ] `deepgram-listen`, `google-speech-v1`, and `azure-fasttranscribe` each build their documented request form and parse the documented response (fake-server unit tests).
- [ ] `aws-transcribe` either passes a fake-server round trip (upload → start → poll → read) or the feature returns to the user with the re-grill outcome and rationale.
- [ ] The settings section lists built-in and user services, edits a service field through a settings mutation, sets and removes a key through credentials, and switches the default recognizer; all persisted to the profile.
- [ ] Focused tests, typecheck, and doc-sync pass; locale pairs verified.
