---
feature: prism-backup
status: in-progress
updated: 2026-10-30
branch: feat/prism-backup (worktree .worktrees/prism-backup)
commits: 1a63913b (base)..delivery worktree
---

# Prism 备份

[English](prism-backup.md) | 中文

## 报告

## [S1] 问题

Prism 有三类用户数据只存在于一台机器上，没有任何复制到别处的途径：配置（profile 与 home 两层 `cordis.patch.yml`、`.env`、`.credentials.yaml`）、长期记忆（`~/.prism/storages/prism_memory/`）、以及项目文件夹注册表和注册的项目文件夹本身。磁盘故障或换一台电脑会同时丢掉积累的记忆、调好的配置和项目列表。用户需要一个设置项，把这三类数据通过 WebDAV、SMB 或 S3 备份到自己指定的远程服务器，并从设置页触发。

## [S2] 设计

### S2.1 包与组装

新建 in-tree 工作区包 `packages/backup/prism-backup`，包名 `@prism/prism-backup` —— 继 `@prism/prism-session-import` 之后 fork 的第二个 `@prism` 包。它同时携带宿主半区（`apply` 背后的备份服务，负责收集、归档、传输、轮换与历史）与客户端半区（一个 `settings.section` 页面），由 `packages/bundle/web-app/cordis.patch.yml` 中的一行 Loader 行挂载 —— 行的 `name` 用裸包名，浏览器半区才会挂到同一行上。配置写入走既有 `remote.settings` 面，密钥走 `remote.credentials`，因此本功能不新增生成的 Typert 命名空间，除该 patch 外不改动任何上游所有的装配文件。patch 行带 `PRISM-DIVERGENCE` 标记，并以 A11 区加入 [fork-upstream-divergence](fork-upstream-divergence.zh.md) 索引。

### S2.2 配置

同一时刻只有一个活动目标；切换类型只隐藏另一类型的字段，不清空它们。`PrismBackupService.Config` 上是平铺的 volatile 字段，出厂默认值在 patch 行中重述：

- `targetType`：`webdav | s3 | smb`（默认 `webdav`）。
- WebDAV：`webdavUrl`（含服务器 WebDAV 路径的基地址）。
- S3：`s3Endpoint`（留空表示 `s3Region` 对应的 AWS 端点）、`s3Region`（默认 `us-east-1`）、`s3Bucket`、`s3PathStyle`（默认 `false`；MinIO 与多数自建服务填 `true`）。
- SMB：`smbPath`（UNC 路径 `\\server\share\folder` 或映射盘符）。
- 通用：`username`（WebDAV/SMB 登录名；S3 不用）、`s3AccessKeyId`、`remoteDir`（默认 `prism-backup`）、`includeSettings`/`includeMemory`/`includeProjects`（默认 `true`）、`projectExcludes`（默认清单见 S2.4）、`maxBackups`（默认 `10`，`0` 表示全保留）。

模式校验只覆盖单字段的范围与形状；必填字段在运行或测试连接开始时才解析，而不是在页面保存时：跨字段 `.check()` 会在用户切换协议后的第一次保存就拒绝，使其没有机会先填新字段。该解析器以类型化、可操作的错误逐项点名缺失字段，并以凭据引用点名缺失的密码 —— 配置错误要大声失败，绝不静默跳过。

### S2.3 密钥

密码类值绝不进 Config 或任何 patch 文件。它们是提供者管理的文件层里的普通凭据引用 —— `PRISM_BACKUP_WEBDAV_PASSWORD`、`PRISM_BACKUP_SMB_PASSWORD`、`PRISM_BACKUP_S3_SECRET_KEY` —— 由设置页经既有 `remote.credentials.set`/`unset`/`describe` 面写入，与 Models 页管理供应商密钥的方式完全相同，值只落到 `~/.prism/.credentials.yaml`。宿主在每次运行时用 `ctx.credentials.resolve` 解析一次引用，所以改密码无需重启即可生效；页面只渲染 `describe()` 的 `configured` 标志，永不显示值。设置页与插件 README 说明备份压缩包内含 `.env` 与 `.credentials.yaml`，备份目标必须是用户信任的服务器。

### S2.4 压缩包布局

每次备份产出单个 zip，名为 `remoteDir` 下的 `prism-backup-<yyyyMMdd-HHmmss>.zip`，用 fflate 流式写入 `dshCachePath('backups')` 下的暂存文件，上传后删除。成员：

