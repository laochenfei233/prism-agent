# prism-agent 能力补齐计划

**这份文档是什么**：`prism-agent`（deepseek-harness 的 fork）待补齐能力的实施规格。写给**在新的对话里实现这些功能的 agent**——它看不到本文档之外的任何上下文，所以每条都自带缺口证据、落点、配置面、已验证的设计决策，以及必须遵守的仓库规范。

**一句话背景**：本仓库是 DSH（DeepSeek Harness）的 fork；DSH 本身已经很强，下面每一条都是**经过 grep 与读源码验证过的真实缺口**，不是凭空设想。

---

## 0. 先读这三件事

### 0.1 上游同步是"树导入"，不是 merge

- 仓库只有 **2 个提交**：一条 `chore: import deepseek-harness as prism-agent-e baseline`（基线，上游历史被压平），以及其后一条 `docs(spec): finalize archive-import-prism-agent-e (delivered)`
- **没有配置 `upstream` remote**（只有 `gitea` / `github` 指向 fork 自己，`mimocode` 指向另一个项目）
- 因此 `git merge upstream/master` **结构上不可行**（无共同祖先）；同步只能靠"取一份新上游树 → diff → 人工调和"

**推论**：改动应尽量**可分离**——新增文件（新包、新 Note）同步时最安全；改写上游拥有的文件与生成物风险最高，要单独成提交。

### 0.2 开工前必须先修依赖，否则什么都跑不了

当前 `pnpm install` 会硬失败，导致每个包的 `node_modules` 从未建立（连 `zod` 都解析不到），**`vitest` / `tsc` / 所有 `scripts/verify-*.ts` 门禁全部无法运行**。

**根因**：fork 把桌面端从 Electron 迁到 Tauri（见未提交的 `apps/desktop/src-tauri/**`），electron-builder 闭包不再被任何 manifest 需要，于是 `pnpm-workspace.yaml` 里这条 patch 变成"未使用"，而 pnpm 对未使用 patch 是**硬错误**：

```
[ERR_PNPM_UNUSED_PATCH] The following patches were not used: @electron/osx-sign@1.3.3
```

**修复（一行）** —— 编辑 `pnpm-workspace.yaml`，在 `patchedDependencies:` 段删掉：

```diff
-  '@electron/osx-sign@1.3.3': patches/@electron__osx-sign@1.3.3.patch
```

然后（npm registry 在本机不可达，但 pnpm store 有完整缓存）：

```sh
pnpm install --offline
```

**已知副作用**：会顺带规范化 `pnpm-lock.yaml`（实测 **-1560 / +38** 行，删掉的是已失效的 electron-builder 闭包）。若不想动锁文件，安装后 `git checkout -- pnpm-lock.yaml` 即可，已装的 `node_modules` 不受影响。

**注意**：这条修复属于"上游拥有 + fork 本地移除"型分歧，**每次重新导入上游树后都要重做**。

### 0.3 门禁基线本来就是红的

`pnpm run test:docs` 当前 **14 通过 / 6 失败**，失败**全部来自 fork 既有问题**，不要误算成自己引入的：

| 失败门禁 | 原因 |
|---|---|
| markdown links | `apps/desktop/**` 下目标路径不存在（Tauri 迁移删掉了旧 Electron 脚本）、`AGENTS.md:123` 锚点失效 |
| repository references | `docs/compose/spec/archive-import-prism-agent-e.md` 含 7 处提交哈希 |
| translation pairing | `apps/desktop/runtime/**`、`design-assets/**`、`plugins/prism-progress/` 等缺中文对照件 |
| package README model experience / limitations | `packages/experimental/speech-to-text-dashscope`、`packages/cron/cron` 缺 README 或 README 章节 |
| type equivalence | 视当时源码而定 |

**判定自己是否引入新失败的方法**：把门禁输出按**你改过的文件路径**过滤；只要你的路径不出现在失败列表里，就不是你引入的。

---

## 1. 能力清单

> 编号即建议实施顺序。**B1–B4 的实现代码已备份**（见 §4），重放成本接近零。

### B1 · 计划模式硬兜底

