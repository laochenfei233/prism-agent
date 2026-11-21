---
description: "Prism 所属的知识库能力：由 LLM 维护的互链 Markdown 页面集合、维护它的工具，以及 Web 知识库页面。"
kind: "package-group"
---

# prism/ — Prism 所属插件族

[English](README.md) | 中文

## Summary

prism 组拥有扩展 DeepSeek Harness 的产品包，但不占用上游 DSH 包命名空间。`@prism/prism-wiki` 维护一个由互链 Markdown 页面构成的持久知识库：模型负责读原始来源、写页面，而该包只承担机械性的工作；它通过 `./web` 与 `./client` 两个半侧向[Web 客户端](../../docs/subsystems/web-client.zh.md)贡献知识库页面。

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-wiki/`](prism-wiki/README.zh.md) | 维护知识库：页面与来源操作、生成的目录与日志、全文检索、通过 `./tools` 提供的模型工具、通过 `./commands` 提供的 `/wiki` 命令，以及通过 `./web` 与 `./client` 提供的知识库页面 | `ctx.wikiVault`；贡献知识库工具、`wiki` 命令与 `wiki-vault` 主面板 |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism 拥有该组中的包。Prism 包使用 `@prism` 作用域，可以依赖 DSH 能力，但不占用 DSH 包命名空间。

</details>
