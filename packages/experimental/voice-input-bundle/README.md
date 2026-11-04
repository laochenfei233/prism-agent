---
description: "Enable experimental speech input from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-voice-input-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes a speech Service Definition, a local SenseVoice recognizer, an online DashScope recognizer, authenticated Remote and browser microphone control. Shipped profiles leave it disabled. Recognition runs on this machine by default; selecting the online recognizer streams audio to that service instead and needs no model download.

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

Open Plugins in the Web sidebar and enable Voice Input, marked by a blue waveform icon. If models need preparation, a dialog offers Go to setup or Later; Go to setup opens the bundle details. Complete caches need no setup prompt. In the details, choose Download and prepare; the collapsed current-step summary expands to the complete step list. Downloads report actual bytes; verification and loading show elapsed time. Once ready, click the microphone between the model selector and Send, then Stop to insert a transcript. Bundle details store the recognizer and language through the Settings service. Disabling the bundle cancels active work; cached assets remain on disk.

### Recognizers

Bundle details list every composed recognizer and the processing location it uses.

- **SenseVoiceSmall** runs on this machine. It downloads its native runtime and models on first use, supports automatic language detection, and sends no audio anywhere.
- **DashScope fun-asr-realtime** runs online. It streams one recording over a duplex WebSocket to `wss://dashscope.aliyuncs.com/api-ws/v1/inference`, downloads nothing, and reports ready immediately. Selecting it sends the recording to that service, so it needs a key: set `DASHSCOPE_API_KEY` in the profile credentials or in the Harness home `.env`, or set that row's `apiKey` for a controlled deployment. Without a key the recognizer still registers and fails at request time with that instruction.

Both recognizers accept `zh`, the composed default language. SenseVoice additionally supports `en`, `yue`, `ja`, `ko`, and its own `auto` detection; the online recognizer accepts no `auto` hint. A language the selected recognizer does not declare fails the preference write instead of being silently ignored.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` adds the five voice rows, selects `sensevoice-local` as the default recognizer, supplies the SenseVoice cache directory with `dshHomePath`, and mounts the online recognizer beside it. The speech row declares `language: zh` because a patch replaces the target's whole config: without it, enabling this bundle over a base layer would drop that layer's language and leave the cloud recognizer unselectable. Optional-bundle installation makes the package available to management without selecting it in default profiles. The browser contribution owns its generated Remote mount; stable API Remotes do not import experimental code. No runtime invariant companion is published because this configuration-only package has no independently mutable runtime state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as recordings and preparation remain outside model requests; ordinary user submission owns any later text.

#### KV Cache effect

No direct effect; ordinary submission owns the message content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle composes two recognizers and no others. A deployment that needs a third registers it with the same service under its own id and adds the row; the bundle does not add a model tool or change the agent loop.
- The online recognizer sends the recording to DashScope and fails at request time without a resolved key; the bundle does not verify the key when it registers the recognizer.
- Installing dsh also installs `sherpa-onnx-node` and its platform-specific native runtime, including ONNX Runtime, even when this bundle is disabled. Runtime installation adds disk and download costs separate from the models downloaded by Download and prepare; the native package size varies by platform and version.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
