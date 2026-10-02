# Agent Note: 在仓库之外用 bundle 强制四项建议性能力

Status: implemented

[English](2026-09-27-out-of-tree-capability-hardening.md) | 中文

## 问题

DeepSeek Harness 的四项能力只用文字约束 agent。计划模式只发布一段部署方拥有的提示词段落，而每个工具仍然可用；重复工具调用提醒从不否决调用；agent loop 没有轮次预算；skill 加载器的拒绝文案不给出下一步。需要把其中某一项变成强制约束的部署，没有任何可配置的缝。

把每项能力直接加固在它自己的归属包内，是最直接的路线，而在本 fork 里也是最昂贵的路线。上游同步靠"导入一棵新树"而不是 merge，因此对上游拥有的文件或生成物的改动，每次导入都要手工重放；而新增的文件或包则作为一个整体被导入或不导入。

计划模式让这笔成本变得具体。它的归属决策（[计划专用的协作状态](../simplification/2026-07-22-plan-specific-collaboration-state.zh.md)）拒绝了"按计划维护工具名白名单"，理由是可变性是每个工具自身的属性，而不是每个计划部署都要维护的一份清单；该决策把计划模式留作引导而非强制。在 `@deepseek-ai/dsh-plan-mode` 内部加入过滤，会让这项决策对**所有**部署反转，包括那些只想要引导的部署。

## 决策

`plugins/prism-guardrails` 是一个承载四条相互独立 rail 的仓库外 bundle。每条 rail 在对应配置键给出取值之前都是关闭的，而存在但不可用的键会让插件加载即失败，因此省略键是关闭该 rail 的唯一方式。每条 rail 都注册在文档化的扩展点上，并在那里自行裁决。

**计划模式按名字拒绝工具，且只在主动要求它的部署里生效。** 当 `PlanModeController.get()` 报告计划模式已激活、或已被选择而仍在等待下一个被接受的步骤时，`ctx.tools.guard()` 拒绝配置的工具名。用 guard 而不是 `tools/pre-execute` 监听器，是因为 guard 在整个可扩展的 pre-execute waterfall 之后求值且没有 allow 结果，任何其他插件的监听器顺序都无法把拒绝翻转回许可。归属包保持不变：计划模式仍然只发布引导、仍然不拥有任何名单，因此不做任何配置的部署看到的行为与旧决策所描述的完全一致。

**重复上一次相同调用的调用送交审批。** 连续相同调用超过 `repeatAskAfter` 次之后，`tools/pre-execute` 不再委托，而是返回 `{ kind: 'ask' }`。计数留在 `tools/post-execute`，因为被拒绝或被取消的调用同样会流经该 waterfall，所以持续冲击门禁的模型会不断撞上它，而它被告知的连续次数也会持续上升。用 `ask` 而不是 `deny`，是因为合法的长重复确实存在，只有人能把它与循环区分开；没有审批通道时，fail-closed 审批阶梯会拒绝该调用。批准不会重置连续链，因为批准是 `allowed-once`；用户插话会重置，因为跨越人类介入的重复不是循环。

**一轮不能开启超过部署允许的步骤数。** 步骤号超过 `maxStepsPerTurn` 后，`agent/pre-step` 返回 `{ kind: 'reject' }`。判据就是 pre-step payload 已经携带的步骤号，因此重试、被拒的步骤、resume、fork 都天然正确，无需计数、累加或重置。循环在 driver 唤醒时会重置该编号，所以预算按轮生效。

**仅用户可调用的 skill 在拒绝文案里指出出路。** 模型调用 `skill` 工具去加载一个"用户可调用、但模型不可调用"的目录条目时，拒绝文案是 `ask the user to type /<name> in their next message`。判据通过公开的 skill 注册表读取已解析的目录——与工具自身所做的是同一次查找；两个接口都不可调用的 skill 保留加载器自己的拒绝，因为此时没有出路可给。调用策略本身不变。

本 bundle 不声明任何运行时依赖。`src/` 里每一处对 harness 的导入都是 `import type`，在构建时被擦除，因此产物不含任何 import，全部通过已发布的服务与扩展点读取计划模式状态、skill 目录与工具流水线。

## 相关

- [计划专用的协作状态](../simplification/2026-07-22-plan-specific-collaboration-state.zh.md) 拥有计划模式的引导立场与被拒绝的白名单；本 bundle 增加一个可选加入的拒绝，不改动该包。
- [skill 调用策略](../feature/2026-07-28-skill-invocation-policy.zh.md) 拥有本 bundle 所读取的"模型 / 用户"两个调用轴。
- [工具调用三阶段](2026-09-22-tool-call-three-phases.zh.md) 拥有这些 rail 所注册的 pre-execute 与 post-execute waterfall 所在的工具调用流水线。
- [bundle README](../../../../plugins/prism-guardrails/README.zh.md) 拥有配置面、每条 rail 的确切行为与已知限制。

