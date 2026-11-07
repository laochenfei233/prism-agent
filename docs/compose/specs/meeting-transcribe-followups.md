---
feature: meeting-transcribe-followups
status: delivered
updated: 2026-11-06
branch: fix/meeting-transcribe-followups
commits: e13f05ae1c..HEAD # filled at delivery
---

# Meeting Transcription Follow-ups

English | [中文](meeting-transcribe-followups.zh.md)

## Report

**What was built** — Ending a meeting no longer re-transcribes the whole recording: `onFinish` waits for the pending slice writes, releases the microphone, and closes the record with the transcript the slices saved and the recorded elapsed seconds. The live hint and the finishing label say so, and the `liveFinalFailed` path is gone from both dictionaries. The toolbar carries a recognizer selector fed by the speech status: switching persists the deployment's speech selection through `selectSpeech` → `ctx.speechToText.configure` (the `speech/select` route carries it), picking a language the provider accepts (current, else `auto`, else its first hint), so slices and imports route through the chosen provider — a cloud or HTTP provider ends the steering toward the local model. Dismissing the speech notice now remembers the dismissed text rather than a sticky flag: the selector and polling keep working, and a changed notice (for example a download turning into a failure) shows again.

**Verification** — `pnpm exec vitest run packages/prism/prism-meeting` — 182 tests, 8 files, all pass (finish-without-second-recognition, selector switch + failure surfacing, dismissal persistence and re-show on change, compatibleLanguage, select request shapes and narrowing). `tsc -b` on the package's host and client faces — 0 own errors (50 client-face errors under `packages/api/*` are pre-existing fork aggregate issues exposed on fresh worktrees, untouched here). `run-oxlint` — 0/0. `verify-cordis-api` — green after regenerating the catalog (`selectSpeech`, `languages`/`language` projections now recorded in the subsystem docs and the tool-cordis api catalog; the generator now runs clean at this baseline). `verify-translation-pairing` — only the documented pre-existing red item remains. The rebuilt tarball was installed over the September build in the `web` profile (patch rows unchanged; the profile restarts to load the new client bundle).

**Journey log** — The redundant closing pass was the single failure point operators saw; deleting it also deleted the failure mode. Selection already existed one layer down (`ctx.speechToText.configure`), so the page feature is a projection and a route, not a second settings system. A stub returning the same mutable object made React skip the re-render the dismissal test needed — status holders must hand out fresh references. Generator health changed under our feet: `gen-cordis-catalog` was documented broken at baseline and now runs clean, so the hand-projection workaround retired after one use.

## [S1] Problem

Three operator complaints on the installed Meetings page: (1) slices still fail with "Prepare the local speech provider before recording" because the deployed profile runs the September plugin build without the auto-wait; (2) ending a meeting re-transcribes the entire recording even though the eight-second slices already saved the transcript — the redundant pass is the exact step that fails and doubles recognition cost; (3) the page offers no recognizer choice, so a deployment with a configured cloud/HTTP provider is still steered at the local model.

## [S2] Design

### S2.1 Ending stores the live transcript

- `onFinish` awaits the pending slice writes, stops the microphone, and `finish`es with the accumulated live transcript (`liveBody`) — no second recognition call, no `liveFinalFailed` path. `audioSeconds` is the recorded elapsed time, matching the request type's documented fallback.
- Copy updates: the live hint says slices save every N seconds (no end-of-meeting re-transcription promise), the finishing phase reads "ending", and the `liveFinalFailed` key is removed from both dictionaries.

### S2.2 Recognizer selection on the page

- `MeetingSpeechProvider` gains `languages` (already carried by the host view); `MeetingMinutesService.selectSpeech(providerId, language?)` persists the choice through `ctx.speechToText.configure` and returns fresh status; the `speech/select` route exposes it.
- The toolbar gains a recognizer `<select>` fed by the speech status; on change the page picks a compatible language (current selection language if the provider accepts it, else `auto` if accepted, else the provider's first language) and calls `selectSpeech`; the warning bar dismissal no longer discards the status, so the selector and polling keep working.
- Selecting a cloud or HTTP provider routes slices and imports there through the existing default selection; no local-model download is triggered unless that provider is selected.

### S2.3 Deployment of the fix

- The plugin is rebuilt in the worktree and repacked, and the tarball is installed over the stale September build in the `web` profile, so the already-landed auto-wait plus this change actually run; the profile restarts to pick up the new client bundle.

## [S3] Scope

- In scope: page finish/slice behavior and copy, speech provider projection and selection service/route/api/page, locales (zh/en), tests for the touched behavior, plugin rebuild and installation into the `web` profile, spec trio.
- Out of scope: SenseVoice/DashScope provider packages, the separate `feat/huiji-integration` meeting lineage, streaming recognition, per-meeting (non-persisted) provider overrides.

## Tasks

- [x] T1: Finish stores the live transcript; copy updated (depends: none)
- [x] T2: Provider selection — projection, service, route, api, page, locales (depends: none)
- [x] T3: Tests for T1–T2 (depends: T1, T2)
- [x] T4: Verify + review + finalize; rebuild and install the plugin into the `web` profile (depends: T3)

## [S4] Acceptance

- [x] Ending a meeting performs no second recognition request; the durable record carries the accumulated slice transcript and the recorded elapsed seconds.
- [x] The `liveFinalFailed` copy is gone; the live hint no longer promises an end-of-meeting re-transcription.
- [x] The page lists registered recognizers with their languages, switching persists the choice through the speech selection, and slices afterward use the newly selected provider.
- [x] A failed selection surfaces an operator-readable error and leaves the previous selection intact.
- [x] Focused tests, typecheck, and lint pass on the touched surface; the rebuilt tarball installs into the `web` profile and its `lib/index.js` contains the auto-wait symbols.
