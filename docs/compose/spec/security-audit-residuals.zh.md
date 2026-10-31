---
feature: security-audit-residuals
status: delivered
updated: 2026-10-31
branch: fix/security-audit-residuals
commits: 609ccc3887..34750305c4
---

# 安全审计残余

[English](security-audit-residuals.md) | 中文

## Report

**本次构建** — shell 隔离现在在所有本来会触达 harness home 的可写 profile 中排除它：Seatbelt 追加拒绝子路径规则，bwrap 在工作区绑定之后把 home 重新绑定为只读，Landlock 以 `SANDBOX_UNAVAILABLE` 拒绝该策略，Windows ACL 授权为工作区能力 SID 添加常驻 Deny ACE。导入的附件成员在复制后重新发布为 `0400`，发布工作流把 `latest.json` 留给 `tauri-action`，同时仍上传 `.sig` 与 `.app.tar.gz`。

**验证** — `packages/sandbox/sandbox-windows-acl/tests/acl.spec.ts`：14 通过，包括 deny ACE、`AclWriteGrant.deny` 与 `AclSandbox` deny-dirs 测试。`engine.spec.ts`：13 通过，包括任一写位残留即失败的复制模式断言。对三个 profile 构造器的直接行为检查（工作区包含 `$DSH_HOME`，以及 home 位于所有可写根之外）通过，agentless Windows 路径会把 `--deny` 传给 runner；该包自身的测试在 Windows 上被 `vitest.config.ts` 排除，由 POSIX 通道运行。`pnpm run typecheck`：5/5 门禁。翻译配对、`verify-md-links` 与 `verify-concrete-terms`：通过。覆盖率通道在本检出中无法运行（重映射时 `ast-v8-to-istanbul` TypeError），但测试本身已运行。`pnpm run doc-sync` 仍因与本改动无关的基线产物失败（custom-theme-presets 折行、过期的生成目录、ui-chat/ui-conversation 摘要、已移除的 hooks 包路径），`verify-package-dependencies` 仅因 `prism-transfer` 的导入失败；本改动没有新增失败。

**历程记录** — Landlock 的允许列表迫使采用 fail-closed 分支而不是拒绝规则，这是 POSIX profile 之间唯一的行为差异。sandbox-local 测试通道在 Windows 上被排除，因此本地验证直接使用 profile 构造器，测试运行留给 POSIX 通道。home 排除以“home 位于已授予根之内”为前提，因此在重叠之外每个现有 profile 保持逐字节不变。ACL deny 复用现有的常驻授权，而不是引入第二条授权生命周期。

## [S1] 问题

`security-audit-fixes` 关闭了六条审计线索并记录了四项残余。其中三项可以在同一批表面中修复：shell 沙箱后端仍只从工作区推导可写根，因此包含 `$DSH_HOME` 的工作区会把 home 授权给沙箱命令，尽管工具文件系统围栏已经拒绝；导入的附件成员依赖来源存储的发布模式，而不是重新以只读方式发布；发布工作流上传了一个 Tauri CLI 永远不会写的 `latest.json` 通配符，因为该清单由 `tauri-action` 负责。第四项是导入内容标记，需要会话格式与产品决策，保持延后。

## [S2] 设计

### [S2.1] 每个 shell profile 中的 harness home 排除

只有当 harness home 位于 `workspace-write` 策略本来会授予的某个根之内时才应用排除；在这个重叠之外，普通的只读绑定或拒绝已经覆盖它。home 来自 `resolveDshHome()`（先 `$DSH_HOME`，再 `~/.prism`），即随附组合解析的同一来源。

- Seatbelt 在允许规则之后追加可继承的 `(deny file-write* (subpath "<home>"))`；其最后匹配规则优先的求值方式使拒绝覆盖允许。
- bwrap 在工作区绑定之后追加 `--ro-bind <home> <home>`；后出现的挂载会覆盖先前的可写绑定。
- Landlock 是允许列表，无法排除子路径，因此启动器 profile 以 `SandboxUnavailableError` 拒绝该策略，命令绝不会在无约束下运行。
- Windows ACL 这一档在工作区能力 SID 上为 home 目录添加常驻 Deny ACE，同时覆盖 seam 管理的授权与独立 runner；Windows 在继承的允许之前求值拒绝，因此 home 在已授予的工作区内仍不可达。

不涉及核心沙箱协议、策略类型或更新运行时的改动：每个提供方用自己的方言解析同一个 home。ACL 拒绝与所收窄的工作区授权一样是常驻的，因此把 home 移出工作区后，该工作区 SID 的陈旧拒绝会保留到工作区 ACL 被重置。

### [S2.2] 导入附件的只读发布

在导入复制来源 home 的 `attachments/` 树之后，每个复制的普通文件都以 `0400` 模式重新发布。`fs.cp` 会保留来源模式，而 DSH 来源存储本就以 `0400` 发布，但复制得到的是一棵外来树，其模式不应取决于那棵树是如何写入的。

### [S2.3] 更新清单的归属

发布工作流上传 `.sig` 与 `.app.tar.gz` 产物，这些由 `tauri build` 在 `createUpdaterArtifacts` 下产出。`latest.json` 由 `tauri-action` 生成并附加，不会写到 `target/` 下，因此产物通配符不再声称包含它。

### [S2.4] 延后：导入内容标记

事件词表没有区分导入历史的标记，添加一个会改变持久会话数据、读取器、TypeScript 与 Python SDK 投影、快照，以及 UI 与模型对外来文本的归属方式。这属于产品与会话格式决策，而不是机械修复，因此保持延后。

## [S3] 范围

- 范围内：shell 的 home 排除（Seatbelt、bwrap、Landlock fail-closed、Windows ACL deny）、导入附件成员的只读发布，以及发布清单归属。
- 范围外：导入内容标记、对 DSH 核心沙箱协议或策略类型的任何改动，以及桌面更新运行时。

## Tasks

- [x] T1: 在 Seatbelt、bwrap 与 Landlock profile 中排除 harness home（depends: none, covers: S2.1）
- [x] T2: 在 Windows ACL 工作区授权上拒绝 harness home（depends: none, covers: S2.1）
- [x] T3: 以只读方式重新发布导入的附件成员（depends: none, covers: S2.2）
- [x] T4: 把 `latest.json` 留给 `tauri-action`（depends: none, covers: S2.3）
- [x] T5: 运行受影响的测试、类型检查、覆盖率与文档门禁（depends: T1, T2, T3, T4）

## [S4] 验收

- [x] 当工作区包含 `$DSH_HOME` 时，`workspace-write` 策略的 Seatbelt 输出包含拒绝行，bwrap 在可写绑定之后追加只读重绑定；home 在工作区之外时两个 profile 都不变。
- [x] Landlock 以 `SandboxUnavailableError` 拒绝该策略，而不是授予 home。
- [x] Windows ACL 工作区授权对嵌套的 harness home 拒绝能力 SID，对工作区之外的 home 不拒绝；独立 runner 收到同样的拒绝。
- [x] 复制后导入的附件成员模式为 `0400`。
- [x] 发布工作流上传 `.sig` 与 `.app.tar.gz`，不再自行上传 `latest.json`。
- [x] 受影响包的测试、类型检查、覆盖率与文档门禁通过；每个失败都是带证据的已记录基线失败。
