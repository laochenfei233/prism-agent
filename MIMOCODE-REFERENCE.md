# MiMo-Code 参考记录

第三方仓库调研记录，对象是 `C:\Users\chenfei\Documents\GitHub\MiMo-Code`（小米 MiMoCode，**opencode 的 fork**：根 `package.json` 的 `name` 仍是 `opencode`，`sst.config.ts` / bun / `packages/opencode` 结构完整）。本文所有 MiMo-Code 路径都相对该仓库根目录，均为只读阅读所得，可直接复核。

用途：为 prism-agent（DSH fork）的约束能力与工作流设计提供可借鉴项。这不是决策记录，不构成对 DSH 现状的判定。

---

## 一、已确认的优势

### 1. 信任模型诚实且写死

`SECURITY.md` 直接写明：permission system **不是** security sandbox，不是隔离边界；`Sandbox escapes` 与 `Malicious config files` 都列为 out of scope（后者理由：用户控制自己的配置）。

`USE_RESTRICTIONS.md` 是可接受使用政策，其中一条直接约束自主性：不得在缺乏适当人类监督或授权的情况下自主执行高风险动作。

价值：读者不会误以为权限系统提供了它并不提供的保证。DSH 的 `SAFETY.md` 有类似诚实度，但 MiMo-Code 更进一层——它把"没有沙箱"当作设计选择明说，而不是留白。

### 2. 权限层有三个值得直接搬的机制

实现位于 `packages/opencode/src/permission/`，`Action = allow | deny | ask`，按 tool 配置模式表（`read/edit/glob/grep/list/bash/task/actor/external_directory/question/webfetch/websearch/codesearch/lsp/doom_loop/skill`）。

**(a) 规则优先级显式依赖 JSON key 顺序。** `evaluate.ts` 用 `findLast`，后面的 key 赢；`config/permission.ts` 专门保留 `__originalKeys` 预处理，因为 Schema 会打乱 key 顺序。多数产品用显式优先级，这是少数派做法，但配合下面的机制是自洽的。

**(b) deny 单独先求值，历史批准不能盖过它。** `permission/index.ts:272-293`：先只用 ruleset 求值，显式 deny 立即短路；只有在 ruleset 本身不 deny 时，才允许已存批准把 ask 升级为 allow。这修的是一个真实越权 bug——`docs/compose/reports/plan-mode-edit-write-backstop.md` 记录根因：原先 ruleset 与批准一起 `findLast`，一个 build 模式下批准过的 `edit: always` 能盖过 plan 模式的 deny。

**(c) `FORCED_ASK = {"bash_delete"}`。** `permission/index.ts:215-222`：不可逆操作的 allow **必须**来自 in-band 的人类批准。通配 allow 规则（`permissions.allow: ["*"]`）与持久化批准都不能预先授权它，`skipAll` 也显式排除它。源码注释："the intent to perform an irreversible action must be recorded in-band, not inherited from a broad blanket rule"。**DSH 没有对应物。**

其余：子代理继承走两阶段父快照（ruleset → approved，不拍平），deny 优先；逃生舱命名即警告（`MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS`、`MIMOCODE_AUTO_APPROVE_DELETE`）；`permissionAskTimeoutMs` 超时自动拒绝；系统 spawn 的非交互 agent `interactive: false` → fail clean。

### 3. 计划模式有硬兜底（DSH 的对应项是纯提示词）

新增 `Agent.hardPermission` 字段，规则在 user/session merge **之后再追加**，因此永远赢；`runtimePermission(agent, sessionPermission)` 接进 5 个求值点（`session/llm.ts` ×2、`session/prompt.ts` ×2、`cli/cmd/debug/agent.ts` ×2）。用户写 `permission: { edit: "allow" }` 无法放宽。

对照 DSH：`packages/plan/plan-mode/README.md:185` 明说 "Guidance, not enforcement"。

### 4. 循环治理有三层，且硬的那层会问人

- **`doom_loop`（硬）** — `session/processor.ts:32, 515-540`：连续 3 个完全相同的工具调用即触发权限审批；后台非交互 agent fail clean。
- **`text-loop` / `stepSignature`（软）** — 注入提醒。
- **`loop_streak_recovery`（实验，默认关）** — `docs/compose/spec/loop-streak-recovery.md`：以 thinking 为主键（tools 只作为 fallback）检测重复，然后做**请求层裁剪**而非物理删除；`trigger_count: 3`、`max_span: 64`；跨度持久化为父 user 上的 `ignored` + `synthetic` part，DB 保留完整轨迹供回放与取证。取舍写明："Effectiveness > cache"——宁可缓存失效也要打断循环。
- **`agent.steps`（默认 `Infinity`）** — `session/prompt.ts:4063-4064` 派生 `isLastStep`。机制在，默认不限。

