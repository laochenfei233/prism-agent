---
description: "Prism-owned meeting minutes: durable records, configured summaries, persisted answers, and model-facing tools."
kind: "package-group"
---

# prism/ — Prism-owned plugin family

English | [中文](README.zh.md)

## Summary

The prism group owns product packages that extend DeepSeek Harness without taking the upstream DSH package namespace. `@prism-ai/prism-meeting` persists durable meeting records outside Session logs, provides transcription ingestion, configured-model summaries, and persisted question/answer exchanges, exposes controlled operations as explicit model tools, and contributes the Meetings page to the [Web Client](../../docs/subsystems/web-client.md) through its `./web` and `./client` halves.

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-meeting/`](prism-meeting/README.md) | Stores meetings and answers, transcribes complete recordings, runs configured summaries and answers, registers model tools through `./tools`, and serves the Meetings page through `./web` and `./client` | `ctx.meetingMinutes`; contributes meeting tools and the `meeting-minutes` main panel |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism owns packages in this group. Their package scope is `@prism-ai`; they may depend on DSH capabilities but do not claim the DSH package namespace.

</details>
