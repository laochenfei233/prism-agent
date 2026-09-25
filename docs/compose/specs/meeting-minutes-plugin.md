---
feature: meeting-minutes-plugin
status: delivered
updated: 2026-09-25
branch: codex/meeting-minutes-plugin
commits: base..HEAD
---

# Meeting Minutes Plugin

English | [中文](meeting-minutes-plugin.zh.md)

## Report

**What was built** — `@deepseek-ai/dsh-meeting-minutes` now owns durable meeting records and answers through `ctx.storageDomain`. It creates meetings from transcripts or complete audio, normalizes and bounds input, lists/reads/deletes records, generates configured-model summaries and persisted Q&A, and keeps failed or cancelled model work from changing durable state.

`@deepseek-ai/dsh-tool-meeting-minutes` exposes create/list/get/summarize/ask as model tools. The speech-to-text service and DashScope provider were promoted into `packages/speech`, and the base bundle registers both packages.

**Verification** — `pnpm run test -- packages/meetings packages/speech` passed 6 files and 52 tests; the focused meeting service spec passed 24 tests. Removing the two pre-commit cancellation checks made both late-cancellation regressions fail, and restoring them returned the focused suite to 24/24 passing. `oxlint` for `packages/meetings packages/speech`, `pnpm run typecheck`, `pnpm run test:snapshot -- -t meeting-minutes-list`, `pnpm run verify-package-invariants` (38 companions), `pnpm run duplication` (0 clones), and `pnpm run verify-doc-budgets` (8 docs) passed. The repository-reference gate still reports only `archive-import-prism-agent-e.md`; repository-wide hygiene retains the documented pre-existing vendor-rescope, workspace-constraint, desktop-license, and ACP Cordis-config failures.

**Journey log** — The transcription seam and DashScope provider were promoted from experimental packages so meeting audio can resolve one explicit Host provider. The first cancellation tests completed through the test LLM queue and still passed without the durable-write rechecks; the final regressions complete model work through a custom awaitable that aborts before the service resumes, so mutation testing proves each recheck is necessary. Empty-audio cancellation is asserted before validation so caller cancellation remains the first observable failure.

## [S1] Problem

The prior Electron release could persist meeting metadata and transcripts, generate an AI summary, ask questions about a meeting, and record those answers. DeepSeek Harness has no equivalent capability, so meeting work is not available to plugins, tools, or future Host surfaces.

## [S2] Design

- Add `@deepseek-ai/dsh-meeting-minutes` as the Host service provider on `ctx.meetingMinutes`.
- Use `ctx.storageDomain` for cross-session meeting records and answers; do not put cross-session resources into Session logs.
- Use `ctx.speechToText` for complete-audio transcription and `ctx.llm` for summary and answer generation.
- Add `@deepseek-ai/dsh-tool-meeting-minutes` as the model-facing consumer with explicit list/get/create/summarize/ask operations.
- Require the deployment to configure summary and answer model routes, prompts, and transcript bounds. No service code supplies hidden model defaults.
- Normalize titles, participant names, transcripts, and questions at the public operation input; durable record schemas validate the persisted JSON.
- Track service-owned work so disposal aborts audio/model work, waits for settlement, and closes the domain.
- Include the DashScope transcription provider work already prepared in the workspace so speech selection has a host cloud provider.

## [S3] Scope

- In scope: service, durable storage, audio and transcript ingestion, summary, question/answer persistence, model-facing tools, tests, READMEs, composition registration, and docs/group/config registration.
- Out of scope: Web cards or Host meeting UI, streaming speech recognition, calendar integration, speaker diarization, file/audio attachment persistence, and export formats.

## Tasks

- [x] T1: Implement durable meeting service and audio/transcript ingestion.
- [x] T2: Implement summary and persisted question/answer operations.
- [x] T3: Implement model-facing meeting tools.
- [x] T4: Integrate the DashScope speech provider and register the meeting plugins in the base bundle.
- [x] T5: Run focused verification and fix failures.

## [S4] Acceptance

- [x] A meeting can be created from a transcript or audio, listed, read, and deleted; deletion removes its answers.
- [x] Summarization calls the configured LLM route and persists a successful summary; failure leaves the record transcribed.
- [x] Asking a question calls the configured LLM route, returns the answer, and persists the question/answer pair.
- [x] Model tools can perform list/get/create/summarize/ask through `ctx.meetingMinutes` and register/dispose safely.
- [x] Speech-to-audio ingestion uses the explicitly resolved speech provider and honors cancellation.
- [x] TypeScript, focused tests, lint, duplication, hygiene, and documentation gates relevant to the changed surface pass.