## 考虑过的替代方案

**把每项能力加固在它自己的归属包内。** 被否决，因为本 fork 每次导入上游树都要手工重放上游拥有的改动；而且计划模式那条 rail 会让一项有记录的决策对所有部署反转，而不是只对主动选择的部署生效。两种做法下归属包都保留各自已发布的契约。

**在 `packages/guard/` 下新增一个包。** 被否决，因为它需要手写 `tsconfig.base.json` 的 `paths` 条目并跑一次 workspace 安装才能存在；而本 bundle 自己的 `tsconfig.json` 就能解析检出目录已构建的声明文件，其 `vitest.config.ts` 也复用检出目录的 paths facade。等到仓库测试运行器必须收集这些测试时，包才是正确的形态。

**拒绝重复调用，而不是询问。** 被否决，因为合法的长重复确实存在——反复轮询同一个 `job_output`，或在外部进程改动后重复读同一文件——只有人能把它与循环区分开。拒绝会取消选择；审批为选择定价，而在没有通道的地方，fail-closed 阶梯本来就会给出拒绝。

**在 `agent-loop` 内部拒绝超预算的步骤。** 被否决，因为循环的文档写明它没有轮次预算，加入一个会改变所有 profile 的循环契约。pre-step waterfall 已经暴露了循环算出的步骤号，因此这个决策属于一个监听器。

**为预算维护一个按轮计数器。** 被否决，因为 pre-step payload 里的步骤号已经回答了这个问题，而计数器必须被推进、按轮重置，并与重试、拒绝、resume、fork 逐一调和。

**批准之后重置重复链。** 被否决，因为本 harness 的批准是 `allowed-once` 且不持久化；重置会让一次决定买下对同一次调用的无限次重复。

**让计划模式自己拥有被拒绝名单。** 被否决，理由正是旧决策记录的那一条：这份名单届时会作用于所有计划部署，而且它落在一个上游拥有的文件里，每次导入都要重放。

## 后果

每条 rail 都是附加且可选加入的，因此四个归属包都保留各自已发布的契约与有记录的决策，需要不同限额的部署只需改一行配置，而不必在每次上游导入时携带一份包补丁。计划模式那条 rail 比旧决策所拒绝的白名单更窄：它列的是要拒绝的工具而不是要允许的工具，也不读取任何工具元数据。拒绝 `write`、`edit`、`str_replace_editor` 的部署仍然可以用 `bash`，因为检出目录没有只读命令分类器，而拒绝 shell 会一并拒绝规划所依赖的 `git status` 一类检查。

本 bundle 位于仓库测试运行器之外。`plugins/` 不被检出目录的 `vitest.config.ts` 收集，因此这些 rail 在 bundle 自己的配置下运行，不参与 `pnpm run test`，也不进入逐文件覆盖率门禁。它的证据包括：一个加载产物的 artifact smoke；42 个针对生产工具流水线、生产 agent loop、真实计划模式控制器与真实 skill 注册表的组合测试；以及四次端到端运行——用真实 Loader 启动随附的 `headless` profile，并从构建产物加载本 bundle，在最终 session 事件上断言每条 rail 的强制效果。两种接线形式——随附的包名行，以及指向构建产物的 overlay——另外还通过 `dsh` CLI 本身各启动过一次，每条 rail 的拒绝都在真实单发运行中被观察到：计划模式拒绝被点名的工具；第 3、4 次相同调用撞上 fail-closed 审批阶梯；两步预算让该轮以 `blocked` 结束，因而在单发模式下以非零码退出；skill 加载器的拒绝文案给出 `/name` 手势。文档门禁确实会扫描该目录，这也是本 bundle 提供双语 README 对照件的原因。

重复调用 rail 的 `reason` 是写给审批人而不是写给模型的。当审批服务报告无通道时，工具注册表会替换成自己的 `requires approval, but no approval channel is available` 文案，因此无人值守部署用注册表的文案拒绝该调用；端到端运行固定的是这一结果，而不是本 bundle 的文案。

轮次预算那条 rail 用可恢复性换取了上界：被拒绝的步骤对模型不可见，因此日志是该轮为何停止的唯一记录。重复调用那条 rail 没有 `include` 或 `exclude` 工具模式，因此部署无法在不做进一步改动的情况下把某个轮询工具排除在计数之外。
