---
description: "The DashScope realtime recognizer for the experimental speech seam: one duplex WebSocket session per recording, bounded PCM16 upload, and closed-sentence assembly."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-dashscope

English | [中文](README.zh.md)

## Summary

This provider sends one already-recorded WAV file to DashScope's realtime recognition service and returns the recognized text. It registers as a named `cloud` recognizer on the experimental speech seam, so every consumer of that seam reaches it through the ordinary provider selection. The recording is uploaded as PCM16 over one duplex WebSocket session, and the text the service commits is assembled sentence by sentence.

The same endpoint also serves live recognition: this provider publishes the seam's `streaming` capability with mode `duplex`, so a consumer pushes audio while the service returns partials and speaker-attributed segments.

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

Load through the [meeting-minutes bundle](../meeting-minutes-bundle/README.md), or list this package beside the [speech seam](../speech-to-text/README.md) in any composition the seam serves. The recognizer registers under `providerId` (default `dashscope-funasr`), and the seam's `defaultProvider` must name it when callers omit their own choice.

`apiKey` pins a literal key. Prefer `apiKeyEnv`, whose default `DASHSCOPE_API_KEY` is resolved through the `credentials` service, falling back to the launch environment when no credential plane is mounted. A call without a usable key fails before the connection opens.

`url` and `model` select the endpoint and the realtime model (defaults `wss://dashscope.aliyuncs.com/api-ws/v1/inference` and `fun-asr-realtime`). `models` lists the models this deployment offers for selection, and `model` must be one of them when the list is non-empty; a saved selection overrides it, and clearing that selection falls back to it. `languages` advertises the hints this deployment accepts; the resolved hint is sent as the task's `language_hints` parameter unless it is `auto`. `speakerDiarization` asks the model to label speakers in its sentences. `maxDurationSeconds` bounds the accepted recording. `timeoutMs` bounds the whole session and `drainTimeoutMs` bounds the wait for the results the service sends after the upload ends.

`ctx.speechToText.resolveStream()` and `openStream()` reach the live session this provider publishes. A caller pushes PCM16 samples without a container header and reads partials, closed segments, and one final transcript; `speakerDiarization` decides whether those updates carry speaker labels.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

One session opens a WebSocket to `<url>?authorization=Bearer%20<key>` — the query parameter carries the token because a WebSocket client without header support cannot send an authorization header — then sends `run-task`, waits for `task-started`, uploads the recording's PCM samples after the 44-byte WAV header, sends `finish-task`, and reads results until `task-finished`.

The client holds at most eight seconds of unsent PCM; `upload` waits for `socket.bufferedAmount` to fall before sending the next one-second frame. Results arrive as `result-generated` events whose text accumulates for an unfinished sentence, so the session keeps the last text the service sent for each sentence and commits it when the sentence closes. Frames naming an unrecognized event are ignored, and a frame that is not a JSON object naming an event fails the session with `RecognitionProtocolError`.

Cancellation closes the socket, which fails the pending wait instead of leaving it to a timer; the deadline passes are fused with the caller's signal, so caller cancellation and both deadlines reach the same pending wait. Each deadline's internal `TimeoutReason` is translated before it leaves the provider: a fired session deadline raises `DashScopeTimeoutError` with `phase: 'recognition'`, and a fired drain deadline raises it with `phase: 'results'`.

The recording must satisfy the seam's canonical WAV contract, which `validateWave` checks before any connection opens; a recording that is not 16 kHz mono PCM16 WAV fails without reaching the service. The provider publishes no runtime invariant companion because it owns no relation that an independent observer could contradict: the session's own state is execution-local and the seam's registry is the sole source of registration facts.

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

- Only complete recordings reach `transcribe()`. The service's realtime framing is used to upload a finished file there; live audio goes through the `streaming` capability instead.
- Speaker labels reach a live session's updates and its final `segments`, but not a batch `Transcript`, whose contract still carries text only.
- The provider has no retry policy. A dropped connection or a transient service failure fails the call, and the caller decides whether to try again.
- The endpoint, model, and parameter set follow the verified protocol of the composition this package was ported from. Other DashScope realtime models may reject the parameters the session sends.
- Audio leaves the host. A deployment that must keep recordings local replaces this provider with a host-local one; the seam's provider selection is the only place that decides.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