| 成员 | 来源 |
| --- | --- |
| `prism-backup/manifest.json` | 最后写入：格式版本、创建时间、应用名与版本、各来源的数量与字节总量、宿主平台、缺失的来源清单，以及遍历时跳过的条目 |
| `prism-backup/settings/profile-cordis.patch.yml` | profile 的 patch 文件（`profileContext`） |
| `prism-backup/settings/home-cordis.patch.yml` | `~/.prism/cordis.patch.yml` |
| `prism-backup/settings/env` | `~/.prism/.env` |
| `prism-backup/settings/credentials.yaml` | `~/.prism/.credentials.yaml` |
| `prism-backup/memory/prism_memory/**` | 整个 `storages/prism_memory` 目录 |
| `prism-backup/workspace/registry.json` | `~/.prism/storages/workspace.json` |
| `prism-backup/projects/<index>-<folderName>/**` | 每个已注册项目文件夹内的文件 |

可选成员在源存在时打包，源不存在时在 manifest 中记为缺失。项目目录遍历把 `projectExcludes` 作为路径段匹配（默认：`.git`、`node_modules`、`dist`、`build`、`out`、`target`、`coverage`、`__pycache__`、`.venv`、`venv`、`.next`、`.turbo`、`.cache`、`.DS_Store`），不可读的条目跳过并在 manifest 中记录警告；文件夹名加收集序号前缀，并以逐字路径集合去重，避免同名文件夹相撞。会话数据永不打包。

### S2.5 传输实现

一个内部接口：两个实现在进程全局 fetch 分发器之上，一个在操作系统的文件会话之上：

- **WebDAV**：上传用 `PUT`，缺失的父集合用 `MKCOL`（首次 `409`/`404` 时逐级创建后重试一次），列表用 `PROPFIND` Depth 1，轮换用 `DELETE`，Basic 认证。
- **S3**：header 形式 SigV4，`x-amz-content-sha256: UNSIGNED-PAYLOAD`，上传从暂存文件流式发送；`PutObject`、`ListObjectsV2`（单页，因此一次轮换最多看到 1000 个键）、`DeleteObject`；按 `s3PathStyle` 选择 path-style 或 virtual-host 寻址。`list` 返回所请求前缀下的名称，与另外两个传输一致，因为轮换依据基名判断。签名实现用 AWS 公开的 SigV4 测试向量做单元测试，且传输只签名它实际发送的 header。
- **SMB**：对 `smbPath` 直接用 `node:fs` —— UNC 路径或映射盘符使用操作系统会话的凭据。路径不可达且存有用户名密码时，Windows 额外执行一次 `net use <path> <password> /user:<username>` 引导后重试一次；引导调用的密码参数在进程表中可见，README 会写明。macOS 与 Linux 上 SMB 需要预先挂载的路径，测试连接结果会如此说明。

### S2.6 运行编排

`PrismBackup.run()` 单飞：已有运行在途时，第二次调用以 `prism-backup/busy` 失败，不排队。运行经 collect → zip → upload → rotate 推进，并在设置页轮询的内存状态里发布当前阶段与字节/文件计数。结束向 `prism_backup` 存储域（按记录表）追加一条运行记录，列表裁剪到最近 20 条。记录包含 id、起止时间、`success | failed`、目标类型与脱敏端点（去掉 URL userinfo，无凭据）、归档名、目标对象键、压缩包大小、成员计数，以及失败的 code 与 message。无法打开的历史存储 —— 例如记录文件损坏 —— 会降级为空历史并记录一条警告，而不是让插件失败；一次运行即使写入记录被拒，也照实报告自身结果。失败使用 `prism-backup/*` 表（`not-configured`、`busy`、`connection-failed`、`auth-failed`、`upload-failed`、`collect-failed`、`failed`），各自在检查点抛出，底层错误作为 `cause`：读取或压缩来源抛 `collect-failed`，传输拒绝抛各自的 code，其余未分类的为 `failed`。

### S2.7 宿主路由