那份 spec 的论据是我见过最扎实的：从本地 DB 实测 identical reasoning head 出现 **621 次 streak、最长 661 条连续**，identical tool signature 3469 次 streak，并据此论证"删除 20+ 个 Anthropic content block 是常态而非边界情况"。

### 5. Skill 可达性控制：把"授权"和"可达"拆成两个轴

`docs/compose/spec/skill-invocation-control.md`：

- `permission.skill` 只表示**授权**——`deny` 让 skill 对任何人都不可用，包括用户；
- SKILL.md frontmatter 的 `disable-model-invocation` 表示**可达性**——从 system prompt 目录、`skill` 工具描述、`skill_search` 三处一起消失；
- 模型不可见 ≠ 用户不可用：`/name` 不受影响；
- `skill` 工具拒绝加载时，错误**指向用户的 slash command**，而不是死路。

最有价值的是它的缺陷识别方式：第一版用 `deny` 兼做隐藏，作者读了 Claude Code 的 frontmatter 参考后发现上游标准本就把这件事拆成 `disable-model-invocation` 与 `user-invocable`，于是判定"一条规则服务两个问题"才是真缺陷，而不是给症状打补丁。字段名也对齐 Claude Code / agentskills.io 标准。

### 6. 工程文档文化：spec / specs / plans / reports 四层

`docs/compose/` 分四层：`spec/`（22 份，当前契约）、`specs/`（2 份）、`plans/`（3 份）、`reports/`（8 份）。规格有稳定 frontmatter（`feature` / `status` / `updated` / `branch` / `commits`）。

两个细节特别值得学：

- **Journey log**：交付报告里记录死胡同、转向和可迁移教训，限制 ≤5 条。例如 `compose-next.md` 记下"从一个 agent 的 bundle 里组装的 skill 会继承该 agent 的 prompt 注入假设，必须审计"，以及"合并产物藏在过渡句里，不在章节正文里"。
- **Superseded in part** 段落：明确列出旧机制被取代后**哪几条陈述不再成立**，并指向当前契约文档。这比"文档已更新"有用得多。

---

## 二、还可参考的部分（未细读，按主题登记）

| 主题 | 入口 | 为什么可能有价值 |
|---|---|---|
| 上下文预算 | `docs/compose/spec/context-budget-control.md`（32KB，最大的一份） | DSH 的 compaction 是 80% 阈值 + head/tail 剪裁；这份可能有更细的预算模型 |
| 循环检测实现 | `docs/compose/spec/loop-streak-recovery.md` | 检测算法、缓存安全分析、持久化跨度设计 |
| 检查点与安全 | `docs/compose/spec/checkpoint-writer-safety.md`、`docs/architecture/retry-coordinator.md` | DSH 无 checkpoint 概念 |
| 日志安全 | `docs/compose/spec/log-safety.md` | 凭据/路径进入日志的边界 |
| 测试隔离 | `docs/compose/spec/flaky-test-isolation.md` | 与 DSH 的 `dsh-ci-test-reliability` skill 同题，可对照 |
| MCP 工具搜索 | `docs/compose/spec/mcp-tool-search.md` | MCP 工具目录膨胀问题；DSH 的 mcp 无此机制 |
| 微内核运行时 | `docs/architecture/codex-microkernel-runtime.md` | 架构对照 |
| 工作流引擎 | `packages/opencode/src/workflow/builtin/`（`compose.js` 749 行、`deep-research.js`、`fact-check.js`、`research-experiment.js`） | 命令式编排 + 结构化 schema 的完整范例 |
| 内置技能集 | `packages/opencode/src/skill/builtin/.bundle/`（28 个） | `evolve`、`mate`、`super-research`、`learn-everything` 等 DSH 没有 |
| 计划模式演进 | `docs/compose/spec/plan-enter-removal.md`、`plan-no-continue.md` | 计划模式的控制流简化过程 |
| worktree 自动化 | `docs/compose/spec/auto-worktree-config-toggle.md`、`docs/compose/specs/auto-worktree.md` | 与 Compose Next 的 Workspace 阶段配套 |

注意：`packages/containers/` 是 CI 构建镜像，**不是** agent 沙箱。全仓库 grep `seatbelt|landlock|bubblewrap|gVisor|firecracker` 零命中，`SECURITY.md` 的"无沙箱"声明与代码一致。

---

## 三、Compose Next 深读

来源：`packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md`（197 行，单文件自包含）与 `docs/compose/spec/compose-next.md`（227 行）。

### 定位

它是 Legacy Compose 的兼容优先继任者。Legacy Compose 把三件事捆在一个 agent 模式里：权限策略、工作流课程（14 个内部 skill 编排 brainstorm/plan/tdd/review/merge…）、UI 状态。Compose Next 的论点：**课程是为弱模型准备的；强模型已经内化了大部分，一份紧凑的可执行契约比 14 个被编排的 skill 更有用。** 于是折叠成一个 skill，八个阶段，无内部 skill 交接。