| 项 | 内容 |
|---|---|
| **定义** | plan 模式激活时，部署声明的工具名由单调 guard 拒绝执行，而不只是提示词约束 |
| **缺口证据** | `packages/plan/plan-mode/README.md:185` 自称 "Guidance, not enforcement"；`.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md:56` **明确拒绝过**"按名称白名单过滤工具"这一方案 |
| **落点** | `packages/plan/plan-mode/src/index.ts` |
| **配置面** | `PlanModeConfig` 新增**必填** `deniedTools: readonly string[]`；校验：非数组 / 空名 / 重复名 → 加载即失败 |
| **行为** | 注册 `ctx.tools.guard()`；守卫读与提示词段落**同一个** `effectiveActive()` 判据（含"仍在等待边界的待生效选择"）；命中时返回拒绝理由，产物形如 `Error: plan mode is active: \`write\` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off` |
| **接线** | `packages/bundle/base/cordis.patch.yml` + `packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml` 四处声明 `deniedTools: [write, edit, str_replace_editor]` |
| **刻意不做** | **不**把 `bash` / `pwsh` 列入——仓库没有只读命令分类器，门禁 shell 会一并拒绝 `git status` 等规划阶段赖以开展的检查 |
| **过程要求** | 这**反转了**一条有记录、有理由的决策 ⇒ 按 `.agents/notes/implemented/AGENTS.md` 必须**新写一篇 Agent Note** 并反向交叉链接旧篇，**不得**就地改写旧篇 |
| **已验证** | 89/89 测试通过、`tsc` exit 0、6 项门禁全绿 |

### B2 · 循环硬停（工具层）

| 项 | 内容 |
|---|---|
| **定义** | 同一工具 + 完全相同参数连续 N 次后，下一次调用送交审批而非继续放行 |
| **缺口证据** | `packages/guard/repeat-tool-reminder/src/index.ts:206` 只在**精确等于**阈值时触发（`thresholdSet.has(count)`），超过最高阈值后**彻底静默**；且该包**从不否决**，README:174 自己承认这一点 |
| **落点** | `packages/guard/repeat-tool-reminder/src/index.ts`（复用其已有的每 agent 重复链，不新建包） |
| **配置面** | 新增 `hardStopAfter?: number`，默认 `0` = 保持纯建议；随附 `dsh-base` 设 `5`；校验：非整数或 `< 0` 或（`> 0` 且 `< 2`）→ 加载即失败 |
| **行为** | `tools/pre-execute` 短路为 `{ kind: 'ask', reason }`；**无审批通道时 fail-closed 成拒绝**；计数仍留在 `tools/post-execute`（被拒调用也计数，因此持续冲击门禁的模型会不断撞上它） |
| **为什么用 ask 而非 deny** | 合法的长重复确实存在（反复轮询同一 `job_output`、外部改动后重复读同一文件），只有人能区分；拒绝取消了选择，询问为它定价 |
| **不重置链的原因** | harness 其他地方的批准本就是 `allowed-once`；在这里重置会让一次批准买到同一次调用的无限运行 |
| **已验证** | 25/25 测试通过；另用脚本扫描**全部 407 个录制会话**，证明没有任何会话出现过 ≥5 次连续相同调用，故随附默认值不会让任何快照分叉 |

### B3 · 步数预算

