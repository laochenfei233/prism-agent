---
description: "Prism meeting records, configured summaries and answers on ctx.meetingMinutes, and model-facing tools."
kind: "package-reference"
---

# @prism-ai/prism-meeting

English | [中文](README.zh.md)

## Summary

`ctx.meetingMinutes` stores meeting metadata, transcripts, summaries, and question/answer exchanges in the `meeting-minutes` storage domain. `createFromTranscript` imports text; `createFromAudio` resolves an explicit speech provider first. `summarize` and `ask` call one configured LLM route and persist successful text; failed model calls leave existing durable state unchanged. The `./tools` subpath registers the model-facing create, list, get, summarize, and ask operations.

## Configuration

`summaryProvider`, `summaryModel`, `summarySystemPrompt`, `answerSystemPrompt`, and `maxTranscriptChars` are required volatile fields. Composition owns the defaults; the service does not hide a model route, prompt, or transcript bound. Changes take effect on subsequent operations.

## Table of Contents

- [Summary](#summary)
- [Installation](#installation)
- [Configuration](#configuration)
- [Service API](#service-api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="installation"></a>
## Installation

Install the tarball into a base-backed DSH profile, then restart that profile:

```sh
dsh plugin --profile <profile> add /absolute/path/to/prism-ai-prism-meeting-0.1.0.tgz
dsh --profile <profile>
```

The package declares `dsh.bundle.patch`. Its insert rows reuse the `prism-meeting` and `tool-prism-meeting` ids when the base bundle already provides them, and add both entries in profiles that do not. The profile needs the base LLM, storage-domain, speech-to-text, and tools services. Set `DASHSCOPE_API_KEY` for audio recognition.

<a id="service-api"></a>
## Service API

`list`, `get`, and `listAnswers` read detached records; `get` and `listAnswers` fail for an absent meeting. `summarize`, `ask`, and `delete` serialize behind prior mutations. `delete` removes dependent answers before the meeting. Every asynchronous operation joins service disposal and honors its cancellation signal. No runtime invariant companion is published because the service owns the only independent observation of mutation order and dependent-record deletion.

## Model Experience

### Tool schema

#### What the model sees

The `./tools` subpath registers `meeting_minutes_create`, `meeting_minutes_list`, `meeting_minutes_get`, `meeting_minutes_summarize`, and `meeting_minutes_ask` in the [generated tool catalog](../../../docs/tool-catalog.md#prism-aiprism-meeting). Create requires a title and complete transcript; list takes no input; get, summarize, and ask require the meeting id, and ask also requires the question. Success results are compact JSON projections; failures preserve validation, not-found, model, storage, and cancellation errors.

#### Token effect

The five fixed schemas are present on every request where the plugin is visible. Transcript text appears only in create arguments and `meeting_minutes_get` results; `meeting_minutes_list` returns transcript length instead of content.

#### KV Cache effect

Tool definitions are prefix-stable while plugin visibility is unchanged. Long get results and create arguments follow normal append-only history growth.

## Known Limitations and Deferred Work

- Records have one latest summary; summary revisions and answer deletion are not exposed.
- The tool surface has no delete, answer-listing, update, or audio-ingestion operation.
- A model cannot select the speech provider; text import is the only tool creation path.
- Speaker diarization, streaming recognition, and export formats are out of scope.
- `audioSeconds` trusts the speech provider or caller and is not independently decoded.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism owns this package; the service keeps the DSH `ctx.meetingMinutes` capability name.

</details>
