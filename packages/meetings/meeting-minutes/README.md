---
description: "Durable meeting records and configured-model summaries and answers on ctx.meetingMinutes."
kind: "package-reference"
---

# @deepseek-ai/dsh-meeting-minutes

English | [中文](README.zh.md)

## Summary

`ctx.meetingMinutes` stores meeting metadata, transcripts, summaries, and question/answer exchanges in the `meeting-minutes` storage domain. `createFromTranscript` imports text; `createFromAudio` resolves an explicit speech provider first. `summarize` and `ask` call one configured LLM route and persist successful text; failed model calls leave existing durable state unchanged.

## Configuration

`summaryProvider`, `summaryModel`, `summarySystemPrompt`, `answerSystemPrompt`, and `maxTranscriptChars` are required volatile fields. Composition owns the defaults; the service does not hide a model route, prompt, or transcript bound. Changes take effect on subsequent operations.

## Table of Contents

- [Summary](#summary)
- [Configuration](#configuration)
- [Service API](#service-api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-api"></a>
## Service API

`list`, `get`, and `listAnswers` read detached records; `get` and `listAnswers` fail for an absent meeting. `summarize`, `ask`, and `delete` serialize behind prior mutations. `delete` removes dependent answers before the meeting. Every asynchronous operation joins service disposal and honors its cancellation signal. No runtime invariant companion is published because the service owns the only independent observation of mutation order and dependent-record deletion.

## Model Experience

None, as this Service Definition invokes configured models and stores caller-owned results without contributing request context.

#### KV Cache effect

No direct effect; consumers that place persisted summaries or answers into model requests own any prefix effect.

## Known Limitations and Deferred Work

- Records have one latest summary; summary revisions and answer deletion are not exposed.
- Speaker diarization, streaming recognition, and export formats are out of scope.
- `audioSeconds` trusts the speech provider or caller and is not independently decoded.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
