---
feature: prism-transfer
status: delivered
updated: 2026-10-31
branch: feat/prism-transfer (worktree .worktrees/prism-transfer)
commits: 42f8b7cfed（基线）..d002a34b80
---

# Prism 导入导出

[English](prism-transfer.md) | 中文

## Report

**交付内容** — `@prism/prism-transfer` 在设置里加入「导入导出」页并使其可用。导出勾选已登记项目并流式产出一个标准 zip（单项目归档或合并归档），内含工作区文件夹、每个挂接会话的完整日志及其子代理、引用的媒体与文件，外加一个可选 JSON 文件承载设置页可编辑的值（密钥默认排除，跳过计数上报到页面）。导入逐条目验证这类归档——中央目录解析、逐条目 CRC-32、路径与冲突守卫、条目/大小上限、剩余空间守卫——随后落盘、解压到暂存区、每个项目一次原子 rename 发布（同名发布 `name (2)`，永不覆盖）、按原 id 经持久化句柄恢复会话并写投影检查点（冷侧边栏标题的来源）、经附件接口带内容地址校验地恢复媒体与文件、登记工作区、按命名空间经修订防护写入路径重新应用设置。单飞任务存储与可轮询快照驱动进度界面；失败的导入不留暂存、不留半发布项目。

**验证** — `node node_modules/vitest/vitest.mjs run packages/transfer/prism-transfer/tests --coverage --coverage.include='packages/transfer/prism-transfer/src/**'`：198 通过、1 跳过（Windows 门控的符号链接用例）、0 错误，每个 `src` 文件 100/100/100/100。`pnpm run typecheck` 通过（tsconfig 别名新增后复跑）；最终 src 状态后 `pnpm run build:artifacts` + `pnpm run build:check` 通过；`verify-cordis-config` 仅剩既有 acp fixture 失败；`verify-default-product-isolation`、`verify-dsh-package-licenses`、`verify-application-entrypoints`、`pnpm run constraints` 通过；`verify-client-ui-i18n`、`verify-md-links`、`verify-translation-pairing`、`verify-doc-budgets`、`gen-plugin-packages --check`、`gen-client-catalog --check`、`gen-config-catalog --check` 通过。本机既有失败（已在 master 验证一致）：`test:docs` 的四个失败（fork-upstream-divergence Report 行的 md-wrap、repository-references 的 uv.lock 行、ui-chat/ui-conversation 的 README Summaries、prism-backup zh README 的 doc-standard）、ui-settings-general 套件的 `dsh-web-app` 解析错误、`jscpd` 与 `pnpm install --online` 约束。独立对抗复审发现一个关键集成缺口（交付路由从未接线投影检查点）与五个 major（谎报尺寸的 deflate 内存暴露、缺失的 ADS/祖先守卫、死跳过计数器、A14 标记清单不全）——均已在分支内修复并配靶向测试，minor 记录在历程日志。

**历程日志**

- 复审的关键发现来自测试接缝：导入引擎把 `projections` 作为可选依赖，单测总是注入假件，导致交付路由静默地在没有它的情况下组装。任何改变用户可见行为的可选依赖，都需要断言接线本身的路由级集成测试，而不只是引擎行为。
- fflate 的同步 `Inflate` 经 `(data, final)` 回调报告输出并从 `push` 抛错——异步风格的 `(err, data)` 签名会把数据误送进错误槽。初版读取器正是如此，直到校验和比较开始失败才被测试抓住。
- 经 `saveImage` 恢复图片之所以安全，是因为规范化对干净字节逐字节透传；返回 id 校验把该性质变成受强制的不变量，图像策略不同的部署会大声失败而不是存储日志无法解析的引用。
- 媒体与文件条目名带有 Windows 无法存储的 `sha256:` 冒号；把这些条目直接送入附件接缝（绝不在暂存区落盘）消除了会话侧整个 ADS 类别，`project/**` 专用的冒号守卫与读取器的目录段规则则闭合了实体文件一侧。
- jsdom 通道的 v8 覆盖率重映射对较大的分区组件把已执行块报为零（探针验证）；受影响语句带 `v8 ignore` 注记并点名断言它们的 spec，其覆盖的纯逻辑（跳过计数通知）移入了重映射精确的 `state.ts`。

