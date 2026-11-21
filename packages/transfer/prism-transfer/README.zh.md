---
description: "以归档文件在设置中导入导出项目（工作区文件夹加挂接的会话）与设置值。"
kind: "package-reference"
---

# @prism/prism-transfer

[English](README.md) | 中文

## 概述

`prism-transfer` 在设置的「导入导出」页把项目与设置在安装之间以文件搬运。导出按所选写出一个标准 zip——工作区文件夹、每个挂接会话的日志及其子代理、媒体与文件——外加一个可选 JSON 承载可编辑的设置值。导入逐条目验证归档、每个项目一次原子 rename 发布、按原 id 恢复会话、重新存储媒体、登记工作区，并在不覆盖已有数据的前提下重新应用设置。项目标题行的菜单还提供「导出项目」，经同一条流式路由下载；多项目与设置归档仍在设置页完成。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把包装进已提供 Connection、会话持久化、工作区登记、附件服务与设置服务的 Web 或桌面 bundle。插件注册四条认证路由与一个浏览器设置分区。

### 组装

```yaml
- id: prism-transfer
  name: '@prism/prism-transfer'
```

清单声明了 `dsh.client`，浏览器半区经同一行加载。

### 路由合约

| 路由 | 请求体 | 结果 |
|---|---|---|
| `GET /api/prism.transfer/export` | 查询 `projects`（逗号分隔的工作区 id）、`settings=0\|1`、`secrets=0\|1` | 流式 zip（单项目或合并布局）或设置 JSON 附件；工作区未知返回 404。 |
| `POST /api/prism.transfer/import` | 流式 octet-stream zip，查询 `dest?`（绝对目的地根） | `{ "jobId": "…" }`；后台任务解压、恢复、登记。同时只允许一个导入；并发的第二次上传返回 409。 |
| `GET /api/prism.transfer/job` | 查询 `jobId` | 任务快照：阶段、字节与会话计数、逐项目结果，或类型化错误。未知 id 返回 `{ "state": "idle" }`。 |
| `POST /api/prism.transfer/settings` | 缓冲 `prism-settings` JSON | 每个命名空间一个结果：`applied`、`skipped`（不活跃或无可编辑字段）、`failed` 附原因。 |

### 归档格式

三种版本 1 格式，各以根清单自描述：

- `prism-project`（单项目 zip）：`.prism-project.json`、承载文件夹的 `project/**`、及其旁的 `sessions/<id>/session.v4.jsonl` 与 `subagents/`、`media/`、`files/`。
- `prism-transfer`（合并 zip）：`.prism-transfer.json`、每个携带完整 `prism-project` 布局的 `projects/<n>-<标题>/` 子目录、可选 `settings.json`。
- `prism-settings`：`format`、`includeSecrets`、以及把每个活跃设置命名空间映射到其可编辑值的 `namespaces`。

导出拒绝单个 ≥ 4 GiB 的文件（zip 写入器的单条目上限），跳过符号链接与不可读文件并计数，绝不跟随链接离开项目文件夹。密钥除非显式包含否则不导出，凭据记录永不导出。

### 预期行为

导入先校验后写入：条目名守卫（目录穿越、绝对路径、反斜杠、盘符前缀、冒号段）、重复与大小写/NFC 折叠冲突、祖先冲突、条目数与单条目大小上限、剩余空间守卫。归档先落盘到 `$DSH_HOME/cache/prism-transfer`，绝不驻留内存。会话经普通持久化句柄恢复并写投影检查点，标题不经打开即出现在侧栏；媒体与文件流入附件服务，其内容地址必须与归档点名的地址一致。失败的导入不留暂存目录、不留半发布项目；超过 24 小时的 `.prism-import-*` 残留被清扫。

### 失败

每个拒绝携带页面映射为中英文案的稳定码：`bad-archive`、`bad-manifest`、`unsafe-path`、`path-conflict`、`too-many-entries`、`entry-too-large`、`crc-mismatch`、`disk-space`、`session-version`、`attachment-mismatch`、`busy` 等。工作区登记失败保留已恢复的文件，并按项目报告而不是回滚。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计切分

