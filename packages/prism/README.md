---
description: "Prism-owned knowledge vault: an LLM-maintained set of interlinked markdown pages, the tools that maintain it, and the Web Knowledge page."
kind: "package-group"
---

# prism/ — Prism-owned plugin family

English | [中文](README.zh.md)

## Summary

The prism group owns product packages that extend DeepSeek Harness without taking the upstream DSH package namespace. `@prism/prism-wiki` maintains a persistent knowledge vault of interlinked markdown pages, where the model reads raw sources and writes pages while the package performs only the mechanical work, and it contributes the Knowledge page to the [Web Client](../../docs/subsystems/web-client.md) through its `./web` and `./client` halves.

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-wiki/`](prism-wiki/README.md) | Maintains the knowledge vault: page and source operations, the generated catalog and log, full-text retrieval, model tools through `./tools`, the `/wiki` command through `./commands`, and the Knowledge page through `./web` and `./client` | `ctx.wikiVault`; contributes the vault tools, the `wiki` command, and the `wiki-vault` main panel |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism owns packages in this group. A Prism package claims the `@prism` scope and may depend on DSH capabilities without taking the DSH package namespace.

</details>
