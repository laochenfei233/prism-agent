---
feature: prism-team
status: delivered
updated: 2026-11-04
branch: feat/prism-team
commits: 50ff54bd96..933c30fa6a
---

# Prism Team

## Report

**What was built** — `plugins/prism-team`，一个 Host-only 出树插件，把四条能力装进实验性 Agent Teams 而不改动 `packages/**`：`team_report` 工具把 teammate 的进展变成一条结构化消息送进 Lead 收件箱并记入插件台账；`/team` 把 `blocked/failed/ready/waiting` 排在 `progress` 之前、健康时只输出一行；每个 teammate 在创建时拿到自己的 `git worktree` 与分支 `team/<team>/<name>`，路径写进它的段落；`tools/pre-execute` 上的写入门闸按该成员已认领任务的 `writeScopes` 判定，范围外默认 `ask`、`observe` 下只记录。装载走 `agent/created` + `ctx.agentTeams.tryMembership`，非团队成员零行为。

**Verification** — `tsc -p tsconfig.verify.json --noEmit`（借主 checkout 的已构建声明）exit 0；`vitest run --config vitest.config.ts` 16/16 通过，其中 worktree 用例在临时 git 仓库里断言两个 teammate 拿到不同路径与分支、Lead 没有 worktree、`git worktree list` 承认两者；`tsdown` 构建产出 `lib/index.js` 16.78 kB；`oxlint`（staged）0 warning 0 error；`git diff --cached --check` 干净。`capability.e2e.spec.ts` 未跑：它自己的脚本是 `npm run build && …`，本次没有产出仓库级构建。

**Journey log** —

- compose 一开始写在团队插件里，验证时确认「skill 变插件」是通用能力而非团队专属，于是移到 `prism-guardrails/src/compose.ts`；否则同一件事会有两个家，且 solo 会话拿不到。
- 首版测试把假 Agent 的 `ctx` 指到根上下文，两个成员注册同名 section/工具立刻冲突；改成 `createScope` 铸出的作用域 + 真 `Session`，`/team` 的日志写入也才成立。
- worktree 只能劝告：会话 cwd 在创建时就固定，团队包不提供逐成员目录，所以成员必须用绝对路径；这条写进 README 而不是藏起来。

## [S1] Problem

实验性 Agent Teams（`packages/experimental/agent-team` + `tool-agent-team`）给了 Lead 与具名 teammate、点对点消息和一个持久任务板，但它自己列出的四条限制，正好是 dsh-superagent-prototype 已经在别处解决掉的问题：

| 团队包自认的限制 | superagent 原型里的对应做法 |
|---|---|---|
| 一个进程、一个共享 checkout，没有 worktree、没有文件锁 | 每个 Ticket 一个执行目录，`prepare` 命令通常是 `git worktree`（`docs/003-execution.md:25,53`） |
| `writeScopes` 只是顾问式提示，Bash 与外部写入者都能绕过 | 授权强度 `explicit \| inferred` 决定这次工作能不能开始（`docs/002-authorization.md`） |
| teammate 的进展只能靠 `wait_agent` 轮询与自由文本 | 结构化 Report（`progress/waiting/ready/blocked/failed/dropped`），面板只列需要人的（`docs/003-execution.md:9-21`） |
| 没有「哪些在等一个人」的收敛视图 | 注意力经济学：健康状态不占空间（`docs/000-philosophy.md:21`） |

同时，长任务的行为带（ponytail 已按 agent 自动生效；compose-next 只有 skill，没有插件化触发）没有延伸到团队：teammate 少了 Lead 那份收敛约束。

目标是把这四条能力装进**一个出树插件**，不改 `packages/**`——按 `docs/compose/spec/fork-upstream-divergence.md` 的 A5，仓库外的能力放 `plugins/**`，每次上游 resync 不用重放。

## [S2] Design

### S2.1 落点与装载

`plugins/prism-team`：单入口 Host 插件（`name = 'prism-team'`，带 `cordis.patch.yml` 行与 `dsh.bundle.patch`），与 `prism-guardrails` 同构。它订阅 `agent/created`，用 `ctx.agentTeams.tryMembership(agent)` 判断该 Agent 是不是团队成员，是才在**该成员自己的 ctx** 上装 scoped 注册，disposer 随 Agent 销毁。这与 `tool-agent-team` 的 `maybeInstall` 完全同路（`packages/experimental/tool-agent-team/README.md:102`），因此不需要改动团队包，也不需要新的服务。

不是团队成员（普通会话、非 Team 子代理、陈旧身份）时，插件一行行为都没有：`tryMembership` 返回 `undefined` 即跳过，这是它自己的 JSDoc 承诺的语义。

### S2.2 结构化汇报

新工具 `team_report`，每个成员都有：

```ts
{ status: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
  summary: string
  taskId?: string }
```

