---
feature: guardrails-hardening
status: delivered
updated: 2026-11-01
branch: feat/guardrails-hardening
commits: c22ec9f0b9..4c3d69444f
---

# Guardrails 加固

[English](guardrails-hardening.md) | 中文

## Report

**做了什么** —— 给 `prism-guardrails` 增加三件事。敏感读取 rail 拒绝路径上带配置凭据段的读取（`.env`、`.ssh`、`.aws`、`.gnupg`、`.npmrc`、`id_rsa`、`id_ed25519`），并在拒绝文案里给出路径、命中的段与替代做法；它选择拒绝而不是询问，因为内容一旦读取就会永久留在会话日志里。命令守卫把命中配置正则的 shell 命令送交审批，附带模式与部署给出的理由；它选择询问而不是拒绝，因为删除构建目录有时正是想要的动作用。`/guardrails` 报告十二条 rail 及其配置值，注册方式为 `ctx.inject(['commands'])`，因此命令运行时晚于本 bundle 挂载时报告依然出现。

**验证** —— `npx vitest run tests/prism-guardrails.spec.ts tests/ponytail.spec.ts` 通过 141（123 + 18）；`npm run typecheck` 通过；`npm run build` 通过；`npm run smoke` 通过；`npx vitest run tests/capability.e2e.spec.ts` 在真实 headless profile 下 4/4 通过。

**过程记录** —— 评审发现随附的 `credentials` 段（按路径段匹配）会连带拒绝本仓库自己的 `packages/credentials/***` 与 `docs/subsystems/credentials.md`；`.aws` 已经覆盖了该段想拦的文件，因此删掉它，并用回归测试钉住两条路径可读。同一次评审还发现状态命令在 apply 时只读一次 `ctx.get('commands')`，命令运行时晚挂载就会静默丢失；改为 `ctx.inject`，并加一条"晚挂载"测试固定顺序。另外，worktree 里的 e2e 连续两轮零会话事件才发现原因：`tsc -b` 只产出声明，profile 需要的是 `pnpm run build:lib:host` 产出的 tsdown 宿主包。

## [S1] 问题

`prism-guardrails` 的每条 rail 都只按工具名、参数字段与会话日志判断。没有任何东西读 shell 命令文本，也没有任何东西看守读取。由此有两个后果：

- `git push --force`、`git reset --hard`、`rm -rf` 无人看守。DSH 沙箱覆盖不到它们：`SandboxMode` 管的是文件效果，网络与进程策略不在它的词表里（`packages/sandbox/sandbox-policy/README.md:147`）。`bash` 与 `pwsh` 正因同样理由被计划模式 rail 刻意排除（`plugins/prism-guardrails/README.md:121`）。
- `read`、`read_image`、`grep` 被路由契约列为只读工具，因此 `~/.ssh/id_rsa`、`.env`、`~/.aws/credentials` 对任何调用都可读。读取会永久落进会话日志，暴露时间超过该轮次。

第三个缺口是运维层面的：每条 rail 在键给出取值之前都是关闭的，而没有任何东西报告一个运行中的部署实际启用了哪些 rail。运维者无法区分"已加固的会话"与"未配置的会话"。

先例：`cc-safety-net`（kenryu42）正是前两项检查，外加一个 GUI 与一次自检。它的 shell 解析不在本次范围内——本 bundle 提供文本黑名单，并记录这个上限。

## [S2] 设计

### S2.1 敏感读取拒绝

两个键，与既有的 `writeTools` 形状对称：

```ts ignore-check
readonly readTools?: readonly ReadTool[]        // { tool, pathArgument }
readonly sensitivePaths?: readonly string[]
```

对配置的读工具发起调用、且其路径参数写出的路径包含配置的路径段时，该调用被拒绝。路径段的匹配条件是：忽略大小写地等于某个配置名，或以"配置名 + `.`"开头，因此 `.env.local` 命中 `.env`，而 `environment.ts` 不会。

随附默认值声明 `read`（`file_path`）、`read_image`（`file_path`）与 `grep`（`path`）——DeepSeek Harness 中三个按路径读取的工具。`credentials` 刻意不在段列表中：匹配是按路径段进行的，它会连带拒绝本仓库自己的 `packages/credentials/…` 与 `docs/subsystems/credentials.md`，而它想拦的那个文件已经由 `.aws` 覆盖。

判定是 `deny` 而不是 `ask`。读取凭据会把它写进会话日志，之后再怎么批准也删不掉；而真正有用的替代做法根本不需要文件内容。拒绝文案给出路径、命中的段与替代做法：

