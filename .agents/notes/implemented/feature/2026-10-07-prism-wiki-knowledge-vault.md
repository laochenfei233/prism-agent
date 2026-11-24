# Agent Note: A persistent knowledge vault of compiled markdown pages

Status: implemented

English | [中文](2026-10-07-prism-wiki-knowledge-vault.zh.md)

## Problem

Document work in this harness is retrieval-shaped. Raw files sit in a workspace, the model assembles an answer from fragments, and the assembled answer is discarded when the turn ends. Nothing accumulates, so a question that needs five sources synthesized is re-derived from scratch the next time it is asked.

`prism-memory` stores one claim per record. It answers "what do we know" and cannot answer "what does this body of sources say, and where do the sources disagree", because it has no page-level artifact and no cross-references between pages. Nothing in the composition provides a place for model-owned prose, a catalog of what has been written, or a way to read and edit the result inside the product.

## Decision

The knowledge is a compiled artifact rather than a per-question retrieval. A vault is three layers — immutable raw sources under `raw/`, model-owned markdown pages under `wiki/`, and a schema at `AGENTS.md` that the human and the model co-evolve — plus three operations: ingest a source, query the pages, and lint the whole vault. This is the llm-wiki pattern. Knowledge is compiled once and then kept current, so a synthesis that already exists is read rather than rebuilt.

**The plugin does only mechanical work and calls no model.** `@prism/prism-wiki` validates frontmatter, writes each page atomically, regenerates the catalog `index.md`, appends one `log.md` entry per mutation, and answers search and lint. Reading sources, synthesizing, and authoring pages belong to the model. This is what makes validation and derived-artifact maintenance enforceable rather than advisory: every page write goes through `wiki_write`, because the vault sits outside the session workspace and the model's own file tools cannot reach it.

**`index.md` and `log.md` are derived artifacts, not model responsibilities.** The plugin rebuilds the catalog from page frontmatter and appends to the log itself, so neither depends on the model remembering to update it and neither can drift from the pages it describes.

**The vault lives in the DSH home; the source lives in the repository and ships as a prebuilt copy.** The vault root is the `vaultRoot` Config field, defaulting to `<DSH home>/knowledge`. The source is `packages/prism/prism-wiki`; `plugins/prism-wiki` is the shipped mirror, holding `index.js`, `client.js`, `cordis.patch.yml`, `LICENSE`, and `package.json` and refreshed on each release. This split is forced by the build: `clientBundle()` resolves a client package by globbing `packages/*/*/package.json` and fails the build for any other location, the root tsdown workspace and the root vitest include never reach `plugins/*`, and the client-copy gate discovers sources under `packages/*/*/src/client` only. A Web-bearing plugin authored under `plugins/` would forfeit the supported client build, the locale-copy gate, and root test collection.

**Search is SQLite FTS5 with the `trigram` tokenizer.** Measured on Node v24.19.0 with SQLite 3.53.3, the FTS5 default `unicode61` tokenizer returns zero hits for a CJK query against CJK text, while `trigram` matches it. The index at `.wiki/index.db` is a rebuildable cache and never a source of truth.

**The schema reaches the model in two pieces.** The static system-prompt section carries the mechanics and stays byte-stable from Config. The vault's own co-evolved `AGENTS.md` is appended once per session, as a single frame at the request tail, and is readable at any time through `wiki_read`. Editing the schema therefore never rewrites the cached prefix.

## The vault layout and page format

```
$DSH_HOME/knowledge/
  AGENTS.md
  index.md
  log.md
  raw/
    assets/
  wiki/
    overview.md
    entities/  concepts/  sources/  comparisons/  syntheses/
  .wiki/
    index.db
```

`AGENTS.md` is the co-evolved schema; `index.md` is the generated catalog and `log.md` the append-only chronology; `raw/` holds the immutable sources with downloaded images under `assets/`; `wiki/` holds the pages the model owns, one directory per page kind; and `.wiki/` holds plugin-private state that Obsidian and git both ignore.

