---
description: "transfer 组的包地图：以归档文件在安装之间搬运项目与设置，面向浏览该组的用户与维护者。"
kind: "package-group"
---

# packages/transfer

[English](README.md) | 中文

## 摘要

transfer 组把用户数据以文件形态在机器之间搬运。它唯一的包把选中的项目（工作区文件夹加挂接的全部会话）与设置页可编辑的值导出为自描述归档文件，并把这类归档导回：解出文件夹、恢复会话及其标题、媒体与文件、登记工作区、重新应用设置值。导入永不覆盖已有数据。它是宿主侧加浏览器侧：没有提示、工具或会话事件到达模型。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`prism-transfer`](prism-transfer/README.zh.md) | 经设置页导出与导入项目和设置归档 | 注册 `/api/prism.transfer/*` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Prism 导入导出特性文档](../../docs/compose/spec/prism-transfer.zh.md) — 特性缘由、三种归档格式与安全守卫。
- [会话日志导出](../session-query/session-log-export/README.zh.md) — 导出复用的会话条目生产者。
- [Prism 备份](../backup/README.zh.md) — 本组刻意不取代的整机远程备份。