```
Error: `read` targets "/home/u/.ssh/id_rsa", which this deployment treats as credential material (matched ".ssh"); reading it would write the secret into the session log permanently. Ask the user for the specific value if it is needed.
```

### S2.2 危险命令拒绝

一个键同时承载两半：

```ts ignore-check
readonly commandGuard?: {
  readonly tools: readonly { tool: string; commandArgument: string }[]
  readonly deny: readonly { pattern: string; reason: string }[]
}
```

每个模式在加载期编译，忽略大小写地匹配原始命令文本。命中返回 `ask` 而不是 `deny`：删掉构建目录或强推个人分支有时正是想要的动作用，只有人能把它和事故区分开。没有审批通道时，注册表的 fail-closed 阶梯会拒绝该调用，这正是无人值守时的预期结果——与重复调用 rail 的理由相同。

审批理由给出命中的模式与配置的理由：

```
`bash` would run a command this deployment guards (matches `git\s+push\b[^\n]*(\s--force\b|\s-f\b)`): rewrites a remote branch history others may already have; approve only if the rewrite is intended
```

`shortcut:` 文本黑名单，而不是 shell 解析器：因为文本在场，`bash -c "git push --force"` 仍会命中，但引号或变量技巧可以绕过。等有消费者需要"包装必然命中"时再升级为解析器。

### S2.3 状态命令

`/guardrails` 根据解析后的配置打印该部署启用了哪些 rail：

```
Guardrails: 4 of 12 rails armed.
plan-mode denial: write, edit, str_replace_editor
...
command guard: 2 tool(s), 3 pattern(s)
```

注册方式为 `ctx.inject(['commands'])`，因此命令运行时晚于本 bundle 挂载时报告仍会出现；没有 `commands` 服务的部署保有全部 rail，只失去这份报告。

### S2.4 配置校验

每个新键都遵循本包既有规则：存在但不可用则插件加载失败，省略即关闭该 rail，文案点名出错的键。跨字段规则与既有规则一致——读路径的 rail 自身不掌握任何工具知识，因此只给 `sensitivePaths` 而不给 `readTools` 会在加载期失败。

### S2.5 文档

`README.md` 与 `README.zh.md` 保持成对：rail 总数、配置表、加载期拒绝表、每条新 rail 一节，以及已知限制（工作区内的 `rm -rf` 是正当动作，如今每次都要一次审批；文本模式可被绕过；路径段匹配也会挡住 `id_rsa.pub`）。

## [S3] 范围

- 范围内：`plugins/prism-guardrails` —— `src/config.ts`、`src/index.ts`、测试、两份 README、`cordis.patch.yml`。
- 范围外：shell 解析器、规则包、GUI、预设、跨宿主打包，以及对 `packages/` 的任何改动。

## Tasks

- [x] T1: `config.ts` —— `readTools`、`sensitivePaths`、`commandGuard` 字段、解析与加载期拒绝（depends: none）
- [x] T2: `index.ts` —— 敏感读取 rail（depends: T1）
- [x] T3: `index.ts` —— 命令守卫 rail（depends: T1）
- [x] T4: `index.ts` —— `/guardrails` 状态命令（depends: T1）
- [x] T5: 测试 —— 配置校验、两条 rail 的端到端行为、状态文案（depends: T2, T3, T4）
- [x] T6: 文档与随附默认值 —— 两份 README 与 `cordis.patch.yml`（depends: T5）
- [x] T7: 验证 —— typecheck、单元套件、build、smoke（depends: T6）

## [S4] 验收

- [x] 通过配置的读工具读取 `.env`、`~/.ssh/id_rsa` 或 `~/.aws/credentials` 被拒绝，并点出命中的段，工具没有被执行。
- [x] 读取 `environment.ts`、`src/index.ts` 或任何不含配置段的路径不受影响。
- [x] 文本命中配置模式的 `bash` 调用返回 `ask`，并带上模式与理由；不命中的命令照常执行。
- [x] 无法编译的 `commandGuard.deny` 模式、空的 `sensitivePaths`、以及没有 `readTools` 的 `sensitivePaths` 都会让插件加载失败，且文案点名出错的键。
- [x] `/guardrails` 报告每条 rail 的状态；没有 `commands` 服务的部署照常加载并强制执行。
- [x] `npm run typecheck`、两个单元套件、`npm run build` 与 `npm run smoke` 全部通过。
