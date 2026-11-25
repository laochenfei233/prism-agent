---
description: "Prism 所属插件：由 LLM 维护的知识库，以及持久化的会议纪要、转写与问答。"
kind: "package-group"
---

# prism/ — Prism 所属插件族

[English](README.md) | 中文

## Summary

prism 组拥有扩展 DeepSeek Harness 的产品包，但不占用上游 DSH 包命名空间。`@prism/prism-meeting` 在 Session 日志之外持久化会议记录，提供录音转写、配置化摘要和持久化问答，把受控操作暴露为显式模型工具；`@prism/prism-wiki` 维护一个由互链 Markdown 页面构成的持久知识库，模型负责读原始来源、写页面，而该包只承担机械性的工作。两者都通过 `./web` 与 `./client` 两个半侧向[Web 客户端](../../docs/subsystems/web-client.zh.md)贡献自己的页面。

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-meeting/`](prism-meeting/README.zh.md) | 存储会议和回答，转写完整录音，执行配置化摘要和回答，通过 `./tools` 注册模型工具，并通过 `./web` 与 `./client` 提供会议页面 | `ctx.meetingMinutes`；贡献会议工具与 `meeting-minutes` 主面板 |
| [`prism-wiki/`](prism-wiki/README.zh.md) | 维护知识库：页面与来源操作、生成的目录与日志、全文检索、通过 `./tools` 提供的模型工具、通过 `./commands` 提供的 `/wiki` 命令，以及通过 `./web` 与 `./client` 提供的知识库页面 | `ctx.wikiVault`；贡献知识库工具、`wiki` 命令与 `wiki-vault` 主面板 |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism 拥有该组中的包。Prism 包使用 `@prism` 作用域，可以依赖 DSH 能力，但不占用 DSH 包命名空间。

</details>
