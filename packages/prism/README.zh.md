---
description: "Prism 所属的会议纪要能力：持久化会议与回答、配置化摘要，以及面向模型的工具。"
kind: "package-group"
---

# prism/ — Prism 所属插件族

[English](README.md) | 中文

## Summary

prism 组拥有扩展 DeepSeek Harness 的产品包，但不占用上游 DSH 包命名空间。`@prism/prism-meeting` 在 Session 日志之外持久化会议记录，提供录音转写、配置化摘要和持久化问答，把受控操作暴露为显式模型工具，并通过 `./web` 与 `./client` 两个半侧向[Web 客户端](../../docs/subsystems/web-client.zh.md)贡献会议页面。

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-meeting/`](prism-meeting/README.zh.md) | 存储会议和回答，转写完整录音，执行配置化摘要和回答，通过 `./tools` 注册模型工具，并通过 `./web` 与 `./client` 提供会议页面 | `ctx.meetingMinutes`；贡献会议工具与 `meeting-minutes` 主面板 |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism 拥有该组中的包。它们使用 `@prism-ai` 包作用域，可以依赖 DSH 能力，但不占用 DSH 包命名空间。

</details>