## [S1] 问题

Prism Agent 把每个项目保存为登记的工作区文件夹加挂接的会话，把用户配置保存为设置页里可见的设置值。这些内容目前都无法跨机器携带：

- 唯一的整库出口是 `prism-backup`，它把整机归档上传到 WebDAV/SMB/S3、不含会话、也没有恢复路径；它是备份，不是按项目或按设置的传输。
- `session-log-export` 能把单个会话（日志、子代理、媒体、文件）打成 zip 下载到浏览器，但没有任何途径把会话归档导回来，它也不携带项目文件夹和登记条目。
- `prism-session-import` 读取的是宿主上其他代理的存储，而不是归档文件；它无法从文件恢复一个 Prism 项目。
- 设置值只存在于单个安装的 profile 补丁里。换一台新机器意味着手动重填每一个分区。

目标：一个设置页分区——「导入导出」——把选中的项目（文件夹 + 挂接的会话）和/或全部设置值导出为文件，并把这些文件导回：解出项目文件夹、恢复会话使其带标题出现在侧边栏、登记工作区、重新应用设置值。单个项目导出为标准 zip；多个项目导出为一个合并 zip；设置项导出为一个可读的 JSON 文件。导入永不覆盖已有数据。

## [S2] 设计

### S2.1 包与组装

新的 fork 包 `@prism/prism-transfer` 位于 `packages/transfer/prism-transfer`（新建分组 `transfer/` 并带 README 三件套），插件名 `prism-transfer`，沿用 `prism-backup` / `prism-session-import` 的先例：宿主插件在 `src/index.ts`，客户端插件在 `src/client/index.ts` 导出 `inject` + `apply`，`package.json` 含 `./client` 导出与 `dsh.client` 清单（`platform: "web"`），组装行写入 `packages/bundle/web-app/cordis.patch.yml`，免模型审计行写入 `scripts/verify-package-readme-model-experience.ts`（产品使用来自 web-app 组装，与兄弟包一致）。不建 Typert Remote 命名空间，不新增 npm 依赖：zip 读写用 `fflate`（已是 `session-log-export` 的工作区依赖），会话序列化复用 `@deepseek-ai/dsh-session-log-export` 的公开 API，客户端依赖 `slots`、`locale`、`remote`、`workspaces`、`remote.directoryPicker`。没有 `Config` schema：本分区没有随部署变化的调节项（导入目的地默认值是产品常量，可在每次导入时经系统目录选择器覆盖；条目与大小上限是固定的安全不变量）。

分区在既有 `settings.section` 列表槽上注册，`id: 'transfer'`、`order: 30`（排在 backup 与 import 之后），label 为 `() => t('nav')`，命名空间 `settings.transfer`。唯一的核心改动是 `navIcon()`（`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`）增加 `'transfer'` 分支，带 `PRISM-DIVERGENCE` 标记，并在 `docs/compose/spec/fork-upstream-divergence.md` 增加分区行（A14；并入时该编号已由并行的 settings-entry-regroup 占用，故顺延）。`packages/client/*` 其余不动。

### S2.2 归档与文件格式

三种自描述格式，均为版本 1。单项目 zip `<安全标题>.zip`：

```
.prism-project.json              ← first entry: { format: 'prism-project', version: 1, title,
                                    exportedAt, originalPath, sessions, hasProjectFolder }
project/**                       ← the workspace folder contents (omitted when the folder is
                                    empty; hasProjectFolder: false says so)
sessions/<sessionId>/session.v4.jsonl
sessions/<sessionId>/subagents/<id>/session.v4.jsonl
sessions/<sessionId>/media/<attachmentId>.<ext>     ← normalized image bytes
sessions/<sessionId>/files/<2>/<digest>/<name>      ← file attachment bytes
```

合并 zip `prism-transfer-<ts>.zip`：

```
.prism-transfer.json             ← { format: 'prism-transfer', version: 1, exportedAt,
                                    projects: [{ dir, title, sessions }], settings: boolean }
projects/<n>-<safe-title>/…      ← each child is a complete prism-project layout with its
                                    own .prism-project.json at its root
settings.json                    ← prism-settings body, present only when settings exported
```

