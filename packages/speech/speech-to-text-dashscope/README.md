---
description: "DashScope complete-recognition speech provider for ctx.speechToText."
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-to-text-dashscope

English | [中文](README.zh.md)

## Table of Contents

- [Summary](#summary)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Summary

This provider registers a DashScope realtime recognizer on `ctx.speechToText`. It converts one complete WAV recording into plain closed sentences over a duplex WebSocket session, resolves `DASHSCOPE_API_KEY` or the configured credential reference per request, and owns its connection timeout and result-drain deadline. No runtime invariant companion is published because the provider exposes no independently maintained projection beyond these WebSocket lifecycle observations.

## Configuration

Composition selects the provider id, accepted language hints, endpoint, model, speaker-diarization flag, maximum recording duration, and both timeouts. `apiKeyEnv` names a credential reference; a literal `apiKey` is supported for controlled deployments but should not be written into ordinary configuration files.

## Model Experience

None, as recognition results stay outside model requests until a consumer explicitly persists or submits text.

#### KV Cache effect

No direct effect; consumers that place recognized text into model requests own any prefix effect.

## Known Limitations and Deferred Work

- Only complete-recording recognition is supported; streaming microphone sessions are out of scope.
- Speaker labels are provider-dependent and are not normalized into durable speaker identities.
- Without a resolved DashScope key, provider registration succeeds but recognition fails at request time.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