### 八个阶段

`Step 0 Orient → Grill → Workspace → Spec → Implement → Verify → Review → Finalize → Finish`

**Step 0 — Orient.** 先读仓库、指令（`AGENTS.md`/README/既有 spec）和近期改动，再问任何问题。原则："Do not ask the user for facts the environment already answers." 然后按形状分流：完全约束的机械改动 → 跳过 Grill 和 Spec；需求/设计含糊 → 先 Grill；需求清楚但值得留档 → Workspace → Spec。

**Grill — 解决决策。** 一次一个决策轴；一个决策可以捆绑多个从属字段，但无关决策必须分轮。每个用户决策都走 `question` 工具：已知选项放 `options`，每项给 label + 说明后果的 description，**推荐项排第一并标 `(Recommended)`**；重大选择给 2–3 个可行备选；选项无法枚举时仍以 `options: []` 发起自由文本。

**Never-Ask 处理**（无人应答时）：只对**当前这一个**决策自行裁决——优先选标了 Recommended 且证据支持、可无人值守执行的选项；否则选证据支持的最小范围选项，偏好纯文本非交互工作；若涉及破坏性/不可逆工作，选保留进展的非破坏路径，**绝不自动批准破坏性选项**；并在回复中说明所选及理由。明确写了"Never-Ask does not disable future questions"——后续决策点仍然要问。

**Workspace — worktree 所有权。** 没有明确同意，绝不在 `main`/`master` 上开工。用 `git rev-parse --git-dir` 与 `--git-common-dir` 比较判断是否已在 linked worktree（不同则复用，不再嵌套）；`--show-superproject-working-tree` 非空说明是 submodule 而非 worktree。默认在 `.worktrees/<slug>` 建 linked worktree，先 `git check-ignore` 再补 `.gitignore`。依赖安装偏好 lockfile-frozen、hardlink 友好的模式（`bun ci`、`uv sync --frozen`）。**每条路径都过 Workspace，无分支可跳。**

**Spec — 一 feature 一份文档。** 路径固定 `docs/compose/spec/<feature>.md`（用户指定可覆盖），文件名不带日期，原地编辑现有文档，绝不拆出独立 plan 或 report。模板含 frontmatter + `[S1] Problem` / `[S2] Design` / `[S3] Out of Scope` / `Tasks`。

设计期规则里最值得抄的几条：

- `[Sn]` 锚点在标题变化时保持稳定，**绝不重编号既有锚点**；
- 每个任务是最小的可独立验证工作项，且带**可观测**的验收标准；`depends:` 只在真有前置时加且必须无环；
- `covers:` 双向可解析——每条设计需求至少被一个任务覆盖，每个引用都能解析；
- 删除 `TBD`、"handle edge cases" 这类占位符。

**Implement.** 有廉价复现的行为改动走 test-first（先写失败的测试、确认它以预期原因失败、做最小修复、确认通过）；bug fix 能写回归测试就要写。公共行为测试，不在期望值里复制生产逻辑，不加 test-only 生产 API，不只断言 mock 被调用。

**失败处理有一条硬规则**："After two failed fixes, stop patching and re-derive the cause."——两次修复失败就停止打补丁，重新推导根因。

并行工作的约束：只派发隔离能防止碰撞的独立任务；给每个子代理不相交的文件集，**提交留给 orchestrator**；传给子代理的是 workspace path、任务、验收标准、相关 spec 章节和所需验证，**不传 session history**；"Treat its report as a claim and inspect the resulting diff"（把它的报告当声明，自己去检查 diff）。

**Verify.** 任何完成声明之前，从正确目录跑相关测试/typecheck/build 并**读输出**；逐条记录命令与结果；已知基线失败标 `PRE-EXISTING` 并给短标识；不得用先前输出或子代理报告替代新鲜证据。

**关键顺序约束**：验证与评审**严格串行**——等所有验证命令退出后才派发 reviewer，绝不在同一环境里让评审与重量级测试重叠。

**Review.** 实现验证后、定稿前，派**一个**全新子代理评审整个改动。给 reviewer 的东西是精确的：相关 spec 章节与验收标准、workspace 路径、base 分支、base/head SHA、确切的 diff 命令或预算好的 diff，以及**紧凑的验证摘要**——每条命令一行 `PASS`/`FAIL`/`PRE-EXISTING`，有则附测试计数，除非特定失败需要，否则不粘贴完整输出。

几条非常实用的边界：

