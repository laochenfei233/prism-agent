---
feature: meeting-minutes-preparation-and-answers
status: delivered
updated: 2026-11-05
branch: codex/meeting-minutes-plugin
commits: base..HEAD # filled at delivery
---

# Meeting Minutes: Speech Preparation and In-page Answers

English | [中文](meeting-minutes-preparation-and-answers.zh.md)

## Report

**What was built** — The Meetings page now readies its speech provider instead of only reporting that recording will fail. `speech()` projects each provider's preparation progress (phase, failure message, download resource and bytes), `prepareSpeech`/`cancelSpeechPreparation` start and cancel the selected provider's preparation through the speech service, and the `speech/prepare` and `speech/cancel` routes expose both to the browser. `transcribe` holds recognition until the resolved provider can transcribe: an unprepared, failed, or cancelled provider starts its preparation first, an in-flight preparation is joined, and a failure rejects with the provider's own message, so live slices, the closing complete transcription, and audio import all self-heal. The page shows a preparation bar with a start action, download progress, and a cancel action, polling until the provider reaches a transcribable state, and `standby` reads as the prepared steady state it is.

The page also gained the answers surface the service always persisted: a third detail tab asks the configured model route about the open meeting and lists the stored exchanges newest first, while push-to-session stays unchanged. The detail column received token-level polish: unified notice bars with a left accent, a selected-row accent with focus-visible states, quieter empty states, a bounded transcript measure, and a distinct recording bar. The shared client bundler now probes a `src/client/index.tsx` entry so this package's TSX client half bundles again.

**Verification** — `pnpm exec vitest run packages/prism/prism-meeting` — 175 tests, 8 files, all passing (service preparation matrix, routes, api narrowing, presentation folds, page interactions). `pnpm exec tsc -b` on the package's host and client faces — clean. `run-oxlint` over `packages/prism/prism-meeting`, `packages/speech`, and `packages/client` — 0 warnings, 0 errors. `jscpd` on the package sources — 0 clones (the update/finish recording pair was extracted into one `writeRecording` path and a `recordingRoute` helper). `pnpm run verify-type-equiv` — 465 blocks match. `pnpm run verify-package-invariants` — 38 companions conform. `tsdown` in the package builds the host and client faces. `verify-translation-pairing` re-recorded for the spec trio, the meetings subsystem docs, and the package READMEs. Known pre-existing red gates outside this surface: `docs/config-catalog.md` pairing out of sync, and `docs/compose/spec/archive-import-prism-agent-e.md` missing its bilingual counterpart.

**Journey log** — The first cut of the auto-wait stored only in the service; pairing it with a page-level prepare bar was what made the model download visible instead of a silent wait. The reviewer caught that `standby` — the prepared provider's normal resting phase — would have rendered a permanent false "not ready" warning; the phase vocabulary, not the boolean, is the thing to copy across every consumer. Rewriting the answers effect dropped `tab` from its dependency list and broke the tab fetch; the interaction test caught it immediately, which is why the page tests are worth their weight. The shared client bundler hardcoded a `.ts` entry, so this package's `.tsx` client entry could never bundle until the probe was added.

## [S1] Problem

The Meetings page records against a speech provider it cannot prepare. A local provider that still needs its model download stays `unprepared`, so every live slice and the final complete transcription fail with "Prepare the local speech provider before recording", and the page can only show advice that points at another page. The service also persists meeting answers (`ask`/`listAnswers`) that the page never renders, so the only question path leaves DSH.

## [S2] Design

### S2.1 Speech preparation exposure

- `MeetingSpeechProvider` carries a JSON-safe `preparation` projection (`phase`, `message`, `resource`, `completedBytes`, `totalBytes`) beside the existing `phase`; `speech()` fills it from the provider view.
- `MeetingMinutesService.prepareSpeech(providerId?)` starts or joins preparation of the selected (or named) provider through `ctx.speechToText.prepare` and returns fresh `speech()` status.
- `MeetingMinutesService.cancelSpeechPreparation(providerId?)` cancels that preparation and returns fresh status.
- The web routes `POST /api/prism-meeting/speech/prepare` and `POST /api/prism-meeting/speech/cancel` expose both operations behind the existing envelope.

### S2.2 Transcription waits for preparation

- `MeetingMinutesService.transcribe()` resolves the provider, then: a provider without preparation control proceeds unchanged; `ready`/`standby` proceeds unchanged; `unprepared`/`failed`/`cancelled` starts preparation first; every other phase joins the in-flight task.
- The wait subscribes to the provider's preparation and returns on `ready`/`standby`, rejects with the provider's failure message on `failed`, and rejects on `cancelled` or caller/service cancellation. No timeout beyond the caller signal: a model download is long by design and the page reports its progress.
- With readiness reached, the provider's own transcribe path runs as before, so live slices, the final complete transcription, and audio import all self-heal instead of failing.

### S2.3 In-page answers

- The web routes `POST /api/prism-meeting/ask` (`{id, question}`) and `POST /api/prism-meeting/answers` (`{id}`) expose `MeetingMinutesService.ask` and `listAnswers` as `answerView` projections.
- The page gains an answers tab beside summary and transcript: persisted exchanges newest first, an input with an ask action, disabled while the meeting is recording or the request is running. Push-to-session stays unchanged.

### S2.4 Page polish

- CSS-only polish within the shipped design tokens: unified notice bars with a left accent, selected-row accent and `:focus-visible` states, quieter placeholder and empty-state hierarchy, a bounded measure for transcript text, and a distinct recording bar tint. No structural redesign.

## [S3] Scope

- In scope: meeting service speech preparation exposure and auto-wait, web routes for prepare/cancel/ask/answers, client api and page Q&A and preparation UI, locales (zh/en), page CSS polish, focused tests, README and subsystem doc updates, and this spec.
- Out of scope: provider implementation changes (SenseVoice/DashScope), streaming preparation progress (polling only), export formats, speaker renaming, provider or language selection UI.

## Tasks

- [x] T1: Service — preparation projection in `speech()`, `prepareSpeech`/`cancelSpeechPreparation`, and the transcribe auto-wait (depends: none)
- [x] T2: Web — `speech/prepare`, `speech/cancel`, `ask`, `answers` routes (depends: T1)
- [x] T3: Client — api operations, preparation bar with progress, answers tab, locale keys (depends: T2)
- [x] T4: CSS polish per S2.4 (depends: T3)
- [x] T5: Tests — service, web, client-api, client-page, presentation (depends: T1–T3)
- [x] T6: Docs — README en/zh, subsystems, spec status (depends: T1–T4)

## [S4] Acceptance

- [x] With an unprepared selected provider, `transcribe()` starts preparation, waits, and returns the recognized transcript; a failed preparation rejects with the provider's failure message; caller cancellation during the wait rejects.
- [x] `speech()` reports the preparation projection, and `prepareSpeech`/`cancelSpeechPreparation` start and cancel the selected provider's preparation.
- [x] The web routes `speech/prepare`, `speech/cancel`, `ask`, and `answers` answer the envelope with the designed values.
- [x] The page offers preparation with progress for the selected provider, and the answers tab asks and lists persisted exchanges; a recording meeting shows its live transcript instead of the tab set, and the service refuses asking while recording.
- [x] A provider without preparation control transcribes unchanged.
- [x] Focused package tests, typecheck, lint, and duplication pass on the changed surface.
