---
description: "data 组的包地图：承载「数据」设置页，并把 harness 主目录搬到另一个目录，面向浏览该组的用户与维护者。"
kind: "package-group"
---

# packages/data

[English](README.md) | 中文

## 摘要

data 组承载「数据」这一个设置页。它的包显示当前的 harness 主目录，把该目录复制到操作者选定的位置，并把选择记录到默认主目录旁边的启动指针里；CLI 与桌面壳在下一次启动时读取该指针。同一个包还提供这一页的三个页签外壳：「数据存储路径」由本组实现，「备份」「导入导出」由各自的包注册进来，仍然留在自己的包里。它是宿主侧加浏览器侧：没有提示、工具或会话事件到达模型。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`prism-data`](prism-data/README.zh.md) | 「数据」设置页、它的存储页签与搬迁路由 | 注册 `/api/prism.data` |

-----

<a id="related-documentation"></a>
## 相关文档

- [数据设置特性文档](../../docs/compose/spec/data-settings.zh.md) — 特性缘由、页签组成、搬迁规则与启动指针。
- [Prism 备份](../backup/README.zh.md) — 「备份」页签的拥有者。
- [Prism 导入导出](../transfer/README.zh.md) — 「导入导出」页签的归档部分。
- [跨 Agent 导入](../session-query/session-import/README.zh.md) — 「导入导出」页签的对话部分。