宿主半区（[`src/index.ts`](src/index.ts)）注册四条路由并驱动任务存储。导出引擎（[`src/export-engine.ts`](src/export-engine.ts)）在守卫下扫描文件夹并产出归档条目，每个会话的日志、子代理、媒体与文件复用 `@deepseek-ai/dsh-session-log-export` 的 `sessionLogZipEntries`。导入引擎（[`src/import-engine.ts`](src/import-engine.ts)）经中央目录 zip 读取器（[`src/zip-reader.ts`](src/zip-reader.ts)）读取落盘归档，逐条目验证 CRC-32——fflate 的流式 inflate 不做此事。设置传输（[`src/settings-transfer.ts`](src/settings-transfer.ts)）把生效设置文档投影为可编辑值，并经修订防护写入路径带一次冲突重试地重新应用。浏览器半区（[`src/client/TransferSection.tsx`](src/client/TransferSection.tsx)）渲染导出与导入卡片并跟随任务快照。

### 永不覆盖

项目发布把完整解压的暂存目录 rename 到发布时探测为空闲的名字。会话经 `sessionPersistence.stat` 按 id 去重。设置按命名空间以描述符修订应用，先对最新修订重试一次再报告失败。附件按内容寻址，重复导入同一归档不会重复发布。

### 无模型可见内容

插件不注册任何提示、工具或会话事件；它只是普通的宿主文件传输加浏览器设置状态。

### 测试覆盖

`pnpm vitest run packages/transfer/prism-transfer` 覆盖 zip 读取器守卫、导出与导入引擎、设置传输、任务存储与两条路由的失败词汇表。仅设置的导出路径不需要会话服务，因此没有它们的组合仍能搬运配置。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [transfer 组包地图](../README.zh.md) — 本包所属的组。
- [会话日志导出](../../session-query/session-log-export/README.zh.md) — 导出复用的会话条目生产者。
- [工作区登记](../../workspace/workspace/README.zh.md) — 实时项目成员服务。
- [Prism 备份](../../backup/prism-backup/README.zh.md) — 面向另一种需求的整机远程备份。

-----

<a id="model-experience"></a>
## 模型体验

无，本特性不注册提示、工具或会话事件，也没有任何归档字节到达模型请求。

#### KV Cache 影响

无直接影响；被导入会话的下一次请求携带与任何已存储会话相同的派生历史。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **会话日志逐字复制** — 头部的 `cwd` 指向导出机器的路径且从不改写；分组与续跑跟随工作区记录。本构建不运行的格式版本的日志使该导入失败而不是被迁移。
- **无取消、暂停或续跑** — 进行中的导入要么完成要么失败；关闭应用丢失任务，其暂存稍后被清扫。
- **单文件 4 GiB** — zip 写入器的单条目上限是硬性导出守卫，不是压缩选择；更大的素材必须先压缩或拆分。
- **无加密、不收外来 zip** — 本应用未产出的归档（无清单）被拒绝，也没有口令保护。
- **项目行导出跳过页面校验** — 路由把归档或错误响应直接交给浏览器下载管理器，拒绝会以「下载到的错误文件」出现，而不是页内文案；带类型错误的提示仍由设置页负责。
- **空目录与超大日志** — 项目内的空文件夹不进归档，超过 256 MiB 的会话日志在导入端被拒（导出端无此上限），导入中途失败会保留已恢复的会话；再次导入同一归档时，这些会话会在新发布的文件夹下计为重复。

### 开发备注

<details>
<summary>面向维护者的实现备注——点击展开</summary>

导入把清单视为归档的契约：条目名先经结构校验再写任何字节，会话按原 id 恢复到新编号的项目文件夹，设置经修订栅栏重新应用——被拒绝的导入不会让目录树发生任何变化。

</details>
