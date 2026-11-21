---
description: "The opt-in bundle that composes the DashScope meeting transcriber and the meeting_minutes tool into one installable unit."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-meeting-minutes-bundle

English | [中文](README.zh.md)

## Summary

This bundle adds meeting minutes to a harness deployment in one switch: the experimental speech seam, a DashScope recognizer behind it, and the model-facing `meeting_minutes` tool. It ships switched off, because the recognizer uploads recordings to a cloud service and needs a key this bundle cannot supply.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-bundle"></a>
## Use this bundle

Enable it through the Plugin Manager, which lists it among the shipped optional bundles, or name it in a profile's bundle list. Set `DASHSCOPE_API_KEY` in the environment the harness launches with, or store it under that name with the `credentials` service; alternatively pin a literal key on the `speech-to-text-dashscope` row's `apiKey`.

The bundle's patch inserts three rows: the [speech registry](../speech-to-text/README.md) with `defaultProvider: dashscope-funasr`, the [DashScope recognizer](../speech-to-text-dashscope/README.md) under that id, and the [meeting-minutes tool](../tool-meeting-minutes/README.md). Replacing the recognizer means replacing its one row; the tool and its structure set stay as they are.

The bundle shares the speech registry with the voice-input bundle. Both configure the same `defaultProvider` for different recognizers, so a deployment enables one of them rather than both.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` is the whole composition; `src/index.ts` exports nothing, because the bundle contributes no code of its own. The patch is applied with the other bundle layers, so its rows behave like any other entry: the id is what a later profile patch targets to change the recognizer, disable the tool, or adjust either limit.

The bundle carries no icon and no client surface: it adds a capability to the agent, not a page to the UI. The transcript lands in the session workspace and is read with the agent's ordinary file tools.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-experimental-tool-meeting-minutes`](../tool-meeting-minutes/README.md), whose schema, description, and result the bundle composes into an agent.

#### KV Cache effect

No direct effect; the tool row owns every model-visible byte the bundle contributes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Cloud only** — the bundled recognizer uploads recordings to DashScope. A deployment that must keep audio on the host enables the voice-input bundle's local recognizer instead and supplies its own file-based consumer.
- **No key, no transcription** — the bundle ships switched off and the recognizer fails a call without a usable `DASHSCOPE_API_KEY`; nothing prompts for the key or validates it at load.
- **Mutually exclusive with voice input** — both bundles configure `speech-to-text`'s `defaultProvider`, so enabling both leaves one recognizer as the default for both features.
- **The tool row is not tied to a preset** — a deployment whose sessions run behind agent presets must add the tool to the preset's plugin list as well; the bundle's row alone registers it in the host registry.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