执行分两步：先 `ctx.agentTeams.sendMessage(caller, { targetName: 'lead', content })`，正文是 `Report from <name> [<status>]: <summary>` 加可选的 taskId；再把同一条记录进插件台账。返回值是一张收据（状态、是否送达、台账条数），不伪造模型处理结果。

Lead 自己调用时**不发消息**——团队服务拒绝自发消息，而且 Lead 的汇报没有收件人；只入台账，收据里写明。工具 schema 对 Lead 与 teammate 相同，执行里按成员角色分流，这与团队包自己的做法一致（`tool-agent-team` 的九个 schema 对全体一致，权威在服务层）。

台账是插件实例持有的 `Map<TeamId, Report[]>`，环形上限 `maxReports`（默认 200）。它**不是审计日志**，重启即失；真正的持久面是 Lead 收件箱里那条消息（模型可见、已入会话日志）。插件写不了 Session 事件——`scripts/verify-plugin-record-callers.ts` 只放行 `packages/experimental/`、owner、测试和 gate 自己——所以状态只能落在「工具调用」和「内存」两处，这一点在 README 的限制里写明。

### S2.3 需要人清单

命令 `/team`，任何成员可调：

```
Team: 3 members, 2 open tasks (1 needs a person).

needs a person:
  blocked   reviewer   cannot reproduce on windows, missing repro steps   task-4
  waiting   tester     which branch should I target?                     task-5

working:
  progress  writer     rewrote the parser, running the suite

tasks: task-4 in_progress (reviewer) · task-5 pending · task-6 completed
```

排序规则来自 superagent 的面板：`blocked`/`failed` → `ready` → `waiting` 属「需要人」，`progress` 与没有在途汇报的成员属「working」；**健康状态只占一行**（`Team: 2 members, no open reports.`），不铺开。

名单数据来自 `listMembers` + `listTasks` + 台账，不新增持久面。

### S2.4 每成员独立 worktree

teammate 被创建时，若 `worktree: true` 且 Lead 的 cwd 在 git 仓库内，插件为该成员执行一次：

```
git worktree add <root>/.worktrees/team-<teamShort>-<name> -b team/<teamShort>/<name>
```

`<root>` 取团队根的会话 cwd，`<teamShort>` 取 `TeamId` 的前 8 位。绝对路径写进该成员的 system-prompt 段落，同时出现在 `/team` 的成员行尾，Lead 与成员都能看到。`.worktrees/` 已被 `.gitignore`（`.worktrees/.gitignore` 里是 `*`），不会污染工作树。

三条失败路径都不打断成员：

- 不是 git 仓库 → 不建，成员段落里写明「本团队没有目录隔离」。
- `git worktree add` 失败（分支重名、路径占用）→ 同一段落的警告行带 stderr 摘要。
- 成员角色是 Lead → 永远不建（Lead 用共享 checkout）。

**不自动删除**：一个未评审的 worktree 可能就是成员的成果，删掉等于丢数据。`/team` 打印路径，清理是人工 `git worktree remove`，这条写进 README。

**已知限制，必须写明**：插件的 `map`/`write` 工具按会话 cwd 解析相对路径，而团队包没有提供切换成员 cwd 的能力。所以成员必须用**绝对路径**在 worktree 里工作，共享 checkout 依然可写，隔离仍是劝告式的。与现状的差别只有一条，但它是真的：每个成员第一次拥有一个专属、可提交、可 `git diff` 的目录。README 里把它和团队的「Advisory write scopes」并列。

### S2.5 写入授权闸

`tools/pre-execute` 上的一条 rail，只对 teammate 生效（Lead 与普通会话直接 `next()`）。对写类工具（`write`、`edit`、`str_replace_editor`）取目标路径：

- 解析该成员**已认领任务**（`listTasks` 里 `status === 'in_progress'` 且 `ownerId` 是自己）的 `writeScopes`，把路径规范成工作区相对前缀后比对。
- 命中 → 放行，这是 `explicit` 强度：有人给它划了这块范围。
- 未命中，或该成员根本没认领任务 → `inferred`。`mode: enforce` 下返回 `{ kind: 'ask', reason }`，`mode: observe` 下放行并在台账记一条。

`ask` 就是 superagent 的 Attention：一个需要人点一下的决定，正好落进 S2.3 的清单。

强度与模式在这里是**非对称**的，和 `GUARDRAILS-SUPERAGENT-PLAN.md:35` 记过的一样：原型的 `observe` 只降「没人点名的工作」这一档，而这条 rail 面对的所有越界写入同等对待，所以搬过来 `observe` 就是「所有越界只记录」。README 写清 observe 是一种关闭护栏的方式。

这是本插件真正的增量：团队包把 `writeScopes` 明确定义为 advisor，本插件把它变成可拦，但只在 teammate 的写工具上，而且越界时的默认动作是**问**而不是拒绝——写工具被拒会让成员卡死，问则把决定交回给人。

### S2.6 模式路由不在本插件内

