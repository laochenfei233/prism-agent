---
description: "Speech recognition settings: manage transcription services, keys, and the default recognizer."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-settings-speech

English | [中文](README.zh.md)

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Summary

This optional browser plugin adds the 语音识别 page to the Models settings section's tab strip, beside the provider list and the local-models page. It renders one card per configured transcription service of the [speech HTTP provider](../../speech/speech-to-text-http/README.md), editing each card's display name, endpoint, model, and credential reference, and manages each service's API key through the credential store with a configured or missing badge. An add-service action appends a draft card; a delete action removes a card. Above the cards, a selector switches the default recognizer over the live roster that the [speech registry](../../experimental/speech-to-text/README.md) serves, persisting the choice through the speech remote.

## Use this package

Enable the [voice input bundle](../voice-input-bundle/README.md) from Plugins; the bundle composes this section alongside the recognizers it manages. The page registers as the `speech` tab of `settings.models.tab`; when the deployment serves no speech HTTP namespace the tab states that instead of showing service cards. Keys written on a card go to the credential store under the reference the service names (`DEEPSEEK_API_KEY` for the built-in DeepSeek ASR, `DASHSCOPE_API_KEY` for the built-in DashScope qwen3-asr); they never enter configuration files. Requests to switch the default recognizer follow the same validation as the meeting page selector, so a language hint the recognizer does not declare refuses the write.

## Understand the implementation

The section is a slot-injected settings page following the data section's composition pattern: it registers into `settings.section` with id `speech` and order 11 while the Host serves the `speech-to-text-http` namespace, through the settings domain's while-served watch. Card edits write the service list as one settings mutation; credential state comes from a batched credentials describe refreshed on pushed invalidations (settings documents, credential records and references, connection resets). The roster and the default-selection write ride the optional speech remote, read through the service store so a deployment without the voice bundle keeps the cards usable.

## Model Experience

None; the section edits configuration and credentials only.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- Cards edit the common fields only; per-form extras such as Tencent's engine model, iFlytek's polling interval, or AWS's region and bucket still ride configuration files.
- Deleting a service asks for confirmation through the browser dialog; a removed key stays in the credential store until removed explicitly.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
