---
description: "Model-facing meeting create, list, read, summarize, and ask tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-meeting-minutes

English | [中文](README.zh.md)

## Summary

This consumer registers five explicit tools over `ctx.meetingMinutes`: `meeting_minutes_create`, `meeting_minutes_list`, `meeting_minutes_get`, `meeting_minutes_summarize`, and `meeting_minutes_ask`. Registration and disposal are one effect; every call receives the tool execution cancellation signal. No runtime invariant companion is published because each tool call is a direct projection of one meeting service operation.

## Table of Contents

- [Summary](#summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees five stable JSON-Schema tool definitions in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-meeting-minutes). Create requires a title and complete transcript; list takes no input; get, summarize, and ask require the meeting id, and ask also requires the question. Success results are compact JSON projections labeled `Created meeting`, `Meeting list`, `Meeting`, `Summarized meeting`, or `Meeting answer`; failures preserve the meeting service's validation, not-found, model, storage, and cancellation errors.

#### Token effect

The five fixed schemas are present on every request where the plugin is visible. Transcript text appears only in create arguments and `meeting_minutes_get` results; `meeting_minutes_list` returns transcript length instead of content.

#### KV Cache effect

Tool definitions are prefix-stable while plugin visibility is unchanged. Long get results and create arguments follow normal append-only history growth.


## Known Limitations and Deferred Work

- The tool surface has no delete, answer listing, update, or audio ingestion operation.
- A model cannot select the speech provider; text import is the only creation path.
- Long transcripts in get results can dominate a tool-result budget.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
