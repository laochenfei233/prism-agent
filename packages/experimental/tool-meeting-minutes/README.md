---
description: "The model-facing meeting_minutes tool: transcribes one recording through the experimental speech seam, stores the transcript beside it, and returns the minutes structure for the agent to fill."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-meeting-minutes

English | [中文](README.zh.md)

## Summary

`meeting_minutes` turns one meeting recording into two things the agent can work with: the transcript, stored as a file next to the recording, and the structure of a meeting-minutes document. The tool deliberately stops there. Writing the minutes is the agent's own work, done with its ordinary file tools, so the minutes follow the conversation's language, detail, and emphasis instead of a second fixed model call.

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

Load through the [meeting-minutes bundle](../meeting-minutes-bundle/README.md), or list this package beside the [speech seam](../speech-to-text/README.md) and a filesystem provider. The tool needs `ctx.tools`, `ctx.fs`, and `ctx.speechToText`, so a composition without all three leaves it pending.

The model calls it with a recording path and asks for one of four structures:

| Parameter | Meaning |
|---|---|
| `audio_path` | The recording, relative to the session workspace or absolute. Must be 16 kHz mono PCM16 WAV. |
| `title` | Meeting title; defaults to the recording's file name. |
| `participants` | Names the caller was told. The recognizer does not identify speakers. |
| `template` | `default`, `detailed`, `action-focused`, or `decision`. Defaults to `default`. |
| `language` | Language hint for the recognizer; omitted means the composition's default. |

`maxAudioBytes` bounds the recording this tool reads into memory, and `maxPreviewCharacters` bounds the transcript the result carries. The transcript file always holds the complete text, so a long meeting costs a call to `read`, not a truncated result.

The four structures are product content ported from the meeting application this feature came from: a basic outline, a detailed per-topic record, an action-item table, and a decision record.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`execute` resolves the recording through `ctx.fs`, requires a regular file, reads it under `maxAudioBytes`, and hands the bytes to `ctx.speechToText.resolve` and `transcribe`. The transcript document is written to the recording's path with its final extension replaced by `.transcript.md`, through the ordinary write path: `ctx.fs.resolve`, the `fs/write-intent` waterfall, `ctx.fs.writeText`, then `fs/observed`. The canonical result carries the preview, the character count, the measured durations, the chosen structure, and both derived paths.

The transcript document's header records the title, the instant of transcription, the duration, the named participants, and the source recording. Formatting and previewing are pure functions in `transcript.ts`.

The tool does not write the minutes, so the minutes path it returns is a suggestion the agent may ignore: the returned value names `<recording>.minutes.md` beside the transcript, and the model-facing render tells the agent to write there. Nothing enforces that choice, and nothing needs to — the agent owns the file it produces.

The write runs under the filesystem backend's own default fence: the tool does not resolve a per-call sandbox policy and does not advertise the escalation fields the `write` and `edit` tools carry, because a derived artifact beside its source is not a mutation the user chose a policy for. A denied write fails the call with the backend's own error.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`meeting_minutes` schema](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-meeting-minutes): one required `audio_path` string plus optional `title`, `participants`, `template`, and `language`. `template` is a closed enumerable set (`default`, `detailed`, `action-focused`, `decision`). The description states the accepted audio format, that the tool writes the transcript, and that the minutes are the agent's own work.

#### Token effect

Fixed schema cost on every request where the tool is visible; the schema is stable for a given configuration and does not vary with the recording.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call retains its arguments in the assistant tool call until compaction. The result carries the recording path, the transcript path, the suggested minutes path, the transcript's character count, the measured audio and inference durations, the chosen structure, and the transcript preview — followed by that structure's Markdown so the agent can fill it in. When the transcript exceeds `maxPreviewCharacters`, the render says so and names the transcript file to read instead.

#### Token effect

Conditional and caller-controlled: the result grows with `maxPreviewCharacters`, and the structure adds a fixed few hundred tokens. A short meeting returns its whole transcript; a long one returns only the preview plus one instruction sentence.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **WAV input only** — the seam's canonical recording contract is 16 kHz mono PCM16 WAV, and this tool does not decode other formats. A caller with a compressed recording converts it first; the tool's description states the requirement.
- **The minutes are not written, validated, or templated for the caller** — the file the agent produces is only as good as its own writing, and no component checks that the returned structure survived.
- **No speaker attribution** — the seam's `Transcript` carries text only, so the transcript cannot label who said what even though the bundled recognizer asks the service to diarize.
- **The structures are Chinese product content** — the four shipped outlines match the meeting application this feature came from. A deployment meeting in another language replaces them in a fork; configuration does not yet offer a template override.
- **No sandbox escalation** — a write the filesystem backend denies fails the call without the one-shot escalation the `write` and `edit` tools offer. Raise the write mode or write the transcript with those tools instead.
- **The suggested minutes path is not enforced** — the agent may write anywhere, so the returned path is advice rather than a contract.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
