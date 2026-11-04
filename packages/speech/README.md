---
description: "Speech recognition providers: service routing, cloud transcription, and model-facing meeting consumption."
kind: "package-group"
---

# speech/ — Speech capability family

English | [中文](README.zh.md)

## Summary

The speech group defines the named transcription-provider seam, maintains the DashScope cloud provider, and ships the config-driven HTTP provider for third-party transcription services. The service resolves an explicit recognizer before execution; meeting-minutes consumes it to transcribe complete recordings. Type vocabulary and the generated Cordis API are on the [Voice input subsystem page](../../docs/subsystems/voice-input.md).

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`speech-to-text/`](speech-to-text/README.md) | Routes named providers, owns cancellation and volatile defaults, and validates WAV input | `ctx.speechToText` |
| [`speech-to-text-dashscope/`](speech-to-text-dashscope/README.md) | Registers the DashScope realtime recognizer for complete WAV recordings | contributes `dashscope-funasr` |
| [`speech-to-text-http/`](speech-to-text-http/README.md) | Registers config-driven third-party HTTP recognizers speaking the OpenAI transcription shape | contributes configured provider ids |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The local SenseVoice provider remains in the experimental group because its model download and native runtime are still pre-stable.

</details>