| 项 | 内容 |
|---|---|
| **定义** | 一轮最多开启 N 个步骤，超出的步骤改为关闭该轮 |
| **缺口证据** | `packages/core/agent-loop/README.md:202` 明说 "**No built-in turn budget**"；仓库全局 grep `maxSteps|maxIterations|stepLimit|maxTurns` 只命中一个 Claude-SDK 测试覆盖 |
| **落点** | **新包** `packages/guard/turn-budget/`（`package.json` / `tsconfig.json` / `src/index.ts` / `tests/` / 双语 README 三件套；**不需要** `tsdown.config.ts`，tsdown 由根级统一配置） |
| **配置面** | `maxStepsPerTurn: number`，**必填、不给默认值**（上界是部署策略，猜错要么不设防、要么截断真实工作）；非整数或 `< 1` → 加载即失败 |
| **行为** | 监听 `agent/pre-step`；payload **自带步骤号** `{ agent, messages, turn, step, signal }`（见 `packages/core/agent/src/runtime-types.ts:320`），因此 `step > maxStepsPerTurn` 时返回 `{ kind: 'reject' }` |
| **关键简化** | **无需任何累积计数器**——重试、被拒的 pre-step、resume、fork 全部天然正确，因为判据来自日志里的步骤号 |
| **接线** | `packages/bundle/base/cordis.patch.yml` 设 `maxStepsPerTurn: 20` |
| **额外动作** | 新包需要在 `tsconfig.base.json` 的 `paths` 里**手写**源码别名 `"@deepseek-ai/dsh-turn-budget": ["./packages/guard/turn-budget/src"]`。生成器 `npx tsx scripts/gen-tsconfig-paths.ts` 会因 fork 里 `@deepseek-ai/dsh-experimental-speech-to-text-dashscope` 的包名/目录不匹配而**整体 bail**，无法代劳 |
| **已验证** | 4/4 测试通过、`tsc` exit 0、相关门禁全绿 |

### B4 · skill 拒绝引导

| 项 | 内容 |
|---|---|
| **定义** | 模型强行加载"仅用户可调用"的 skill 时，拒绝文案给出**可执行的出路**，而不是死路 |
| **缺口证据** | `packages/skill/tool-skill/src/index.ts` 的两处（`summary` 分支与 `skill` 分支）只抛 `skill "X" is not available for model invocation`，不告诉模型下一步 |
| **落点** | `packages/skill/tool-skill/src/index.ts` |
| **行为** | 按调用策略分叉：`invocation.userInvocable` 为真 → `skill "X" is user-invoked only: ask the user to type /X in their next message`；两个接口都不可调用 → 保留原来的通用拒绝 |
| **注意** | 属**模型可见文案**。测试断言与**双语 README 里逐字记录的三种错误文本**必须同步修改 |
| **已验证** | 32/32 测试通过（含新注册的 `{modelInvocable:false, userInvocable:false}` 分支覆盖）、门禁绿 |

### B5 · 循环治理完整版（推理链）—— 唯一没做过的

| 项 | 内容 |
|---|---|
| **定义** | 以**推理链（thinking）**为主键检测重复；命中后把污染区间从**请求视图**裁掉，而日志保留完整轨迹 |
| **缺口证据** | 全仓库 grep `streak|doomLoop|textLoop|loop.*detect` **只命中 `repeat-tool-reminder` 自己的注释**——DSH 完全没有推理链层面的循环检测，只有「工具名 + 精确参数」 |
| **参考实现** | MiMo-Code 的 `docs/compose/spec/loop-streak-recovery.md`（`C:\Users\chenfei\Documents\GitHub\MiMo-Code`） |
| **参考参数** | `trigger_count: 3`、`max_span: 64`（默认关闭，实验特性）；**thinking 为主键**（工具漂移不破链），tools 签名仅作无 thinking 时的 fallback |
| **DSH 可用原语** | `session.append(<同类型事件>, {...原数据}, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [seq] })`，并在其前面追加一条 `compaction/prune` shadow-price 事件。**现成模板**：`packages/compaction/compaction-tool-result-pruner/src/index.ts:160-171` |
| **硬约束** | 裁剪单位必须是**整条 assistant 消息**（reasoning + text + tools + 内嵌结果），否则破坏 tool_use / tool_result 配对；streak 起点前一条是**锚点，永不删** |
| **MiMo 的实测数据** | 从真实 DB 统计：identical reasoning head 出现 **621 次 streak、最长 661 条连续**；identical tool signature 3469 次 streak。据此论证"删除 20+ 个 content block 是常态而非边缘情况" |
| **MiMo 的设计取舍** | "**Effectiveness > cache**"——宁可破坏前缀缓存也要打断循环；检测**只做一次**并持久化区间，不能每请求重检（否则视图翻转、缓存前缀破裂） |
| **规模** | 约 2–3 轮 |

### B6 · 升级"先被拒"门槛