Every page opens with a flat YAML frontmatter block:

```yaml
---
title: The page's human-facing name
type: entity
status: current
updated: 2026-01-31
tags: [retrieval, ranking]
aliases: [Other Name]
sources: [notes/paper.md]
confidence: 0.8
contradicts: [concepts/other-page.md]
---
```

`title`, `type`, `tags`, `updated`, and `status` are required; `sources`, `aliases`, `confidence`, and `contradicts` are optional. `type` is one of `overview`, `entity`, `concept`, `source`, `comparison`, or `synthesis`, and it fixes the directory the page lives in, so a path and its frontmatter cannot disagree. Links are `[[wikilinks]]`, written as the file's slug, its path relative to `wiki/`, or one of its declared aliases; a link to a page that does not exist yet is a request for one.

## Alternatives considered

**A chunked RAG index at query time.** Embed the sources, retrieve the relevant chunks per question, and let the model assemble the answer. Rejected because it re-derives the same synthesis on every question and leaves nothing behind for the next one, which is the reported problem restated as a design.

**Extend `prism-memory`'s claim store.** Rejected because a claim record answers "what do we know" and has no page-level artifact, no cross-page references, and no synthesis. Adding those to it would give one store two roles — claim fact and compiled body — and one compaction policy for both.

**Let the plugin call a model.** Rejected because synthesis is already the calling model's work in the same turn, so a plugin model call duplicates it and prices a second response for every page; because frontmatter validation, atomic writes, the catalog, and the log have no model input; and because a model-dependent derived artifact drifts on the model's availability rather than on the pages.

**Keep `index.md` or `log.md` as the model's responsibility.** Rejected because a navigation artifact the model maintains drifts the first time a write batch ends without one, and a parseable chronology cannot rest on the model remembering to append. Regenerating and appending from the plugin is cheap and always current.

**Place the vault in the session workspace.** Rejected because a session workspace is per-session and belongs to the model's file tools under the sandbox, while the vault is deployment-wide knowledge that outlives a session and is edited by a human out of band. The `vaultRoot` config field keeps the location a deployment choice.

**Author the plugin under `plugins/`.** Rejected because that directory receives no client bundle from the root build, no locale-copy gate, and no root test collection, so the Web Knowledge page could not be built from there. The source stays under `packages/prism/prism-wiki`, and `plugins/prism-wiki` holds the prebuilt mirror the release refreshes.

**Rely on the FTS5 default tokenizer.** Rejected on measurement: `unicode61` returns zero hits for a CJK query against CJK text, and the vault is expected to hold Chinese pages, so the default makes search useless for them.

**Add embeddings, a vector store, or a reranker.** Rejected because retrieval here is literal FTS5 ranking, the catalog plus a plain search is enough at this scale, and a rebuildable index over page text needs no second dependency, no embedding calls, and no reindex on a model change.

## Consequences

Knowledge now accumulates across turns and sessions: a compiled page is read and edited instead of re-derived, and the catalog and log stay current without a model action. The plugin validates and audits — frontmatter fields, page/source relations, link resolution, contradictions — but it never synthesizes, so a contradiction between two pages surfaces only once the model records it in `contradicts`, and the lint report stops asking about the pair only when both pages name each other.

The vault is deployment data in the DSH home while the package is repository source, so the shipped plugin is a prebuilt mirror that every release must refresh. A future Web-bearing plugin authored under `plugins/` would forfeit the client build, the locale-copy gate, and root test collection.

Search depends on SQLite FTS5 and the `trigram` tokenizer being present in the deployment's Node runtime, and the index is a cache: any deployment can delete `.wiki/index.db` and lose nothing but the next search's rebuild.

Every page write is atomic and can carry an expected revision hash; a mismatch returns a conflict and writes nothing. The vault is plain markdown with `[[wikilinks]]` and YAML frontmatter, so Obsidian, any editor, and git operate on it unchanged, and the four writers that touch it — the model's tools, the Web page, an external editor, and git — meet atomic writes and the revision check rather than a lock protocol.
