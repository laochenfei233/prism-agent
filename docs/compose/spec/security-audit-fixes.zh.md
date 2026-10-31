---
feature: security-audit-fixes
status: delivered
updated: 2026-10-31
branch: fix/security-audit-run1
commits: 724259145a..814654e53d
---

# 安全审计修复

[English](security-audit-fixes.md) | 中文

## Report

**本次构建** — 模型的文件系统写入与编辑在 `workspace-write` 下拒绝 harness home 之下的任何目标，读取与经批准的 `danger-full-access` 重试仍然可用，因此被提示注入的写入无法再触达 `!!js` 补丁层或已安装的 bundle 源码。原生会话导入在写入任何内容之前，用存储读取器自身的事件语法校验外来日志，因此未知必需类型或已退役结构会使该行失败，而不会创建无法打开的会话。已存图像的读取会重新检查配置的字节、像素与尺寸限制，因此由导入复制进来的附件对象无法进入超出准入的解码。

发布构建现在会收到文档中记载的更新签名密钥，并上传 `.sig`、`latest.json` 与 `.app.tar.gz`；静态服务器认证每个 HTML 入口，包括 worker 预览；桌面弹窗兜底在 `cmd /C start` 之前拒绝 cmd 元字符。

[S2] 与 [S3] 记录的限制：shell 沙箱后端仍只从工作区推导可写根；附件复制仍跳过分阶段发布模式（由摘要与读取限制约束）；导入事件没有来源标记；`latest.json` 的上传位置仍需一次真实发布运行确认。

**验证** — 对四个受影响测试文件运行 `pnpm exec vitest run`：54 通过。完整 `attachment-local` 套件加 host `session-import` 测试：123 通过、1 跳过。`pnpm run typecheck`：5/5 门禁通过。`cargo test --lib`：评审轮之前 30 通过；定向 `cargo test --lib cmd_start`：3 通过，其中包括直接调用 `open_with_os` 的拒绝测试。命名翻译配对一致；全仓检查属于 `doc-sync`。`verify-md-wrap` 与 `verify-md-links`：通过。`verify-package-dependencies`：修复前运行恰好报告两个未分类导入，策略现已分类读取器校验函数；完整复跑在本工作区的 tsx/esbuild 环境中挂起，因此不声称已绿色复跑。全仓 `pnpm run lint` 在未触碰的基线文件上为红（已在主检出中的两个未修改文件上验证）；只对改动过的 TypeScript 路径运行 lint 报告 0 错误。客户端 `ImportSection` 测试仅在本工作区的本地 hoisted 安装下失败，在未修改的检出中通过；没有客户端代码改动。

**历程记录** — 审计中的读取器有两个独立拒绝点；第一次修复只镜像了词表那一个，评审发现了已退役的 `request/header` 结构，因此导入现在委托给 `validateStoredEvents`，而不是复述语法。新工作区的 pnpm junction 会破坏 Node ESM 解析，因此验证使用了本地 hoisted 安装（未提交），该安装的 jsdom/React 缺口解释了仅客户端失败。读取时附件限制改变了文档中“收紧限制仍可读取历史”的承诺；README 现已说明新行为。shell 后端仍在此围栏之外，因为关闭它需要在每种方言中加入拒绝规则。

## [S1] 问题

`security-audit-skill/prism-agent/run-1` 以仅源码策略审计了提交 `724259145a`，因此其六条线索都不是已确认漏洞。每条线索仍然描述了一个真实的跨越：内容随一个受信任的载体到达，而消费方却假定载体本身可信：

1. 模型的文件系统写入可以触达 `$DSH_HOME/cordis.patch.yml`，宿主机通过 loader 的 `!!js` 方言实时求值该文件。
2. 一个收到的 DSH 格式目录被原样追加为会话事件；读取器随后以错误的“更新的 harness”原因拒绝未知事件类型，且该导入无法修复。
3. 导入的附件对象绕过准入直接进入活动存储，随后参与图像重编码。
4. 没有任何已提交的工作流映射 `apps/desktop/README.md` 所记载的更新签名密钥，上传通配符也漏掉更新产物。
5. 未认证的 `/preview.html` 会启动一个以 owner Peer 身份应答的 worker 隧道。
6. 桌面弹窗兜底把来自网页内容的 URL 交给 `cmd /C start`，其中的元字符会拆开命令。

## [S2] 设计

### [S2.1] 工具文件系统写入的 harness home 围栏

当每次调用的模式为 `workspace-write` 时，沙箱化文件系统后端拒绝任何规范化目标位于 harness home 之下的写入与编辑。home 在实例构造时通过 `resolveDshHome()`（先 `$DSH_HOME`，再 `~/.prism`）解析一次，与 `app-boot` 暴露为 `dshHomePath` 以及所有以 home 为根的存储所用的解析一致。拒绝使用 `FS_SANDBOX_DENIED`，因此模型看到标准的 `[sandbox: …]` 标记并可请求更宽模式；经批准的 `danger-full-access` 调用在围栏之前返回，这正是围栏其余部分使用的所有者同意逃生口。经围栏的读取不变。

这关闭了模型工具进入组合消费文件的路径：home 补丁、profile 补丁，以及 loader 导入、HMR 监听器重载的 `$DSH_HOME/node_modules` 下的 bundle 源码。

