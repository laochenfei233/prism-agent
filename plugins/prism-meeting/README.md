---
description: "The Prism meetings profile layer: durable meeting records, live microphone transcription, configured summaries, the model-facing meeting tools, and the Web meetings page, for users adding meeting capture to a dsh profile."
kind: "package-bundle"
---

# @prism-ai/prism-meeting

English | [中文](README.zh.md)

## Summary

This bundle adds meeting capture to a base-backed `dsh` profile: a durable meeting store, live microphone transcription, one configured model route for summaries and questions, the model-facing meeting tools, and the Web meetings page. No shipped profile includes it, so a profile gains it by installing this package and restarting. The profile needs the base LLM, storage-domain, speech-to-text, and tools services, and a speech provider key for recognition. A profile without the Web Connection leaves the page row pending instead of failing, and the package is an installable layer rather than a library.

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

### Install into a profile

Install the tarball into a base-backed DSH profile, then restart that profile:

```sh
dsh plugin --profile <profile> add /absolute/path/to/prism-ai-prism-meeting-0.1.0.tgz
dsh --profile <profile>
dsh plugin --profile <profile> remove @prism-ai/prism-meeting
```

The package declares `dsh.bundle.patch`, so `dsh plugin` reconciles it as a profile layer instead of mounting one plugin. The profile needs the base LLM, storage-domain, speech-to-text, and tools services. Set `DASHSCOPE_API_KEY` for audio recognition, or configure another speech provider for the profile.

### What you get

The patch inserts three rows, and each row's package owns its behavior.

- `prism-meeting` registers `ctx.meetingMinutes`: the `meeting_minutes` storage domain plus the deployment-configured model route for summaries and meeting questions.
- `tool-prism-meeting` registers the five model-facing operations `meeting_minutes_create`, `meeting_minutes_list`, `meeting_minutes_get`, `meeting_minutes_summarize`, and `meeting_minutes_ask`.
- `prism-meeting-web` registers the browser routes under `/api/prism-meeting` and the Meetings page in the sidebar panel rail.

A profile that lacks the Web Connection leaves `prism-meeting-web` pending rather than failing, so a headless profile carries the service and the tools without a page. Client modules are scanned at startup, so the page appears after the profile restarts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch document with a single `insert` list; the service, tool, and browser entries it names are ordinary plugins that this package also publishes.

### Composition mechanics

A patch entry replaces the targeted row's whole `config` rather than merging into it, and later bundle layers and the user's profile patch override rows by id, last write winning. The insert list reuses the `prism-meeting` and `tool-prism-meeting` ids, so a base-backed profile that already mounts those rows keeps one row each while an older profile gains them from this bundle. `prism-meeting-web` injects `connection`, which is what keeps that row pending in a profile without the Web Connection.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: the three inserted rows, with per-row rationale as inline comments |
| [`src/index.ts`](src/index.ts) | `ctx.meetingMinutes`: durable records, recording lifecycle, configured-model summaries and answers |
| [`src/spec.ts`](src/spec.ts) | The `meeting_minutes` storage domain declaration |
| [`src/types.ts`](src/types.ts) | Public request and record vocabulary |
| [`src/tools.ts`](src/tools.ts) | The model-facing tool row |
| [`src/web.ts`](src/web.ts) | The browser route row |
| [`src/client/`](src/client/) | The Meetings page and its sidebar entry |
| [`tests/`](tests/) | Service, route, tool, and page behavior |

### Invariant ownership

No runtime invariant companion is published: the service owns the only independent observation of mutation order and dependent-record deletion, and the browser and tool rows read through it rather than holding a second copy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Meetings subsystem](../../../docs/subsystems/meetings.md) — the record vocabulary, the recording lifecycle, the service semantics, and the browser interface.
- [Speech-to-text](../../speech/speech-to-text/README.md) — the recognition seam `ctx.meetingMinutes` resolves.
- [Generated tool catalog](../../../docs/tool-catalog.md#prism-aiprism-meeting) — the exact schemas the model sees.
- [Generated composition graph](../../../apps/cli/composition.md) — how a shipped profile resolves these rows.
- [Prism package group](../README.md) — the other Prism surfaces.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The `./tools` subpath registers `meeting_minutes_create`, `meeting_minutes_list`, `meeting_minutes_get`, `meeting_minutes_summarize`, and `meeting_minutes_ask` in the [generated tool catalog](../../../docs/tool-catalog.md#prism-aiprism-meeting). Create requires a title and complete transcript; list takes no input; get, summarize, and ask require the meeting id, and ask also requires the question. Success results are compact JSON projections; failures preserve validation, not-found, model, storage, and cancellation errors.

#### Token effect

The five fixed schemas are present on every request where the plugin is visible. Transcript text appears only in create arguments and `meeting_minutes_get` results; `meeting_minutes_list` returns transcript length instead of content.

#### KV Cache effect

Tool definitions are prefix-stable while plugin visibility is unchanged. Long get results and create arguments follow normal append-only history growth.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the layer, not a general comparison.

- **Records have one latest summary** — summary revisions and answer deletion are not exposed.
- **The tool surface has no delete, answer-listing, update, or audio-ingestion operation** — a model cannot select the speech provider, and text import is the only tool creation path.
- **Speaker labels exist only when the speech provider separates speakers** — a provider that reports none stores no spans, and a label means nothing outside its own recording.
- **Streaming recognition and export formats are out of scope.**
- **`audioSeconds` trusts the speech provider or caller** and is not independently decoded.
- **The page has no in-page question/answer surface** — a question is pushed into a new Session, where the agent answers it with `meeting_minutes_ask`.
- **Live transcription asks the speech provider once per eight seconds of new audio** — only the closing pass covers the complete recording.
- **A record left in the recording status by a page that closed mid-meeting** keeps only its last stored slice until an operator closes it.
- **The pushed Session belongs to the first Workspace in the catalog**, because no client service exposes the Workspace the Conversation is showing.
- **Page audio upload is buffered by Connection** and bounded by its configured request-body cap.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism owns this package; the service keeps the DSH `ctx.meetingMinutes` capability name. The bundle carrier is one package that also publishes the service, tool, and browser entries it inserts, so its README follows the bundle template while the Model Experience section stays structured: the tool row is this package's own contribution.

</details>