| 项 | 内容 |
|---|---|
| **定义** | 只有当本会话**真实被拒绝过一次**，才允许请求更宽的沙箱档位；把"不要投机升级"从提示词提升为执行检查 |
| **缺口证据** | `packages/sandbox/sandbox/src/escalation.ts:155` —— `mode === effectiveMode` 直接返回，否则只要严格更宽就进审批；**首次调用即可直接请求 `danger-full-access`**，唯一的人性化文本是模型自己写的 justification。而 "Never escalate speculatively … ground the request in a real denial" 只存在于 `packages/shell/tool-bash/src/index.ts:116-117` 的提示词里 |
| **难点** | 拒绝标记产生在 **8+ 处**：`tool-bash/src/render.ts`、`tool-bash/src/background.ts`、`tool-pwsh/src/render.ts`、`tool-pwsh/src/background.ts`、`tool-fs/src/sandbox.ts:130`、`tool-str-replace-editor/src/index.ts:85` … 要把它变成"会话被拒过"的可观察事实需动一整片 |
| **已知冲突** | `packages/boot/plugin-manager/src/tools.ts:37-44` **按设计就是投机升级**（总是请求 `danger-full-access`），加门槛会直接打断它 ⇒ 必须能按调用方区分（建议由调用方在 `EscalationRequest` 上显式声明，符合仓库"Explicit > implicit at package boundaries"的要求） |
| **注意** | DSH 的升级路径**没有通配 allow 规则**、批准也不持久化，所以 MiMo 的 `FORCED_ASK`（反通配预授权）在 DSH **没有对应物**——不要照搬 |
| **状态** | 需先设计 |

### B7 · 最窄档偏好（价值最低，可跳过）

`ESCALATION_TARGETS`（`packages/sandbox/sandbox/src/escalation.ts:41`）永远广告全量枚举，"取最窄的够用档"只是提示词（同文件 `escalationHintMarker`），没有执行检查。

---

### C1 · compose-next 一体工作流

**形态**：单文件阶段契约 `grill → workspace → spec → implement → verify → review → finalize → finish`（参考 MiMo `packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md`，197 行）。

**值得抄的硬规则**：
- **显式触发**：`do not infer the request from task complexity alone`——用户没明确要求就一个阶段都不跑
- **Grill**：一次一个决策轴；每个选项带 consequence 描述，推荐项排第一并标 `(Recommended)`
- **Never-Ask**：只对**当前这一个**决策自行裁决；**绝不自动批准破坏性选项**；且明确"Never-Ask does not disable future questions"
- **失败纪律**：`After two failed fixes, stop patching and re-derive the cause.`
- **并行纪律**：给子代理不相交文件集；提交留给 orchestrator；**不传 session history**；`Treat its report as a claim and inspect the resulting diff`
- **Spec**：一份文档承载 design + tasks + report；`[Sn]` 锚点**永不重编号**；每个任务"最小可独立验证 + 可观测验收"；`covers:` / `depends:` 双向可解析
- **Review**：验证与评审**严格串行**；给 reviewer 紧凑验证摘要（一行一命令 + `PASS`/`FAIL`/`PRE-EXISTING`）；`Do not provide an implementer-authored narrative`；reviewer 模型能力**不低于**被评审的最强实现者；三类**独立**结论（spec compliance / correctness / codebase consistency）
- **不收敛就停**：同一区域反复出现同类发现、或修复引入新 critical ⇒ **报告僵局**，不强行通过
- **死循环规避**：定稿提交天然落在"已记录评审范围"之外，文档必须明说这不重启验证与评审

### C2 · 评审与验证纪律 skill

可独立成 skill（复用 C1 素材）。核心是上表 Review 段的全部规则。

### C3 · feature 文档文化

- 每 feature 一份文档（不拆 plan / report），带稳定 frontmatter（`feature` / `status` / `updated` / `branch` / `commits`）
- **Journey log ≤5 条**：死胡同、转向、可迁移教训
- **Superseded-in-part 段落**：明确列出旧机制失效后**哪几条陈述不再成立**，并指向当前契约
- 与 DSH 现有 `.agents/notes/` 的分工：Agent Notes 服务 harness 维护者（决策理由），feature 文档服务单个 feature（设计 + 任务 + 交付证据）

