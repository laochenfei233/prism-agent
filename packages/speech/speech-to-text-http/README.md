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

This plugin registers one `ctx.speechToText` recognizer per configured service, so a third-party ASR service joins voice input and the meetings page by configuration alone. Each recognizer uploads one complete canonical WAV to the configured endpoint in its configured request form — the OpenAI `multipart/form-data` transcription shape, or an audio-bearing chat-completions request — sends the bearer key resolved from the literal configuration, the credentials plane, or the launch environment, and reads the recognized text from the JSON answer: the mapped top-level field, or the chat answer's message content. The provider owns no preparation, so the registry reports it ready on arrival. No runtime invariant companion is published because the provider owns no projection beyond the one HTTP request-and-answer per recognition.

## Configuration

The plugin takes a `services` list; every entry registers one recognizer and duplicate ids fail at load. Each entry names its `providerId`, optional display `name`, `endpoint`, `model`, and accepted `languages`; `mode` selects the request form (`transcriptions`, the default, or `chat-completions`); `apiKeyEnv` names a credential reference and a literal `apiKey` is supported for controlled deployments but should not be written into ordinary configuration files. `textField` names the JSON response field of a transcription answer (default `text`), and `maxAudioBytes`, `maxDurationSeconds`, and `timeoutMs` bound each recognition.

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
        - providerId: xiaomi-mimo-asr
          name: MiMo ASR
          endpoint: https://api.xiaomimimo.com/v1/chat/completions
          apiKeyEnv: MIMO_API_KEY
          model: mimo-v2.5-asr
          mode: chat-completions
          languages: [auto, zh, en]
```

## Model Experience

None, as recognition results stay outside model requests until a consumer explicitly persists or submits text.

#### KV Cache effect

No direct effect; consumers that place recognized text into model requests own any prefix effect.

## Known Limitations and Deferred Work

- The chat-completions form reads only `choices[0].message.content` and carries the language hint in `asr_options.language` (the MiMo-V2.5-ASR knob); other chat answer layouts are out of scope.
- Only complete-recognition transcription is supported; streaming third-party protocols are out of scope.
- Without a resolvable key, registration succeeds but recognition fails at request time.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
