---
description: "The OpenAI-compatible HTTP recognizer for the experimental speech seam: one multipart transcription request per recording, bounded by duration and upload size."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-openai

English | [中文](README.zh.md)

## Summary

This provider sends one already-recorded WAV file to any endpoint serving the OpenAI audio transcription protocol and returns the recognized text. It registers as a named `cloud` recognizer on the experimental speech seam, so consumers reach it through ordinary provider selection. The recording travels as the single file part of one multipart request.

The same endpoint streams a transcript as it is produced. This provider publishes the seam's `streaming` capability with mode `incremental-output`: the caller submits one complete recording and reads the text progressively. It is not duplex, because the endpoint accepts one upload rather than live audio.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

List this package beside the [speech seam](../speech-to-text/README.md) in any composition the seam serves. The recognizer registers under `providerId` (default `openai-transcription`), and the seam's `defaultProvider` must name it when callers omit their own choice. `name` is the display label speech surfaces show.

`model` is required: compatible endpoints serve different transcription models, so this package selects none. `models` lists the models this deployment offers for selection, and `model` must be one of them when the list is non-empty; a saved selection overrides it, and clearing that selection falls back to it. `baseUrl` defaults to `https://api.openai.com/v1`, the public OpenAI root, and the transcription path is appended to it; a deployment serving another compatible endpoint overrides it. `languages` advertises the hints this deployment accepts and defaults to `['auto']`, which asks the endpoint to detect the language itself and omits the request's `language` field.

`apiKey` pins a literal token. Prefer `apiKeyEnv`, whose default `OPENAI_API_KEY` is resolved through the `credentials` service, falling back to the launch environment when no credential plane is mounted. A call without a usable key fails before the request is sent.

`maxDurationSeconds` and `maxUploadBytes` bound one recording; both are checked before the token is read, and the tighter bound rejects the recording first. `timeoutMs` bounds one request end to end.

`ctx.speechToText.resolveStream()` and `openStream()` reach the streaming session this provider publishes. The caller pushes PCM16 samples without a container header — they are held until `close()`, which submits the whole recording once — and reads partials, closed segments, and one final transcript from `events()`. Diarized spans arrive only from an endpoint whose model and format produce them; the request asks for `json`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`transcribe()` validates the recording against the seam's canonical WAV contract, rejects an upload over `maxUploadBytes`, resolves the token, and sends one `POST` to `<baseUrl>/audio/transcriptions` with an `Authorization: Bearer <token>` header. The body is `multipart/form-data` carrying the recording as `file` (`recording.wav`, `audio/wav`), the configured `model`, `response_format: json`, and `language` unless the resolved hint is `auto`. A success response must be JSON carrying a string `text`; any other body fails the call instead of returning an empty transcript.

A failure status raises an error naming the status and a single-line excerpt of the response body, bounded to 500 characters. Cancellation aborts the request through the deadline signal, which fuses the caller's signal with `timeoutMs`: a fired deadline raises `OpenAiTimeoutError` carrying the elapsed duration, while caller cancellation rejects with the caller's own reason.

No runtime invariant companion is published because the provider owns no relation an independent observer could contradict: the request is execution-local, and the seam's registry is the sole source of registration facts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the recognizer returns transient text to its caller without adding model requests or Session events.

#### KV Cache effect

No direct effect; the consumer that renders the transcript into a request owns every model-visible byte.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only complete recordings are accepted. The endpoint answers after the upload ends, so a live microphone stream is not a supported input on either path; `streaming` here reports a transcript progressively, not a duplex session.
- Streaming needs a model that supports it. The endpoint ignores `stream` for `whisper-1`, which answers with a single JSON body that this session cannot read as events.
- The response is requested as JSON text only. Timestamped segments, speaker labels, and word-level detail that other `response_format` values carry stay outside the seam's `Transcript`, which holds text and measured durations.
- The provider has no retry policy. A dropped connection or a transient service failure fails the call, and the caller decides whether to try again.
- `maxUploadBytes` defaults to the 25 MiB ceiling OpenAI documents. An endpoint with a different limit needs that field set, because no other value can be inferred from `baseUrl`.
- Audio leaves the host. A deployment that must keep recordings local replaces this provider with a host-local one; the seam's provider selection is the only place that decides.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
