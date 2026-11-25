---
description: "autonomy 组的组图：autonomous-guarded 权限预设与其背后的审批自动应答器，供用户与维护者浏览本组。"
kind: "package-group"
---

# packages/autonomy

[English](README.md) | 中文

## Summary

autonomy 组承载权限预设的自主档。组内的包在 `autonomous-guarded` 预设（随 base bundle 的权限表发布）下触发：此类会话中的审批请求会经审批接缝自动应答，命中的"仍需人工"匹配器除外——出厂默认是沙箱升级。deny 栏杆不会产生 ask，保持原样。本组仅在 Host 侧：模型只会看到一条切换通知，被自动应答的请求不会在客户端出现审批卡片。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-autonomy`](prism-autonomy/README.zh.md) | 审批应答器、预设映射与实时切换通知 | service `prism-autonomy` |

-----

<a id="related-documentation"></a>
## Related documentation

- [自主审批预设特性文档](../../docs/compose/spec/prism-autonomy.zh.md) —— 设计、边界与验收项。
- [权限预设](../interaction/permission-presets/README.zh.md) —— 触发预设所在的预设表。