---

### D1 · 跨 home 会话导入

**完整实施规格见 [`SESSION-IMPORT-PLAN.md`](SESSION-IMPORT-PLAN.md)**（含已验证事实、落点、契约、行为规格、验证基线）。摘要：

| 项 | 内容 |
|---|---|
| **定义** | 设置 → 数据：探测/选择一个来源 DSH home，预览计划后把历史会话导入当前 home，**无需重启** |
| **缺口证据** | fork 换了自己的 home（`DSH_HOME=~/.prism`），而 DSH 默认 home 是 `~/.dsh`（`packages/util/home-paths/src/index.ts:12`）；仓库内不存在任何导入代码，用户侧栏是空的 |
| **落点** | **新包** `packages/session-query/session-import/`（与 `session-log-export` 对称的同包 Host+Client 形态） |
| **为什么不能改文件** | `workspace.json` 是内存投影（`packages/storage/storage-json/src/single-unit.ts:4`），外部改会被整份覆盖；必须走 `ctx.workspaceRegistry.attachSession`（`packages/workspace/workspace/src/entity.ts:109`） |
| **已验证** | 一次性脚本已完成真实导入：54 会话 / 43.2 MB，96 份日志逐帧解码 0 失败，55/55 文件 SHA-256 一致，registry 不变式 0 违反 |

---

### E1 · fork 分歧清单

**为什么需要**：上游同步靠树导入（§0.1），每次导入都需要一份"哪些上游文件被本地改过、为什么、如何重放"的清单，否则全靠人肉记忆。

**第一条现成素材**：§0.2 的依赖修复。**建议形式**：`.agents/notes/implemented/process/<date>-prism-fork-local-divergences.md`（三件套：`.md` / `.zh.md` / `.i18n.yaml`）。

---

## 2. 交付规范：DSH 对每个改动的要求

新对话里的 agent **必须**先读 `AGENTS.md`、`packages/AGENTS.md`、`docs/AGENTS.md`。以下是本会话实测最容易踩的部分：

1. **测试**：产品可见的插件需要**真实组合**测试（不能只手搭 `ctx.plugin(...)`）；`packages/*/*/src` 有**逐文件 100% 覆盖率**门禁，新增的每个三元分支/校验分支都要有对应用例。
2. **双语三件套**：每个包 README 需要 `README.md` + `README.zh.md` + `README.i18n.yaml`（记录两侧 git blob 哈希）。改任意一侧后必须重录哈希——用 `git hash-object <file>` 手动算即可，`pnpm run verify-translation-pairing --write <path>` 更好。
3. **Agent Note**：行为决策要写三件套 `implemented/<class>/<date>-<topic>.{md,zh.md,i18n.yaml}`；**反转**既有决策时新写一篇并交叉链接，**不得**改旧篇的决策。
4. **生成物**：改了 `Config` 就要 `npx tsx scripts/gen-config-catalog.ts` 重新生成 `docs/config-catalog.md`，并**手工镜像**到 `docs/config-catalog.zh.md`（生成器不产出中文版），再重录 `docs/config-catalog.i18n.yaml`。
5. **`type-equiv` 块**：`docs/subsystems/*.md` 里粘贴的类型定义必须与源码逐字一致（`pnpm run verify-type-equiv`）。
6. **模型可见文案**：改动错误消息、提示词、工具描述时，测试断言、双语 README 里的逐字引用、以及可能的快照都要一起改。
7. **门禁自检**：至少跑 `verify-md-wrap`、`verify-md-links`、`verify-translation-pairing`、`verify-config-catalog --check`、`verify-type-equiv`、`verify-package-readme-model-experience`、`verify-package-readme-limitations`，并按**自己的文件路径**过滤失败列表。

---

## 3. 踩坑清单（本会话真实踩到、靠读门禁源码才解决的）