shell 后端保留各自的授权拼写，仍仅从工作区推导可写根，因此在包含 `$DSH_HOME` 的工作区中运行的沙箱命令仍然可以写入该处。关闭它需要在每种方言中加入拒绝规则（Landlock 根本无法表达子路径排除），属于另一项改动；本次审计追踪的是工具文件系统路径，该路径现已加上围栏。

### [S2.2] 原生导入写入前的外来记录校验

`SessionImportEngine.writeNative` 在创建会话之前，用存储读取器自身的 `validateStoredEvents` 校验外来日志：未知的必需类型、已退役的 `request/header` 兜底结构或无效信封都会使该行失败，并且不写入任何内容。被拒绝的日志成为带读取器原因的 `failed` 导入行，因此不会产生损坏的会话、不会存入错误的拒绝原因，重复检查也无法阻止后续修复。

归属信息保持不变：导入事件仍携带来源的 provider 与 model，正如归一化路径把外来用户文本标记为 `source.kind: 'user'`。事件词表在任何路径上都没有导入内容来源标记，因此保留外来归属是否需要该标记属于产品决策，在此记录为延后。

### [S2.3] 读取已存图像时执行准入限制

`LocalAttachmentStore.readImage` 在返回字节之前，用存储的准入限制重新校验已验证的引用：编码字节数、总像素数与每边尺寸，顺序与准入一致。已验证的引用已与存储头的媒体类型匹配，因此无需单独检查类型成员资格。包括 `readImageRequest` 在内的每个消费方都通过该方法读取图像，后者也从同一批已验证字节重编码。因此，由导入复制进存储的外来附件对象不再能把超出配置像素与尺寸上限的解码图像送进 sharp 或提供方请求。

复制仍然跳过分阶段的 `0400` 发布；该模式并不是所有者私有存储中保护字节的东西，因为每次读取都会重新校验摘要与引用字段。字节与元数据才是权威，文件模式不是。

### [S2.4] 发布工作流中的更新签名

`desktop-release.yml` 把 `secrets.TAURI_SIGNING_PRIVATE_KEY` 与 `secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 映射进 `tauri-action` 步骤和 macOS 的 `pnpm tauri build` 步骤，产物上传通配符在两种 bundle 拼写下都包含 `.sig`、`latest.json` 与 `.app.tar.gz`。这与 `apps/desktop/README.md` 已记载的发布前提一致；仓库 secret 及其保管仍属账户状态。

### [S2.5] 每个 HTML 入口的认证

`serveStatic` 把每个 `.html` 目标送入浏览器认证检查：dist 根与配置的 index 仍通过 index 注入渲染，构建产出的任何额外页面（包括 `preview.html`）只提供给已认证浏览器。非 HTML 资源按设计保持公开，因为已认证页面加载它们时不会每次请求都走一遍 cookie。未认证的预览请求现在收到与 index 相同的 401 响应体，因此 owner Peer 的 worker 隧道无法从未认证的 peer 启动。

### [S2.6] 桌面弹窗兜底中的元字符拒绝

Windows 上的 `open_with_os` 在构造 `cmd /C start` argv 之前拒绝包含空白、控制字符或 `& | < > ^ % " ( ) !` 中任一字符的 URL；opener 插件仍是主路径，macOS 与 Linux 不变。被拒绝的 URL 通过既有的 `opened=false` 日志行报告，而不是启动第二条命令。

## [S3] 范围

- 范围内：上述六条线索，每条只做移除该跨越的最小改动，并配一个聚焦测试。
- 范围外：shell 沙箱的 home 排除、导入内容来源标记、附件复制的发布模式、发布 secret 的账户状态部分，以及审计第 6 节中的其余加固说明。

## Tasks

- [x] T1: 在 `fs-sandbox` 中拒绝 harness home 下的工具写入，并补充覆盖（depends: none, covers: S2.1）
- [x] T2: 原生导入写入前校验外来事件（depends: none, covers: S2.2）
- [x] T3: 读取已存图像时执行准入限制（depends: none, covers: S2.3）
- [x] T4: 映射更新签名密钥并上传更新产物（depends: none, covers: S2.4）
- [x] T5: 在 `frontend-static` 中认证每个 HTML 入口（depends: none, covers: S2.5）
- [x] T6: 在弹窗兜底中拒绝 cmd 元字符（depends: none, covers: S2.6）
- [x] T7: 运行受影响的测试、类型检查与 lint（depends: T1, T2, T3, T4, T5, T6）
- [x] T8: 在本文档中记录交付证据（depends: T7）

## [S4] 验收

- [x] `workspace-write` 下对 `$DSH_HOME` 的写入与编辑以 `FS_SANDBOX_DENIED` 拒绝，不创建文件，`danger-full-access` 调用仍可写入。
- [x] 携带未知必需事件类型的日志经原生导入返回 `failed` 行且不创建会话；已知日志仍可原生导入。
- [x] `readImage` 对超过配置字节、像素或尺寸上限的已存图像以准入错误码拒绝，对已准入图像仍正常返回。
- [x] 发布工作流把签名密钥传给两个构建步骤，并上传 `.sig`、`latest.json` 与 `.app.tar.gz`。
- [x] 未认证的 `/preview.html` 请求收到 index 的 401 响应，已认证请求正常返回页面。
- [x] Windows 上 `open_with_os` 拒绝带 shell 元字符的 URL，并接受普通 `https` URL。