- **不提供实现者写的叙述**（避免被带节奏）；
- reviewer 不得重复已报告为通过的重量级命令（尤其重 E2E），除非结果过期、代码其后有变、或有具体证据表明可疑；有正当理由重跑前先确认没有等价命令仍在运行；
- 缺证据时，用最便宜的非重复命令去取或报告缺失；
- **reviewer 模型能力不低于它所评审的最强实现者**。

要求三类**独立**结论：spec compliance（每条验收标准都满足且有证据指向）、correctness（含 spec 之外的逻辑/边界/错误处理/回归/测试问题）、codebase consistency（命名、结构、局部约定）。

分级：未满足或不可验证的验收标准与正确性 bug 都算 critical。修 critical → 重新验证 → 重新评审受影响区域；**错误的发现用技术证据驳回**。

**停止条件写得最好**：如果"修复-再审"循环不再收敛——同一区域反复出现同类发现，或修复引入了新的 critical——**停止循环并带着剩余发现报告僵局**，而不是强行让它通过。

**Finalize.** 评审通过、结束分支之前：置 `status: delivered`、更新 `updated:`、记录被评审的范围 `<base-sha>..<head-sha>`；勾选完成任务，未完成的留着且若阻塞验收就不得声称交付；把 `Report` 换成 What was built / Verification / Journey log（≤5 条）。只在设计章节与交付行为矛盾时才改设计章节。

这里有一个处理得很干净的细节：**定稿提交天然落在已记录的评审范围之外**，文档明说这不重启验证或评审，CI 在它上面重跑是预期的——否则字面理解会陷入 finalize → re-review → finalize 的死循环。

**Finish.** 不自动收尾。报告分支、base、head SHA、workspace、feature 文档路径，并**建议**一个收尾动作。用户要求收尾但路径不明时，用 `question` 工具确定：收尾动作（本地合并/开 PR/仅推送/保留分支）、目标 base 分支、worktree 保留还是删除。破坏性动作永不自动批准。

### 触发策略（同样值得抄）

description 里写死："Use it only when the user explicitly requests this workflow, whether with `/compose-next`, by name, or in any other clear natural language; **do not infer the request from task complexity alone**." 正文重申：任何清楚的自然语言请求都算，用户不必知道或说出 skill 名；但如果用户没有明确请求这个工作流，就直接干活、**一个阶段都不跑**，不得仅因为任务大或像 Compose 任务就推断同意。并明确排除一次性编辑、单文件微调、回答问题。

另外有一条恢复指令：写检查点或压缩上下文时，必须把"恢复时若 Compose Next 指令缺失，先重新加载 `compose-next` skill"保留在检查点或压缩摘要里。

---

## 四、对 DSH / prism-agent 的可迁移点（按性价比排序）

1. **`FORCED_ASK` 式反通配豁免集**——DSH 的升级审批没有"任何模式都不自动批准"的动作集合，`sandbox_permissions` 的枚举在受限时永远全量广告。
2. **计划模式硬兜底**——`hardPermission` 在用户配置之后追加、不可被用户配置放宽；直接补上 `plan-mode` "guidance, not enforcement" 的洞。
3. **`doom_loop` 式循环审批**——DSH 唯一的循环守卫 `repeat-tool-reminder` 是软提醒，且超过最高阈值后彻底静默（`src/index.ts:206`）。把"连续 N 次完全相同的调用"接成一次审批，比提醒有效得多。
4. **`agent.steps` 式步数预算**——DSH 连字段都没有（`agent-loop/README.md:202` 明说 no built-in turn budget）。
5. **"两次失败就停止打补丁、重新推导根因"** 写进 agent 指令层。
6. **子代理报告的处理纪律**——"不传 session history""把报告当声明并自己检查 diff"。
7. **Review 纪律**——紧凑验证摘要格式（一行一命令 + PASS/FAIL/PRE-EXISTING）、不重复已通过的重量级命令、reviewer 能力不低于实现者、**不收敛就报告僵局而非强行通过**。
8. **finalize 提交落在评审范围之外** 的措辞处理，避免字面死循环。
9. **skill 可达性双轴**——`disable-model-invocation` 与授权分离，且拒绝时指向用户的 slash command。
10. **Journey log / Superseded in part** 两种文档段落形态，可直接用于 DSH 的 Agent Notes 与 feature 文档。

---

## 五、注意事项

- 该仓库 `.git` 属主是 `CodexSandboxOffline` 用户，当前用户读取会触发 git "dubious ownership"，因此**未能读取其提交历史**；本文所有结论基于工作树文件内容。
- `docs/compose/spec/compose-next.md` 自身标注了 "Superseded in part"，其中关于 `compose-next: deny` 权限的机制已被 `skill-invocation-control.md` 取代（现为模型可见、可调用）。上面引用时以当前契约为准。
- MiMo-Code 的权限系统明确**不提供隔离**；本文对其机制的正面评价仅针对"约束设计"，不代表它可以安全承载不可信负载。
