---
feature: http-asr-provider
status: delivered
updated: 2026-11-05
branch: feat/http-asr-provider
commits: bc4508fd0b..HEAD # filled at delivery
---

# HTTP ASR Provider

English | [中文](http-asr-provider.zh.md)

## Report

**What was built** — `packages/speech/speech-to-text-http` (`@deepseek-ai/dsh-speech-to-text-http`) turns third-party ASR services into configuration. The plugin takes a `services` list and registers one `ctx.speechToText` recognizer per entry, so OpenAI-compatible endpoints (OpenAI Whisper API, Groq, SiliconFlow, self-hosted whisper.cpp servers) and any service answering JSON text appear in the voice-input selector and the meetings page without a line of provider code. Each recognizer uploads the canonical WAV as OpenAI-shaped `multipart/form-data` with the model and language (omitted for `auto`), resolves the bearer key from the literal configuration, the credentials plane, or the launch environment, bounds each recognition by `maxAudioBytes`, `maxDurationSeconds`, and `timeoutMs`, and reads the text from the configured top-level JSON field; an empty answer is the legitimate no-speech transcript. Incomplete entries, duplicate ids, missing keys, non-canonical WAV, oversized recordings, and non-2xx or malformed answers all fail loud with operator-readable messages.

Consumers stay unchanged by design: voice-input and the meetings page follow the deployment's default selection, so selecting the third-party provider routes recognition there. Registration docs caught the new package up with the repo's generated and hand-maintained rosters (tsconfig paths and host solution, config catalog en+zh, plugin-package skill reference, speech group README, voice-input subsystem page).

**Verification** — `pnpm exec vitest run packages/speech/speech-to-text-http` — 15 tests pass (multipart shape, language handling, key-resolution branches, failure mapping, registration/withdrawal, duplicate id, incomplete entry). `tsc -b` on the package — clean; `run-oxlint packages/speech` — 0/0; `jscpd` — 0 clones; `verify-package-invariants`, `verify-config-catalog`, `verify-plugin-packages`, `verify-doc-budgets`, `verify-translation-pairing` — green (pairing reports only the two documented pre-existing red items). Independent review passed after fixing two criticals (stale generated catalogs; missing `.required()` on the four identity fields) and the minors. **PRE-EXISTING, not this change's surface:** root `pnpm run build:lib:host` reports 4 TS6307 errors under `packages/prism/prism-meeting/src/client/**` — the parent feature's client face claims `src/client/**` while the root host include sweeps its `client-*.spec` tests importing those files; it predates this increment (masked by stale tsbuildinfo), involves no file of this change, and belongs to the parent feature's aggregate-wiring decision.

**Journey log** — The registry seam was never the problem: `ctx.speechToText.register` plus the persisted selection already route every consumer, so the whole feature is one config-driven provider package. Schemastery resolves absent keys of non-`.required()` fields to `undefined` without error — a config array entry silently registering under key `undefined` is exactly the misconfiguration that must fail at load. Generated catalogs are single-sided: `gen-config-catalog` writes only the English doc, so the zh counterpart needs a hand-projected section and a pairing re-record. Stale tsbuildinfo masked real aggregate-wiring errors in the root host build until `--force` and fresh builds exposed them.

## [S1] Problem

`ctx.speechToText.register` is the provider seam, and a third-party recognizer written as a Cordis plugin appears everywhere (voice-input selector, meeting page, default selection) — but adding one third-party ASR service today means writing a TypeScript provider package per service. Most third-party services (OpenAI Whisper API, Groq, SiliconFlow, self-hosted whisper.cpp servers) share one shape: an authenticated HTTP POST of a canonical WAV that answers JSON with the recognized text.

## [S2] Design

### S2.1 One config-driven package, many services

- `packages/speech/speech-to-text-http` (`@deepseek-ai/dsh-speech-to-text-http`) registers one `SpeechProvider` per configured service entry; the plugin takes `services: []` and duplicates fail loud at load.
- Each service entry carries: `providerId`, optional display `name`, `endpoint`, `apiKey` (secret) with `apiKeyEnv` (credential reference, falling back to the launch environment like DashScope), `model`, `languages`, `textField` (top-level JSON response field, default `text`), `maxAudioBytes`, and `timeoutMs`.
- The request preset is the OpenAI `/audio/transcriptions` shape: `multipart/form-data` with `file` (canonical WAV), `model`, and `language` (omitted for `auto`). Key resolution, the registry effect, and disposal mirror the DashScope provider.
- A provider without preparation control registers as immediately ready, so voice-input and the meeting page see it and the global selection switches to it without code.

### S2.2 Consumers stay unchanged

- The meeting page follows the deployment's default selection, so selecting the third-party provider in the voice-input selector or profile configuration routes meeting transcription to it. No meeting-page picker this round.

## [S3] Scope

- In scope: the speech-to-text-http package (provider, plugin config, tests, README en/zh), tsconfig path registration, package gates.
- Out of scope: streaming/realtime third-party protocols, response formats beyond a top-level text field, a meeting-page provider picker, per-meeting provider selection in tools.

## Tasks

- [x] T1: Provider and plugin config with tests (depends: none)
- [x] T2: Package registration (tsconfig paths, invariants, docs) (depends: T1)
- [x] T3: Verify + review + finalize (depends: T2)

## [S4] Acceptance

- [x] Each configured service registers a provider that transcribes one canonical WAV over HTTP with the bearer key from its credential reference and answers the mapped text field.
- [x] `language: 'auto'` omits the form field; a configured language is sent.
- [x] A missing API key, a non-canonical WAV, an oversized recording, and a non-2xx answer each fail with an operator-readable message.
- [x] Duplicate provider ids fail at load; disposal withdraws every registration.
- [x] Focused tests, typecheck, lint, duplication, and package gates pass on the changed surface.