插件经 `ctx.connection.fetch.register` 注册一条精确 POST 路由 `/api/prism.backup` —— 与 `file-upload` 处理无法走 JSON Remote 调用的工作所用的同一通道，这也是本功能不需要生成 Typert 命名空间或 Remote contribution 的原因。缓冲的 JSON 体携带一个 `action`：`state`（运行阶段加历史记录）、`run`（启动一次运行，返回其记录）、`test`（按类型测可达性并附可操作信息）。应答是 JSON 信封 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`，code 取自 `prism-backup/*` 表。只要宿主报告有运行在途，页面每秒轮询 `state` —— 包括不是本页发起的运行，因此运行中途打开的页面也会跟上 —— 运行结束或插件卸载时停止；配置写入与密钥写入仍走各自既有的 Remote 面。

### S2.8 设置页

由包的客户端半区注册一个 `settings.section`（id `backup`，order `25`，排在 agent presets 之后），照 models 页的方式经 config-forms 服务读取实时配置，并按期望 revision 经 `form.mutate` 写回。页面结构：目标类型选择器、活动类型的连接字段（密码为只写输入框，显示已存储或未存储，已存储时提供“清除”）、内容开关、多行控件里的排除清单与保留数、历史列表（时间、状态、大小、目标、失败详情）。每个字符串都放在包的 `locales.ts` 对里，zh 是键集事实源、en 与之镜像，`verify-client-ui-i18n` 保持干净；按钮命名其结果（`Test connection`、`Back up now`、`Backed up`）。

## [S3] 范围

- 范围内：`@prism/prism-backup` 包（宿主服务、Remote 命名空间、客户端设置页），WebDAV/S3/SMB 传输，设置 + 记忆 + 项目文件夹与工作区注册表的单次备份，轮换，运行历史，双语文档与 UI 文案，单元与集成测试。
- 范围外：从压缩包恢复或导入（manifest 使压缩包自描述，留给后续特性）、定时备份、多命名目标、会话数据备份、面向 agent 的备份工具、对接真实远程服务器的端到端测试。

## 任务

- [ ] T1：搭建包 —— manifest、face 配置、经 `clientBundle` 的 tsdown（host 阶段）、web-app loader 行、服务与路由；`build:artifacts` 与 web profile 启动保持绿（依赖：无）
- [ ] T2：带校验的 Config 模式、凭据引用解析、`prism_backup` 存储域（依赖：T1）
- [ ] T3：WebDAV、S3（SigV4 对照公开向量）、SMB 传输与单元测试（依赖：T1）
- [ ] T4：编排器 —— 收集、压缩、上传、轮换、阶段、历史 —— 用假传输做集成测试（依赖：T2、T3）
- [ ] T5：POST 路由、失败 code 表、宿主侧 spec（依赖：T4）
- [ ] T6：客户端设置页、locale 对、插槽注册、run/test/state 的 fetch 接线（依赖：T5）
- [ ] T7：README 对、divergence 索引 A11 区、如生成器扫描本包则再生成 config catalog（依赖：T6）
- [ ] T8：完整验证 —— 构建、测试、覆盖率、typecheck、文档与 i18n 门禁（依赖：T7）
- [ ] T9：评审发现 —— bundle 依赖、S3 列表名称、单飞占位、分阶段失败 code、manifest 字节与对象键、刷新后跟随运行、多行排除控件、清除密码控件（依赖：T8）

## [S4] 验收

- [ ] web bundle 声明该包，Loader 以裸包名启动该行，客户端设置页渲染出备份分区。
- [ ] 保存连接字段会持久化到 profile patch；密码只经凭据面写入，其值落在 `.credentials.yaml`，Config 字段与 patch 行都无法承载密码。
- [ ] `test` 按活动类型报告可达性，失败时给出可操作的信息。
- [ ] WebDAV 传输上传的 zip 成员、manifest 计数与 manifest 字节总量都与计划一致。
- [ ] SigV4 签名匹配 AWS 公开向量，且 S3 传输只签名它实际发送的 header。
- [ ] 轮换保留 `maxBackups` 个压缩包并删除更老的，包括存储返回完整键名的情况。
- [ ] 同一 tick 内发起两次运行只产生一次运行与一次 `busy` 拒绝。
- [ ] 历史保持在 20 条以内，经存储域在服务重启后仍在；存储无法打开时降级而不是失败。
- [ ] 工作树上 `typecheck`（两个聚合）、`build:artifacts` + `build:check` 与文档/i18n 门禁通过；`packages/backup/prism-backup/src` 下每个文件覆盖率 100%。