**ponytail 不需要新代码。** `prism-guardrails` 的 section 按 `context.agent` 解析等级，自动规则是「编码预设或累计步数 ≥ `autoLongTaskSteps`」；teammate 是 Agent，天然拿到同一个 section 与同一套 `agent/pre-step` 计数。验收里验证一次即可。

**compose-next 归 `prism-guardrails`。** 「把 skill 变成插件能力」是通用能力，不是团队专属：`ponytail` 已经住在 `prism-guardrails`，bundle 挂进每个 profile。再造一个「模式插件」会让同一件事有两个家，所以 compose 模式做成 `prism-guardrails/src/compose.ts`，与 `ponytail.ts` 同构，见 [compose-next-mode.md](compose-next-mode.md)。本插件不碰模式路由，成员靠 profile 里那一行拿到它。

### S2.7 配置

```yaml
- id: prism-team
  name: prism-team
  config:
    mode: enforce                       # enforce | observe
    worktree: true                      # 每 teammate 一个 worktree
    writeTools: [write, edit, str_replace_editor]
    maxReports: 200                     # 台账环形上限
```

四个键全部在装载时校验，非法值立刻抛错并指向键名（沿用 `prism-guardrails/src/config.ts` 的报错风格）。成员角色、团队身份、cwd 都不进配置——它们从运行时读。

### S2.8 失败行为

| 情况 | 行为 |
|---|---|
| 不是团队成员 | 该 Agent 不装任何注册，零行为 |
| 团队服务不存在 | 插件不装载（`inject` 声明 `agentTeams`） |
| `sendMessage` 被拒 | 工具返回错误，台账不写入——不谎报送达 |
| 非 git 仓库 | 不建 worktree，成员段落说明，成员照常工作 |
| `git worktree add` 失败 | 段落里一行警告带 stderr，不打断成员 |
| 台账写满 | 丢最旧一条，`/team` 显示真实条数 |
| `mode: observe` | 越界写入放行并记账，`/team` 单列 observed 行 |

## [S3] Scope

- In scope：`plugins/prism-team` 包（入口、工具、两个命令、rail、worktree 准备、台账、配置校验）、单元测试（含真实 Cordis 组合）、README 与限制、`cordis.patch.yml`。
- Out of scope：Web 面板 UI；GitHub / 飞书来源接入；Mandate 与策略版本重校验；自动合并；`cwd` 切换；改动 `packages/**`；把插件装进正在跑的 profile（收尾时作为单独一步提供）。

## Tasks

- [x] T1: 脚手架（manifest、tsconfig、tsdown、vitest、cordis.patch.yml、README 骨架）(depends: none)
- [x] T2: 配置校验与台账（`Config`、`resolveConfig`、环形 `Map<TeamId, Report[]>`）(depends: T1) covers: S2.7
- [x] T3: `agent/created` 装载与 scoped 卸载 (depends: T2) covers: S2.1
- [x] T4: `team_report` 工具与 `/team` 清单 (depends: T3) covers: S2.2, S2.3
- [x] T5: worktree 准备与段落注入 (depends: T3) covers: S2.4
- [x] T6: 写入门闸（enforce/observe）(depends: T3) covers: S2.5
- [x] T7: README（限制、observe 的安全后果、worktree 只是劝告）与单测收尾 (depends: T4, T5, T6)

## [S4] Acceptance

- [x] A1 非团队成员 Agent 上，插件不注册任何工具、命令或 section（断言注册数为 0）。
- [x] A2 teammate 调用 `team_report` 后，Lead 收到一条形如 `Report from <name> [blocked]: …` 的消息，台账多一条，收据里的状态与传入一致。
- [x] A3 Lead 调用 `team_report` 不产生自消息，只入台账。
- [x] A4 `/team` 在有一条 `blocked` 汇报时，`needs a person` 段出现在 `working` 段之前；全部健康时只输出一行。
- [x] A5 同一团队两个 teammate 各自拿到不同的 worktree 路径与分支，路径在 `.worktrees/` 下，且都被 `git worktree list` 承认。
- [x] A6 非 git 仓库里创建 teammate，成员照样创建成功，且 `/team` 或段落里说明没有隔离。
- [x] A7 `mode: enforce` 下，teammate 写未认领任务之外的路径得到 `ask`；写自己已认领任务的 `writeScopes` 内路径直接放行。
- [x] A8 `mode: observe` 下同一次越界写入放行，且 `/team` 出现一条 `observed` 记录。
- [x] A9 配置非法值（`mode: 'on'`、`maxReports: -1`）在装载时抛错，错误文本指向键名。
- [x] A10 `tsc -p tsconfig.json --noEmit` 与 `vitest run` 通过。
- [x] A11 模式路由（ponytail / compose-next）在 teammate 会话上可用——由 [compose-next-mode.md](compose-next-mode.md) 的验收覆盖，本规格只确认成员是 Agent、拿到同一个 section。
