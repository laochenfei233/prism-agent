---
feature: prism-search
status: designed
updated: 2026-11-01
branch: feat/prism-search
commits: dd1145a3c5..
---

# Prism Search

## Report

## [S1] Problem

The shipped `web_search` tool reaches the web through one provider: DeepSeek's server-side search (or the
Exa/Perplexity API providers), each requiring a paid credential and a fixed ranking. Users who want a
free, local, multi-engine recall path — the SearXNG-PLUS shape: query many engines, fuse their rankings,
read the actual page text, then order by relevance — have no local option, and any model such a path needs
must not be a second, plugin-private model list.

## [S2] Design

### S2.1 Surface: one new `ctx.web` search provider

`plugins/prism-search` is an out-of-tree Prism plugin (Host half + browser half) that registers a
`ctx.web` search provider with the stable id `prism-search`. It adds no tool, no result card, and no
prompt section: the existing `web_search` tool, its rendering, its truncation, and its timeout policy are
reused unchanged. Activation is the existing `web.searchProvider` setting, exposed in this plugin's own
settings section as a switch (see S2.6).

### S2.2 Recall: 18 free engines

Each engine is a declarative spec (`build(query)` + `parse(body, finalUrl)`) with no key and no account:
Google, Bing, DuckDuckGo, Brave, Startpage, Yahoo, Yandex, Mojeek, Marginalia, Qwant, Baidu, Sogou,
360 Search, Bilibili, Wikipedia, GitHub, Hacker News, Stack Exchange. HTML engines share one anchor
harvester (title, snippet from the text following the link, engine-host and asset filtering, redirect
unwrapping for DuckDuckGo/Google/Bing/Yahoo); API engines parse their JSON directly. Queries containing
CJK select Chinese locale parameters and `zh.wikipedia.org`; other queries use English.

Every request carries a browser user agent, a per-engine timeout, and the caller's cancellation signal.
One engine failing (blocked, captcha, markup change, timeout) contributes nothing; the search only fails
when every engine produced zero results.

### S2.3 Fusion: reciprocal rank fusion

Per-engine ranked lists merge by RRF (`1/(60 + rank)`), deduplicated on a normalized URL (lower-case host,
fragment and tracking parameters removed, trailing slash removed). A duplicate keeps its first non-empty
title and the longest available snippet, and records every engine that returned it.

### S2.4 Content: fetch the top pages

The top `fetchTopN` fused results (default 8) are fetched concurrently (bounded to 4 at a time, own
timeout, byte-capped body), and the readable text of the page (scripts/styles/comments removed, whitespace
collapsed, capped) replaces or extends the engine snippet. A fetch failure, non-HTML response, or redirect
to a non-HTTP URL keeps the engine snippet; the final URL after redirects replaces the engine redirect URL
(Baidu/Sogou/360 link wrappers resolve this way).

### S2.5 Ordering: one model from model management

When both `rerankProvider` and `rerankModel` are configured, the top `maxRerankCandidates` results (default
12) go to that model through `ctx.llm.stream()` as one auxiliary call: a fixed prompt asks for
`{"order":[...]}` (1-based indices, every index once, most relevant first) and the plugin reorders on that
answer. The model is selected in Settings → Models' own catalog through this plugin's settings section
(S2.6); no model name, endpoint, or key is hardcoded. Any failure — missing model, provider rejection,
timeout, cancelled caller, unparseable output, partial order — keeps the RRF order for that search and
never fails the search itself.

The rerank request is an auxiliary model call outside the Session: this out-of-tree plugin cannot write
Session events (the profile's persistence refuses unknown event types unless they are `plugin:` records,
whose writer is an in-repo function). Its prompt is a pure function of the logged `web_search` arguments,
the logged result sources, and this package's fixed template, so the call stays reconstructable from the
Session log. Recorded as a known limitation in the README.

### S2.6 Settings: one section, two writes

The browser half registers a `settings.section` entry (`prism-search`) that reads
`ctx.remote.settings.describe()` and `ctx.remote.session.modelCatalog()` and renders: the provider switch
(`web.searchProvider` = `prism-search`, or restored to the composed default), a rerank-model picker grouped
by provider, and a save action. Saving writes the plugin's own namespace (`prism-search.rerankProvider`,
`prism-search.rerankModel`) and, when changed, the `web` namespace's `searchProvider`, each with the
revision that was read. The plugin's config fields are volatile, so a saved model applies to the next
search without a restart. All copy is locale-owned (zh/en).

### S2.7 Configuration

`prism-search` row config, every field volatile: `rerankProvider` (`''` = off), `rerankModel`,
`fetchTopN` (8, `0` disables page fetching), `engineTimeoutMs` (8000), `fetchTimeoutMs` (8000),
`rerankTimeoutMs` (20000), `maxSnippetChars` (1200), `maxRerankCandidates` (12). Defaults ship; the
settings section only edits the two model fields.

### S2.8 Failure behaviour

- All engines empty → an error naming the engine count and how to change the search source.
- One engine fails → skipped silently; the search result carries what the others returned.
- Model missing/unusable → RRF order; no user-visible error.
- Provider unavailable (never: `available()` is a constant `true`) — the provider is keyless.

## [S3] Scope

- In scope: the plugin package (host provider, 18 engines, RRF, page fetch, model rerank), its browser
  settings section, unit tests for parsers/fusion/rerank/pipeline, README, install notes.
- Out of scope: an own tool or result card; answer synthesis (`content`); cached results; per-engine user
  toggles; SearXNG-compatible HTTP API; rewriting another package's code.
- Out of scope: installing into the running profile (offered as a separate step at hand-off).

## Tasks

- [ ] T1: scaffold the package (manifest, tsconfig, tsdown, vitest, patch, README) (depends: none)
- [ ] T2: HTML/text helpers and capped HTTP transport (depends: T1)
- [ ] T3: 18 engine specs and their parsers (depends: T2)
- [ ] T4: RRF fusion and URL normalization (depends: T1)
- [ ] T5: model rerank with JSON-order parsing and fallback (depends: T1)
- [ ] T6: provider pipeline (fan-out, fusion, page fetch, rerank, bounds) (depends: T2, T3, T4, T5)
- [ ] T7: host entry, config schema, provider registration (depends: T6)
- [ ] T8: browser settings section, bridge, locales (depends: T7)
- [ ] T9: unit tests for helpers, parsers, fusion, rerank, pipeline (depends: T2-T8)
- [ ] T10: verify (typecheck, tests, build) and document (depends: T9)

## [S4] Acceptance

- [ ] AC1: The built host half registers a `ctx.web` search provider whose id is `prism-search` and whose
      `available()` is `true` without any credential.
- [ ] AC2: The provider exposes 18 keyless engines by default; a search query fans out to all of them
      and a failing engine cannot fail the search while another returns results.
- [ ] AC3: Results from several engines merge by RRF, deduplicate on normalized URL, and record every
      contributing engine.
- [ ] AC4: The top `fetchTopN` results are fetched; readable page text replaces the snippet when available,
      and the final URL from a redirect replaces the engine URL.
- [ ] AC5: When `rerankProvider`/`rerankModel` are set, the provider makes exactly one model call through
      `ctx.llm.stream()` and reorders by its JSON order; any model failure keeps the RRF order and still
      returns sources.
- [ ] AC6: `request.maxResults` is honored by the provider, and `truncated` is `true` only when it cut
      results.
- [ ] AC7: The settings section lists models from the model catalog, saves the chosen provider/model with
      the read revision, and can set `web.searchProvider` to `prism-search`.
- [ ] AC8: Typecheck, unit tests, and the tsdown build pass.
