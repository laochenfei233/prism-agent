---
description: "Config-driven third-party HTTP transcription providers for ctx.speechToText."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-http

English | [中文](README.zh.md)

## Table of Contents

- [Summary](#summary)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Summary

This plugin registers one `ctx.speechToText` recognizer per configured service, so a third-party ASR service joins voice input and the meetings page by configuration alone. Each recognizer uploads one complete canonical WAV as OpenAI-shaped `multipart/form-data` to the configured endpoint, sends the bearer key resolved from the literal configuration, the credentials plane, or the launch environment, and reads the recognized text from one top-level JSON response field. The provider owns no preparation, so the registry reports it ready on arrival. No runtime invariant companion is published because the provider owns no projection beyond the one HTTP request-and-answer per recognition.

## Configuration

The plugin takes a `services` list; every entry registers one recognizer and duplicate ids fail at load. Each entry names its `providerId`, optional display `name`, `endpoint`, `model`, and accepted `languages`; `apiKeyEnv` names a credential reference and a literal `apiKey` is supported for controlled deployments but should not be written into ordinary configuration files. `textField` names the JSON response field (default `text`), and `maxAudioBytes`, `maxDurationSeconds`, and `timeoutMs` bound each recognition.

```yaml
plugins:
  - name: '@deepseek-ai/dsh-experimental-speech-to-text-http'
    config:
      services:
        - providerId: groq-whisper
          endpoint: https://api.groq.com/openai/v1/audio/transcriptions
          apiKeyEnv: GROQ_API_KEY
          model: whisper-large-v3
          languages: [auto, zh, en]
```

## Model Experience

None, as recognition results stay outside model requests until a consumer explicitly persists or submits text.

#### KV Cache effect

No direct effect; consumers that place recognized text into model requests own any prefix effect.

## Known Limitations and Deferred Work

- Only the OpenAI `/audio/transcriptions` request shape and one top-level JSON text field are supported; other request presets and nested response paths are out of scope.
- Only complete-recognition transcription is supported; streaming third-party protocols are out of scope.
- Without a resolvable key, registration succeeds but recognition fails at request time.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