1. **`Capability` 锚点写法**：配置目录的自动锚点是 `#deepseek-aidsh-<pkg>`（`ai-dsh` 被连写成 `aidsh`），不是 `#deepseek-ai-dsh-<pkg>`。
2. **模型体验段的 `none` 契约**：若包被登记进 `scripts/verify-package-readme-model-experience.ts` 的审计清单（`kind: 'none'`），则 `## Model Experience` 与下一个 H2 之间必须**恰好 3 行**：`None, as ….` 一句 → `#### KV Cache effect` → 一段非空段落。**不能有** `#### What the model sees` 标题，**不能有** `#### Token effect` 字段，**不能有** `### 子标题` 层。
3. **段末锚点位置**：`<a id="…"></a>` 必须放在 H2 **之后**；放在 H2 之前会被模型体验段的"字段后只能是 H5"规则判为非法内容。
4. **中文文件的链接 locale**：中文 README 里的交叉链接必须写 `.zh.md`；**但指向 `.agents/notes/archived/` 的链接两侧都用 `.md`**（归档没有独立中文对）。
5. **新包路径别名**：`tsconfig.base.json` 的 `paths` 需要手写条目（见 B3）；新包还要跑一次 `pnpm install --offline` 才能建立 workspace 链接。
6. **沙箱与工具链**：本环境的文件沙箱会拦截 `tsx` / `vitest` 的 esbuild 子进程（`EPERM` on piped stdio）。需要放宽沙箱才能运行测试与门禁；`pnpm run <script>` 还会先跑依赖校验，若失败可绕过 pnpm 直接调 `node_modules/.bin/<tool>`。
7. **`Copy-Item -Recurse` 陷阱**：`packages/*/node_modules` 是 pnpm 的符号链接农场，递归复制会无限深入。备份时用显式文件列表。

---

## 4. 已实现代码的备份位置

B1–B4 的实现与验证都做过，随后按要求整体还原。备份在：

```
%TEMP%\prism-session-backup\
  tracked.patch          # 全部已跟踪改动（含源码/测试/文档/生成物），214 KB
  turn-budget\           # B3 新包：src/index.ts、tests/、package.json、tsconfig.json、双语 README
  notes\                 # B1、B2 的 Agent Note 三件套
  FORK-DEP-FIX.md        # §0.2 依赖修复的可重放说明
```

`tracked.patch` 可用 `git apply` 重放（注意：其中也包含生成物与 `pnpm-*` 的改动，建议**分文件选择性应用**，生成物重新生成而不是打补丁）。

**重放时的验证基线**（走通即说明重放成功）：B1 → 89/89；B2 → 25/25；B3 → 4/4；B4 → 32/32。

---

## 5. 明确**不要做**的（DSH 已具备，重复建设是浪费）

| 能力 | 证据 |
|---|---|
| **skill 可达性双轴** | `disable-model-invocation` / `user-invocable` 四象限策略**已完整实现**：`packages/skill/skill-filesystem/src/index.ts:1004-1008` 解析、`packages/skill/skill/src/index.ts:53` 定义策略、`packages/skill/tool-skill/README.md:88` 说明目录与工具均已隔离。MiMo 的那套只是这套的复刻 |
| 单调工具守卫 | `packages/core/tools/src/index.ts:1125-1153`，deny-only、注册在整个 waterfall 之后、插件顺序无法反转 |
| OS 级沙箱四后端 | bwrap / Landlock / Seatbelt / Windows ACL 受限令牌 + Low IL（`packages/sandbox/sandbox-local`、`sandbox-windows-acl`） |
| fail-closed 审批阶梯 | 缺审批服务 / agent / 通道一律拒绝；`allowed-once` 不持久化（`packages/sandbox/sandbox/src/escalation.ts:162-184`） |
| 静态能力面 | `AGENTS.md` + profile/bundle/preset + `ctx.tools.restrict()` |
| 门禁密度 | 76 个 `verify-*` 门禁、约 2.5 万个测试用例（运行时不变式层已由上游 v0.2.0-rc.2 整体移除，本 fork 消费该状态） |
| 工具链重复提醒（软） | `packages/guard/repeat-tool-reminder`，阈值 `[3,5,8]` |
| spill / compaction / timeout | `packages/spill`、`packages/compaction`、`packages/guard/timeout-policy` |
