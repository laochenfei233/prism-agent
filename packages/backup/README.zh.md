---
description: "The backup group map: archiving the Harness home and registered project folders to a remote server, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/backup

[English](README.md) | 中文

## 摘要

备份组把用户数据复制到持有它的机器之外。它唯一的包把配置层、长期记忆存储、工作区注册表以及每个已注册项目文件夹打包成一个 zip，上传到 WebDAV、SMB 或 S3 目标，然后清理较旧的归档。它是宿主侧、面向浏览器的：提示词、工具与会话事件都不进入模型；会话日志不进归档，因为它有自己的导出功能。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`prism-backup`](prism-backup/README.zh.md) | 打包配置、记忆与项目文件夹，上传 zip，并保存运行历史 | 注册 `POST /api/prism.backup` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Prism 备份特性文档](../../docs/compose/spec/prism-backup.zh.md) —— 功能存在的原因、归档布局与传输选择。
- [配置目录](../../docs/config-catalog.zh.md#prismprism-backup) —— 每个接受字段及其 JSDoc。