设置文件 `prism-settings-<ts>.json`（以及内嵌的 `settings.json`）：

```
{ format: 'prism-settings', version: 1, exportedAt, includeSecrets: boolean,
  namespaces: { <entryId>: <volatile projection of that namespace's effective value> } }
```

易变投影只携带设置页里显示为可编辑的字段（每个活跃插件 Config schema 的 `meta.volatile` 路径，来自 `ctx.settings.describe()`）。因此导入恢复的正是文件里点名的字段——文件从不携带导入时会静默丢弃的内容。清单里的计数（`sessions`）只供展示，校验永远以归档本身为准。格式用 `version` 保留演进点；读取方对未知格式与超过自身理解的版本给出类型化错误。

### S2.3 导出

一条流式 GET 路由；无任务、无暂存——zip 像会话导出一样直接构建到响应上。查询参数：`projects`（逗号分隔的工作区 id）、`settings=0|1`、`secrets=0|1`。响应选择：单项目且不带设置 → 单项目 zip；任意项目集合带设置，或多于一个项目 → 合并 zip；仅设置 → JSON 附件。文件名经 `content-disposition: attachment` 下发，非 ASCII 标题带 RFC 5987 `filename*`。

发出第一个字节之前，扫描趟先遍历每个选中工作区文件夹，遇到单个 ≥ 4 GiB 的文件（fflate 的单条目写入上限——错误点名文件并建议压缩或拆分）、名称含 `\` 或 NUL 的条目、或不可读条目时立即以类型化错误失败。符号链接与 junction 被跳过并计数，绝不跟随，文件夹之外的东西进不了归档。扫描同时汇总字节数，供浏览器自带的下载进度使用。会话内容由 `@deepseek-ai/dsh-session-log-export` 导出的生成器 `sessionLogZipEntries` 产生（根日志、经 `traceSession` 的子代理后代、媒体、文件——含它执行的活跃会话 flush），每个会话的条目重根到 `sessions/<sessionId>/` 下。导出的会话是登记表中工作区记录挂接的 id（`WorkspaceRecord.sessionIds`），含已归档会话；日志已无法打开的会话让整个导出大声失败——下载在发出截断归档（会静默丢失一个会话）之前直接报错。

设置导出在进程内读取 `ctx.settings.describe()`（`secrets=1` 时不脱敏），把每个活跃命名空间投影到易变字段；`secrets=0` 时省略 secret 角色字段并计数，`secrets=1` 时写入真实值。设置文档之外的凭据（`remote.credentials`）永不导出。

### S2.4 导入

一条流式 POST 路由接收 zip 字节（`requestBody: 'streaming'`，即 `file-upload` 通道——无大小上限），另有可选 `dest` 查询（绝对目的地根；默认经 home-paths 服务取 `~/.prism/projects`）。字节先落盘到 `$DSH_HOME/cache/prism-transfer/import-<hex>.zip`——绝不驻留内存——再经新的 zip 读取模块读回：解析 EOCD/ZIP64 中央目录，然后逐条目解压，把每个条目的 CRC32 与解压字节比对（fflate 的流式 inflate 不校验 CRC；stored 媒体必须自行验证）。在暂存区之外发生任何写入之前完成校验：条目名守卫（拒绝 `\`、NUL、前导 `/`、盘符 `:`、UNC、空段、`.`/`..` 段、超过 1024 UTF-8 字节的名称、段内 `:` ADS）、重复条目拒绝（按大小写折叠与 NFC 归一化比较）、两种顺序的祖先冲突（先文件 `a` 后 `a/b`，及反向）、至多 200 000 条目、单条目解压后 ≤ 4 GiB、剩余空间守卫（解压前要求剩余 > 归档大小 + 1 GiB；已写字节超过「起始剩余 − 512 MiB」即中止；平台无法报告剩余空间时（如部分 UNC 路径）跳过守卫）。

根清单决定形状：`.prism-project.json` → 单项目；`.prism-transfer.json` → 遍历 `projects/*`，每个子目录按完整 prism-project 布局校验；其余（含无清单 zip）以 `bad-manifest` 失败。解压进入与发布同卷的暂存目录 `<dest>/.prism-import-<hex>/`，每个项目用一次原子 `rename` 发布到 `<dest>/<最终名>`；失败清理暂存，`<dest>` 不会留下半个项目。最终名来自清单标题，用与别处项目标题相同的规则清洗（去 Windows 非法字符、限长、非空回退），与既有目录同名时追加 ` (2)`、`(3)`……至多 100 次——导入永不覆盖。默认目的地与选择的目的地都拒绝解析为 DSH home 目录本身或其保留顶层条目的发布目标。

每个项目的会话按 session-import 配方恢复：已存在的 id（`sessionPersistence.stat`）跳过并计为重复，否则从归档首行 JSONL 取 `sessionPersistence.create(header)`，把余下行作为一个连续批次 `append`，`flush`、`close`，再经 `sessionProjectionCache` 写投影检查点（让标题出现在冷侧边栏列表的那一步），然后登记并挂接。头部接受规则与 session-import 原生复制路径一致：可读且格式版本等于运行时 `SESSION_FORMAT_VERSION` 的头部按原文恢复（session-import 原生规则）；其余使该项目以 `session-version` 失败。日志逐字复制——不改写 cwd（头部的 `cwd` 指向导出机器的路径；分组与续跑跟随工作区记录，此限制在 README 中说明）。主会话先于其子代理恢复。媒体与文件经公开附件接口恢复：每个 `media/*` 条目走 `attachments.saveImage`，每个 `files/*` 条目走 `attachments.saveFileStream`，内容寻址复现原引用；每次保存后把返回的附件 id 与归档布局点名的 id 比对，不一致即以 `attachment-mismatch` 失败整个导入，而不是留下图片指向错误字节的会话。工作区以 `workspaceRegistry.create(path)` 登记（同路径已登记视为成功并计数），每个恢复的会话用 `attachSession` 挂接；登记失败保留已恢复的文件，在结果中报告为 `workspace-register-failed`，不回滚。归档携带 `settings.json` 时，其值作为任务的最后阶段应用，与下方设置应用器共享；按命名空间的失败只报告，不致命。

单飞守卫（在路由的 await 之后取守卫，同一 tick 的两个请求不可能同时通过）允许同时只有一个导入任务；并发导入以 409 `busy` 拒绝。进度为轮询快照：阶段 `validating → extracting → restoring → applying-settings → registering → done`，附字节、文件、会话、项目计数。完成的快照保留到下一次任务开始或十分钟后失效。插件 apply 时与每次导入前清扫超过 24 小时的 `.prism-import-*` 暂存残留；只删这个前缀。

### S2.5 设置项（配置项）导出与导入

独立设置导入是一条缓冲 JSON POST 路由，携带解析后的 `prism-settings` 内容；它与合并归档的阶段共享同一应用器。对文件里每个同时存在于当前 `describe()` 的命名空间，应用器从文件的易变投影构建补丁，经既有修订防护写入路径（`ctx.settings.update(ns, patch, expectedRevision)`）应用，冲突时重读一次修订再报告该命名空间失败。文件里有但当前不活跃的命名空间跳过并计数；当前活跃但文件里没有的命名空间不动。每个命名空间的结果（applied / skipped-inactive / failed 及原因）返回给客户端做逐项报告。secret 角色字段只在文件以 `includeSecrets: true` 导出时应用；没有它们的文件保持现有密钥不变。

### S2.6 安全与一致性

所有宿主工作都发生在插件自己的路由里，走既有客户端连接护栏——不新增 runner token 例外，不建 Typert 命名空间。导入永不覆盖：项目以新名发布、会话按 id 去重、设置按命名空间合并、附件按内容寻址合并。导出绝不跟随链接离开工作区文件夹、绝不含 ≥ 4 GiB 的文件、绝不导出凭据。zip 读取器把每个归档当敌意输入：由中央目录驱动解压（尺寸永不信任本地头）、逐条目 CRC 验证、上述名称与冲突守卫、硬性条目/大小上限。错误是类型化码值，客户端映射 zh/en 文案，宿主 `detail` 作回退；每条失败路径都清理暂存，`projects/` 下不会留下半发布目录。插件不注册任何模型可见内容：无提示、无工具、无会话事件。

### S2.7 宿主路由与任务模型

全部路由共用一个前缀，风格同 `prism-backup`：

| 方法 / 路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/prism.transfer/export` | 查询 `projects`、`settings`、`secrets` | 流式 zip 或 JSON 附件；id 非法 400，工作区未知 404 |
| `POST /api/prism.transfer/import` | 流式 octet-stream 主体，查询 `dest?` | `{ jobId }`；`bad-archive` 类错误码 400；409 `busy` |
| `GET /api/prism.transfer/job` | — | `{ state: 'idle' }` 或下方快照 |
| `POST /api/prism.transfer/settings` | 缓冲 JSON `prism-settings` 主体 | `{ results: [{ ns, outcome }] }`；400 `bad-settings` |

任务快照：`{ jobId, kind: 'project' | 'combined' | 'unknown', state: 'running' | 'done' | 'failed', phase, name, archiveBytes, files, bytes, sessionsDone, sessionsTotal, projectsDone, projectsTotal, duplicates, skippedLinks, skippedUnreadable, skippedSecrets, result?, error?, startedAt, finishedAt? }`（任务开始到清单分发之间 `kind` 为 `unknown`）。客户端只轮询自己拿到的 `jobId`，终态即停；服务端把未知或过期任务的轮询按 `idle` 处理（重启丢失进行中的任务；其暂存由清扫覆盖）。

### S2.8 设置页界面

分区在设置弹窗内容区渲染三张卡片，文案全部来自 `settings.transfer` 字典（zh 为键集的事实来源，en 为类型化镜像；导航标签 「导入导出」 / "Import & Export"）：

- **导出卡片** — 来自 `ctx.workspaces` 的工作区列表（标题、路径工具提示、会话数、每行复选框、全选），「包含配置项」复选框启用「包含密钥」复选框，主按钮「导出所选」（未选中时禁用；导出一个 zip——恰一个项目且不带设置时为单项目布局，否则为合并布局——经浏览器下载），次按钮「仅导出配置项」（JSON 下载）。行使用设置卡片填充别名并带可见 `:focus-visible` 描边；卡片注明归档包含项目文件夹与其会话，密钥除非显式包含否则不导出。
- **导入卡片** — 「选择压缩包…」打开文件输入（`.zip`），展示所选文件名与大小；目的地行显示生效根（默认 `~/.prism/projects`），具备原生能力时附「更改…」按钮调 `remote.directoryPicker.pick()`（纯 web 部署没有该按钮，保持默认值）；「导入」按钮 POST 文件并开始轮询。任务运行时卡片显示阶段文本、带字节/会话计数的确定进度条与 `aria-busy`；终态渲染逐项目结果（名称、会话数、重复数）或带 zh/en 文案的类型化错误，运行中 `role="status"`、失败 `role="alert"`。进度动画尊重 `prefers-reduced-motion`。
- **说明行** — 永不覆盖规则与会话不改写限制，各一行。

### S2.9 复用清单

复用（含一处扩宽）：传输写入器需要 `session-log-export` 的流式助手（`ResponseCapacityGate`、`pushArtifactChunks`、`pushBinaryChunks`、`pushStreamChunks`）导出，这是带标记的 fork 改动并记入分歧索引；会话条目生产者（`sessionLogZipEntries` + `sessionLogExportDeps` + `flushLiveSessionLog` + `SESSION_LOG_FILENAME`）本就是公开的、`prism-session-import` 的 `sessionPersistence` create/append/flush/close 句柄配方与 `sessionProjectionCache` 检查点、`workspaceRegistry` create/resolveByPath/attachSession、`ctx.settings.describe/update` + 易变/密钥 schema 遍历、客户端 `ctx.workspaces` 列表、`remote.directoryPicker.pick`、`connection.fetch.register` 流式与缓冲路由、`fflate` Zip 写入、设置卡片 CSS 别名、locale 字典模式。新代码：zip 读取器（中央目录 + CRC + 守卫）、导出扫描与组装、导入任务状态机、设置应用器、分区界面。

### S2.10 被否决的方案

- **原生打开/保存文件对话框（新建宿主文件选择接缝）** — 流式路由加浏览器下载已经能搬任意大小的文件；新建宿主能力接缝会增加包与 remote 动词，却换不来 web 到不了的能力。否决。
- **浏览器端解压** — 本应用的架构里浏览器从不触碰文件系统，且客户端解压会把宿主反正要重跑的每道守卫复制一遍。否决。
- **导入时改写会话 `cwd`** — 会话日志首帧必须原样成立；为把 `cwd` 指向恢复后的路径而做日志手术有损坏风险，而分组并不依赖该值。日志保持逐字复制，限制写入文档。否决。
- **按目录复制恢复附件（session-import 的 `copyAttachments`）** — 那会复制存储的内部布局，把插件耦合到 `attachment-local` 内部；公开的 `saveImage`/`saveFileStream` 接口加返回 id 校验，在接缝合约之内得到同样的内容寻址结果。否决。
- **只做一种归档格式** — 用户明确要单项目分享与整集传输两种形态；合并布局内嵌完整的单项目子树，导入端把一种布局校验两遍即可，不必维护两种布局。
- **在 `prism-backup` 上扩展导入/恢复** — 备份面向远程存储且不含会话；传输面向文件且携带会话。合约不同，包不同。

## [S3] 范围

- 范围内：
  - `@prism/prism-transfer` 宿主插件：zip 读取器、导出引擎、导入引擎、设置应用器、四条路由、任务模型、暂存清扫。
  - 客户端插件：`settings.section` 槽 `transfer`，导出 / 导入卡片、字典（zh/en）、进度与错误状态、无障碍。
  - 归档格式 v1（`prism-project`、`prism-transfer`、`prism-settings`），清单校验与 CRC 验证解压。
  - 会话恢复：去重、子代理、媒体/文件恢复带 id 校验、投影检查点、工作区登记。
  - 设置导出（易变投影、密钥可选）与按命名空间导入带报告。
  - 核心 `navIcon` 分支 + 分歧标记/索引行（A14）（A14）；包 README 三件套 + 分组 README 三件套；product-package-policy 行；web-app 组装行；目录再生成。
  - 包级单测达到仓库的逐文件 100% 覆盖门槛。
- 范围外：
  - 运行中导入的取消/暂停/续跑；并行任务。
  - 加密或口令保护的归档；tar/7z 格式；无清单的外来 zip。
  - 导出未登记路径、单个会话、或一个项目的会话清单而不带其文件夹。
  - 会话日志改写（cwd 或其他）；导入时的会话格式迁移。
  - 拖拽导入；导入后自动打开；CLI 入口；云上传（prism-backup 的领域）。

## Tasks

- [x] T1: zip 读取模块——EOCD/ZIP64 中央目录解析、逐条目 CRC32 验证、条目名守卫、重复/大小写/NFC 冲突检测、祖先冲突、条目数与大小上限；用构造归档单测覆盖每道守卫（`../`、绝对路径、反斜杠、ADS 冒号、重复条目含大小写/Unicode 折叠、两种顺序的祖先冲突、CRC 损坏、中央目录截断、超上限条目）。(depends: none)
- [x] T2: 导出引擎——工作区文件夹扫描带守卫（≥4 GiB、`\`/NUL 名称、链接/不可读跳过 + 计数）、清单生成、`project/**` 组装、每会话 `sessionLogZipEntries` 重根到 `sessions/<id>/`、单项目与合并布局选择、设置 JSON 投影（易变字段、密钥可选）、流式 fflate 写入；用临时目录与假依赖单测。(depends: T1)
- [x] T3: 导入引擎——落盘缓存、清单分发（project / combined / 拒绝）、CRC 暂存解压、空间守卫、清洗命名与 ` (n)` 冲突、会话恢复配方带去重 + 版本规则 + 投影检查点、附件恢复带返回 id 验证、工作区登记 + 挂接、设置应用阶段；任务状态机带 await 后单飞、快照、保留期、暂存清扫；每条路径与失败的单测。(depends: T1)
- [x] T4: 设置应用器独立单元（T3 的阶段与独立路由共用）——易变补丁构建、修订防护更新带一次冲突重试、逐命名空间结果；单测。(depends: none)
- [x] T5: 路由与接线——`/api/prism.transfer` 下四条路由、流式导入落盘、导出查询校验、错误码映射表、插件 `apply()` 注册（connection.fetch.register）、`packages/bundle/web-app/cordis.patch.yml` 组装行、package.json（`./client` 导出 + `dsh.client` 清单）、product-package-policy 行；假服务路由测试（busy/409、400、轮询语义、重启 idle）。(depends: T2, T3, T4)
- [x] T6: 客户端分区——`src/client/index.ts`（inject 列表、`LocaleNamespaceMap` 合并、`slots.inject('settings.section', …)`）、`locales.ts` zh/en、`TransferSection.tsx` 三卡片、文件输入 + 流式 POST、目的地行带原生选择回退、轮询进度 + 结果/错误渲染、无障碍状态；纯函数测试（布局检测辅助、错误文案映射）。(depends: T5)
- [x] T7: 核心与文档——`navIcon()` 的 `'transfer'` 分支带 `PRISM-DIVERGENCE` 标记、分歧索引 A14 分区行、`packages/transfer/README` 三件套 + 包 README 三件套带生成的 `.i18n.yaml` 记录、spec 三件套配对记录、目录再生成（`gen-plugin-packages`、`gen-client-catalog`）；运行受影响文档门。(depends: T6)
- [x] T8: 验证与复审——包 vitest 运行达逐文件 100% 覆盖、typecheck 宿主与客户端面、`build:artifacts` + `build:check`、受影响文档门、i18n 门；证据记入 spec；按 compose 流程独立复审；修复后复验。(depends: T7)

## [S4] 验收

- [x] 设置侧边栏在 backup/import 之后显示「导入导出」；全新 profile 下分区渲染出工作区列表、两张卡片与默认目的地 `~/.prism/projects`。
- [x] 导出单个项目（不带设置）下载 `<标题>.zip`；在文件管理器打开可见 `.prism-project.json` 在前、`project/**`、`sessions/**`；导出多个项目下载一个合并 zip，其 `projects/*` 子目录各带自己的清单；「仅导出配置项」下载可读的 `prism-settings-*.json`。
- [x] 往返（临时 home 导出 → 清空 → 导入）恢复逐字节一致的项目文件夹、每个会话（主 + 子代理）带标题出现在侧边栏、图片与文件再次可用、工作区登记一次（重复导入不产生重复登记；再导同一归档报告重复且不恢复两次）。
- [x] 目的地已有同名项目时以 `<标题> (2)` 发布且不动原目录；带 `settings.json` 的合并导入按命名空间应用设置并报告 applied/skipped/failed。
- [x] 敌意归档（T1 每种守卫用例，外加无清单 zip、`prism-project` version 2 清单、CRC 被篡改的 stored 媒体条目）都以映射的错误码失败、不留暂存目录、目的地之下毫无变化。
- [x] 含 ≥ 4 GiB 文件的项目在下载开始前导出失败并点名文件；符号链接与不可读文件被跳过并计数，结果在客户端可见。
- [x] 不勾「包含密钥」的设置导出不含任何 secret 角色值并报告跳过数量；勾选后在第二个 profile 导入可复现导出值（经 `describe()` 验证），新安装缺失的命名空间报告 skipped。
- [x] 同一 tick 提交的两个导入只产生一个任务（另一个 409）；轮询未知/过期任务返回 idle；中途杀掉只留一个 `.prism-import-*` 目录，超过 24 小时后由下次导入或重启清扫。
- [x] 分区文案全部字典持有（zh/en），导航图标渲染，每个新控件焦点描边可见，运行/失败态用 `role="status"`/`role="alert"`，reduced-motion 下无进度动画；`verify-client-ui-i18n` 通过。
- [x] `pnpm vitest run packages/transfer/prism-transfer` 对每个 `src` 文件 100% 覆盖；`tsc` 宿主与客户端面通过；`build:artifacts` + `build:check` 通过；受影响文档门（readme summaries/model-experience/limitations、translation pairing、md wrap/links、workspace constraints、product isolation、application entrypoints、plugin/client catalogs）通过；与 master 相同的 PRE-EXISTING 失败如实记录。
