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

This plugin registers one `ctx.speechToText` recognizer per configured service, so a third-party ASR service joins voice input and the meetings page by configuration alone. Each recognizer uploads one canonical WAV to the configured endpoint in its configured request form and reads the text from the JSON answer; the registry splits recordings beyond a form's duration cap at quiet boundaries and merges the pieces. The provider owns no preparation, so the registry reports it ready on arrival. The speech settings section edits this plugin's service list and keys; the voice-input bundle ships DeepSeek ASR and DashScope qwen3-asr built-ins.

## Configuration

The plugin takes a `services` list; every entry registers one recognizer and duplicate ids fail at load. Each entry names its `providerId`, optional display `name`, `endpoint`, and accepted `languages`; `mode` selects the request form. `apiKeyEnv` names a credential reference and a literal `apiKey` is supported for controlled deployments but should not be written into ordinary configuration files; `authHeader` and `authStyle` (`bearer`, default, `token`, or `raw`) place the credential in the header the service expects. `textField` names the response field of the answer as a dot path through objects and array indices (default `text`), and `maxAudioBytes`, `maxDurationSeconds`, and `timeoutMs` bound each recognition; a missing `model` sends no model field.

Request forms:

- `transcriptions` (default) — the OpenAI `multipart/form-data` shape with an optional `model` and `language` field; covers OpenAI-compatible services (Groq, Mistral, DashScope compatible-mode).
- `chat-completions` — the audio-bearing chat request whose language hint rides `asr_options.language` (the MiMo-V2.5-ASR knob).
- `raw-body` — the WAV as the whole request body with `audio/wav`; fixed model or language parameters live in the endpoint URL (Deepgram `/v1/listen` with `authStyle: token`).
- `tencent-sentence` — Tencent Cloud `SentenceRecognition` with TC3-HMAC-SHA256 signing; configures `engineModel` (default `16k_zh`) and the `secretId` or `secretIdEnv` identity, with `apiKeyEnv` holding the SecretKey; 60-second cap.
- `xfyun-filetrans` — iFlytek long-form transcription running prepare, ordered 10 MiB slice upload, merge, progress polling (`pollIntervalMs`, default 5 s), and result read; configures the `appId` or `appIdEnv` identity, with `apiKeyEnv` holding the SecretKey.
- `volcano-flash` — Doubao recording-file recognition, flash edition: base64 audio to one sync endpoint with the console key; 2-hour cap.
- `google-speech` — Google Cloud Speech-to-Text v1 `speech:recognize` envelope with the API key in the endpoint URL; `model` names the recognition model; 60-second cap.
- `azure-fasttranscribe` — Azure AI Speech fast transcription with the subscription key header and the language hint as `definition.locales`.
- `aws-transcribe` — Amazon Transcribe batch: SigV4-signed S3 upload to `awsBucket` in `awsRegion`, job start and poll, and transcript read; `secretId` or `secretIdEnv` holds the access key id and `apiKeyEnv` the secret access key; requires a bucket the credentials can write.

Keys resolve per request from the literal configuration, the credentials plane, or the launch environment; a service whose key resolves to nothing registers and fails at recognition time with that instruction.

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
          # The service caps one request at 30 minutes; the registry splits
          # longer imports at quiet boundaries automatically.
          maxDurationSeconds: 1800
        - providerId: tencent-sentence
          endpoint: https://asr.tencentcloudapi.com/
          apiKeyEnv: TENCENT_SECRET_KEY
          secretIdEnv: TENCENT_SECRET_ID
          mode: tencent-sentence
          languages: [auto]
```

## Model Experience

None, as recognition results stay outside model requests until a consumer explicitly persists or submits text.

#### KV Cache effect

No direct effect; consumers that place recognized text into model requests own any prefix effect.

## Known Limitations and Deferred Work

- The chat-completions form reads only `choices[0].message.content`; other chat answer layouts are out of scope.
- The `raw-body` form does not transmit the language hint; fixed model and language parameters live in the endpoint URL.
- Only complete-recognition transcription is supported; streaming third-party protocols are out of scope.
- Without a resolvable key, registration succeeds but recognition fails at request time.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
