---
description: "Back up the Harness configuration, the long-term memory store, and the registered project folders to a WebDAV, SMB, or S3 server from the settings page."
kind: "package-reference"
---
# Prism 备份

[English](README.md) | 中文

## 概述

`@prism/prism-backup` 把 profile 与 home 两层 `cordis.patch.yml`、`.env`、`.credentials.yaml`、长期记忆存储、工作区注册表以及每个已注册项目文件夹打包，上传到 WebDAV、SMB 或 S3 目标之一，并按保留数清理旧归档。浏览器半区是一个设置分区：经共享配置表单编辑 `prism-backup` 命名空间，经凭据面保存密码，并通过一条 POST 路由驱动 `run`、`test`、`state`。会话日志永不打包。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

宿主半区是 `dsh-web-app` 中的一行 Loader 行（`prism-backup`），需要 `connection`、`storageDomain`、`credentials`。它只注册一条路由 `POST /api/prism.backup`，缓冲的 JSON 体携带 `{ "action": "state" | "test" | "run" }`。应答为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`，HTTP 状态由 code 决定：`prism-backup/bad-request` 为 `400`，`prism-backup/busy` 为 `409`，其余配置或供应商失败为 `502`。这条路由是设置页唯一的宿主调用，其他一切走既有通道。

配置是一个实时分区：`targetType` 选择目标，对应类型的字段填写它，`includeSettings`/`includeMemory`/`includeProjects` 与 `projectExcludes`、`maxBackups` 决定归档内容与保留。运行开始时读取一次实时值，且单飞：运行名额在解析策略之前就被占住，因此同一 tick 内到达的两个请求只产生一次运行与一次 `prism-backup/busy` 拒绝。运行或测试连接之前不要求字段完整 —— 这正是用户可以先切换协议再逐项填写的原因；缺字段时运行以 `prism-backup/not-configured` 失败并点名该字段。

密码绝不进 Config：WebDAV 密码、SMB 密码、S3 secret access key 都是凭据引用（`PRISM_BACKUP_WEBDAV_PASSWORD`、`PRISM_BACKUP_SMB_PASSWORD`、`PRISM_BACKUP_S3_SECRET_KEY`），由页面经 `remote.credentials` 写入，运行时解析一次。页面只渲染是否已存储。地址里自带 `user:password@` 的端点会以 `prism-backup/not-configured` 被拒绝，而不是被静默去掉 —— 静默去掉会把一个可用的密码变成匿名 401；请把用户名填在独立字段、密码存进凭据存储。

### 一个归档里有什么

| 成员 | 来源 |
| --- | --- |
| `prism-backup/manifest.json` | 格式版本、创建时刻、应用名与版本、平台、各来源计数与字节总量、缺失来源、跳过条目 |
| `prism-backup/settings/profile-cordis.patch.yml` | 活动 profile 的 patch 文件 |
| `prism-backup/settings/home-cordis.patch.yml` | `$DSH_HOME/cordis.patch.yml` |
| `prism-backup/settings/env` | `$DSH_HOME/.env` |
| `prism-backup/settings/credentials.yaml` | `$DSH_HOME/.credentials.yaml` |
| `prism-backup/memory/prism_memory/**` | 整个记忆存储 |
| `prism-backup/workspace/registry.json` | 工作区注册表 |
| `prism-backup/projects/<序号>-<名称>/**` | 每个已注册项目文件夹，去掉被排除的路径段 |

可选成员在源存在时打包，否则在 manifest 中记为缺失；消失的项目文件夹只记一条警告，不使备份失败。归档写在上传期间的 `$DSH_HOME/cache/backups`，之后删除。轮换列出远程目录，保留最新的 `maxBackups` 个归档（含刚写入的这个；`0` 表示全留），删除其余；每个传输都返回所请求目录下的名称，因此返回完整键名的存储也能正确轮换。运行记录保留目标对象键、脱敏端点（去掉 URL userinfo）、归档大小与各来源计数。历史存放在 `prism_backup` 存储域；该存储无法打开时降级为空历史并记录一条警告，而不是让插件失败。

### 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `targetType` | `webdav` | 活动目标协议：`webdav`、`s3` 或 `smb` |
| `webdavUrl` | 空 | 含服务器集合路径的 WebDAV 基地址 |
| `s3Endpoint` | 空 | S3 端点源；留空时按 `s3Region` 推导 AWS 端点 |
| `s3Region` | `us-east-1` | 签名区域 |
| `s3Bucket` | 空 | 接收存储桶 |
| `s3PathStyle` | `false` | 以 `endpoint/bucket` 寻址（MinIO 与多数自建服务） |
| `smbPath` | 空 | 接收归档的 UNC 路径或已挂载目录 |
| `username` | 空 | WebDAV 或 SMB 用户名；S3 忽略 |
| `s3AccessKeyId` | 空 | S3 access key id；secret key 存在凭据存储里 |
| `remoteDir` | `prism-backup` | 目标根目录下存放归档的目录 |
| `includeSettings` | `true` | 打包配置文件 |
| `includeMemory` | `true` | 打包长期记忆存储 |
| `includeProjects` | `true` | 打包工作区注册表与项目文件夹 |
| `projectExcludes` | `.git`、`node_modules`、`dist`、`build`、`out`、`target`、`coverage`、`__pycache__`、`.venv`、`venv`、`.next`、`.turbo`、`.cache`、`.DS_Store` | 永不遍历的路径段；每行一个或用逗号分隔 |
| `maxBackups` | `10` | 运行后保留的归档数；`0` 表示全部保留 |

生成的[配置目录](../../../docs/config-catalog.zh.md#prismprism-backup)是接受字段与其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无：本功能不注册提示词、工具或会话事件，备份内容也不进入任何模型请求。

#### KV Cache effect

无直接影响；备份从不读写模型请求上下文。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未实现恢复：归档通过 manifest 自描述，但目前没有任何代码把它读回 Harness 主目录。
- 没有定时。备份只在用户按下按钮时运行，关掉的宿主什么也不备份。
- 同一时刻只有一个目标。切换协议会保留其他协议的字段在同一分区里，但只运行选中的那个，因此两个目标需要两次手动运行。
- S3 轮换只读一页 `ListObjectsV2`，因此最多依据 1000 个归档判断；目录更大时保留的是这一页内最新的那些。
- 写入历史被拒的运行仍报告成功、归档也仍然落盘；损失的只有持久化历史。
- SMB 走操作系统的文件会话。Windows 路径在存有密码时会执行一次 `net use` 引导，该调用的密码参数在进程表中可见；macOS 与 Linux 需要预先挂载共享。
- 归档内含 `.env` 与 `.credentials.yaml`，目标必须是用户信任的服务器。
- 会话数据被有意排除；它有自己位于 [`dsh-session-log-export`](../../session-query/session-log-export/README.zh.md) 的导出功能。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本功能是插件而非循环改动：宿主半区是 `apply` 加 `src/run.ts`，浏览器半区注册一个 `settings.section`。三个它不拥有的接缝承载产品能力：`ctx.settings` 把本包的 Config 投影到页面，`ctx.credentials` 保存密码，`ctx.storageDomain` 在 `prism_backup` 下保存运行历史。POST 路由存在的原因是备份是带进度的文件传输而不是 JSON Remote 调用；`dsh-client-file-upload` 出于同样理由注册自己的 POST 路由。

SigV4 直接实现于进程全局 fetch 之上而非 SDK：传输签名 `UNSIGNED-PAYLOAD`，让暂存归档无需先算正文哈希即可流式上传；被签名的 header 恰是实际发送的那些，这也是调用方提供的 `x-amz-date` 同时决定凭据 scope 的原因。AWS 公开的 Signature Version 4 测试向量是保证这一点正确的单元测试。

后续改动有两处易错。归档成员名同时是恢复路径，因此新增来源必须在 `collect.ts` 中给出明确的 `prism-backup/<区域>/...` 成员名。轮换比较的是归档名而非服务器时间戳，所以 `run.ts` 中 `prism-backup-<yyyyMMdd-HHmmss>.zip` 的拼写就是排序契约。

</details>
