---
feature: meeting-minutes-plugin
status: delivered
updated: 2026-09-26
branch: codex/meeting-minutes-plugin
commits: base..HEAD
---

# Prism Meeting Plugin

English | [中文](meeting-minutes-plugin.zh.md)

## Report

**What was built** — `@prism/prism-meeting` now owns durable meeting records and answers through `ctx.storageDomain`. It creates meetings from transcripts or complete audio, normalizes and bounds input, lists/reads/deletes records, generates configured-model summaries and persisted Q&A, and keeps failed or cancelled model work from changing durable state.

The same package exports create/list/get/summarize/ask through `@prism/prism-meeting/tools`. It also declares `dsh.bundle.patch`, so a packed tarball can be installed into a profile with `dsh plugin add`. The speech-to-text service and DashScope provider were promoted into `packages/speech`, the base bundle registers both entry points, and the latest desktop fixes were synchronized from `deepseek-harness`.

**Verification** — `pnpm run test -- packages/prism packages/speech` passed 6 files and 52 tests; the focused meeting service spec passed 24 tests, and package-discovery/workspace-constraint specs passed 108 tests. Removing the two pre-commit cancellation checks made both late-cancellation regressions fail, and restoring them returned the focused suite to 24/24 passing. `oxlint` for `packages/prism packages/speech`, `pnpm run typecheck`, `pnpm run test:snapshot -- -t meeting-minutes-list`, `pnpm run verify-package-invariants` (38 companions), `pnpm run duplication` (0 clones), `publint`, and `pnpm run verify-doc-budgets` (8 docs) passed. `pnpm pack` produced `prism-ai-prism-meeting-0.1.0.tgz`; installing it into an isolated profile added `@prism/prism-meeting` to `dsh.profile.bundles`, and `dsh --profile prism-test --dump-config` showed both entries. The synchronized desktop files match `deepseek-harness` byte-for-byte and `cargo fmt --check` passed. The repository-reference gate still reports only `archive-import-prism-agent-e.md`; repository-wide hygiene retains the documented pre-existing vendor-rescope, workspace-constraint, desktop-license, and ACP Cordis-config failures.

**Known gate status** — `pnpm run verify-package-dependencies` reports three unclassified Host value imports once the package also declares `dsh.client`: `@deepseek-ai/dsh-storage-domain#defineDomain`, `#domainTable`, and `@deepseek-ai/dsh-tools#defineTool`. Those imports predate the Web page; the `client-host` dependency-policy role that checks them applies because `dsh.client` was added. `scripts/package-dependency-policy.ts` forbids an automated exception, so the classification of those exports remains for human review.

**Journey log** — The transcription seam and DashScope provider were promoted from experimental packages so meeting audio can resolve one explicit Host provider. The first cancellation tests completed through the test LLM queue and still passed without the durable-write rechecks; the final regressions complete model work through a custom awaitable that aborts before the service resumes, so mutation testing proves each recheck is necessary. Empty-audio cancellation is asserted before validation so caller cancellation remains the first observable failure. The service and tool packages were then merged under the Prism-owned `@prism/prism-meeting` package so future products can extend DSH without occupying its package namespace.

## [S1] Problem

The prior Electron release could persist meeting metadata and transcripts, generate an AI summary, ask questions about a meeting, and record those answers. DeepSeek Harness has no equivalent capability, so meeting work is not available to plugins, tools, or future Host surfaces.

## [S2] Design

- Add `@prism/prism-meeting` as the Host service provider on `ctx.meetingMinutes`.
- Use `ctx.storageDomain` for cross-session meeting records and answers; do not put cross-session resources into Session logs.
- Use `ctx.speechToText` for complete-audio transcription and `ctx.llm` for summary and answer generation.
- Add the same package's `./tools` entry as the model-facing consumer with explicit list/get/create/summarize/ask operations.
- Require the deployment to configure summary and answer model routes, prompts, and transcript bounds. No service code supplies hidden model defaults.
- Normalize titles, participant names, transcripts, and questions at the public operation input; durable record schemas validate the persisted JSON.
- Track service-owned work so disposal aborts audio/model work, waits for settlement, and closes the domain.
- Include the DashScope transcription provider work already prepared in the workspace so speech selection has a host cloud provider.

## [S3] Scope

- In scope: service, durable storage, audio and transcript ingestion, summary, question/answer persistence, model-facing tools, tests, READMEs, composition registration, docs/group/config registration, and synchronization of the latest `deepseek-harness` desktop updates.
- Out of scope: Web cards or Host meeting UI, streaming speech recognition, calendar integration, speaker diarization, file/audio attachment persistence, and export formats.

## Tasks

- [x] T1: Implement durable meeting service and audio/transcript ingestion.
- [x] T2: Implement summary and persisted question/answer operations.
- [x] T3: Implement model-facing meeting tools.
- [x] T4: Integrate the DashScope speech provider and register both Prism meeting entry points in the base bundle.
- [x] T5: Run focused verification and fix failures.

## [S4] Acceptance

- [x] A meeting can be created from a transcript or audio, listed, read, and deleted; deletion removes its answers.
- [x] Summarization calls the configured LLM route and persists a successful summary; failure leaves the record transcribed.
- [x] Asking a question calls the configured LLM route, returns the answer, and persists the question/answer pair.
- [x] The `@prism/prism-meeting/tools` entry can perform list/get/create/summarize/ask through `ctx.meetingMinutes` and register/dispose safely.
- [x] Speech-to-audio ingestion uses the explicitly resolved speech provider and honors cancellation.
- [x] TypeScript, focused tests, lint, duplication, hygiene, and documentation gates relevant to the changed surface pass.
