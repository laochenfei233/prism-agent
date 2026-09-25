---
feature: meeting-minutes-plugin
status: in-progress
updated: 2026-09-25
branch: codex/meeting-minutes-plugin
commits: base..HEAD
---

# Meeting Minutes Plugin

English | [中文](meeting-minutes-plugin.zh.md)

## Report

Implementation is in progress.

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

- [ ] T1: Implement durable meeting service and audio/transcript ingestion.
- [ ] T2: Implement summary and persisted question/answer operations.
- [ ] T3: Implement model-facing meeting tools.
- [ ] T4: Integrate the DashScope speech provider and register the meeting plugins in the base bundle.
- [ ] T5: Run focused verification and fix failures.

## [S4] Acceptance

- [ ] A meeting can be created from a transcript or audio, listed, read, and deleted; deletion removes its answers.
- [ ] Summarization calls the configured LLM route and persists a successful summary; failure leaves the record transcribed.
- [ ] Asking a question calls the configured LLM route, returns the answer, and persists the question/answer pair.
- [ ] Model tools can perform list/get/create/summarize/ask through `ctx.meetingMinutes` and register/dispose safely.
- [ ] Speech-to-audio ingestion uses the explicitly resolved speech provider and honors cancellation.
- [ ] TypeScript, focused tests, lint, duplication, hygiene, and documentation gates relevant to the changed surface pass.
