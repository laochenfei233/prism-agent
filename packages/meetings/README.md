---
description: "Durable meeting minutes: transcript/audio ingestion, configured summaries, persisted answers, and model-facing meeting tools."
kind: "package-group"
---

# meetings/ — Meeting-minutes capability family

English | [中文](README.zh.md)

## Summary

The meetings group persists durable meeting records outside Session logs and exposes controlled meeting operations to models. The service owns transcription ingestion, configured-model summaries, and persisted question/answer exchanges; the tool package projects those capabilities as explicit model tools. Type vocabulary and the generated Cordis API are on the [Meetings subsystem page](../../docs/subsystems/meetings.md).

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`meeting-minutes/`](meeting-minutes/README.md) | Stores meetings and answers, transcribes complete recordings, and runs configured summaries and answers | `ctx.meetingMinutes` |
| [`tool-meeting-minutes/`](tool-meeting-minutes/README.md) | Model-facing create, list, read, summarize, and ask tools over meeting records | contributes meeting tools |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
