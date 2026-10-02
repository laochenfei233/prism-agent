# prism-guardrails

[English](README.md) | 中文

一个独立于仓库之外的 DeepSeek Harness bundle：把四项**建议性**能力变成**强制性**能力。

它的形态是"已发布插件"（`dsh.bundle.patch` + 一个可被 Loader 加载的 Host 半边），而不是对 Harness 检出目录的改动：每条 rail 都注册在文档化的扩展点上，没有改写任何上游包。

## 为什么需要它

| Rail | DeepSeek Harness 自带的行为 | 本 bundle 补充的行为 |
|---|---|---|
| 计划模式 | 只有一段提示词。`packages/plan/plan-mode/README.zh.md` 自称 "Guidance, not enforcement"，其背后的决策记录明确拒绝过按工具名过滤 | 一个单调 `tools.guard()`：计划模式生效期间拒绝部署声明的工具名 |
| 重复调用 | `@deepseek-ai/dsh-repeat-tool-reminder`：仅提醒，从不否决调用 | 连续相同调用达到配置次数后，下一次调用送交审批 |
| 轮次长度 | `packages/core/agent-loop/README.zh.md` 明说 "No built-in turn budget"，全仓库没有任何步数或迭代上限 | 一轮不能开启超过配置步数的步骤 |
| skill 调用 | 加载器抛出 `skill "X" is not available for model invocation`，没有给出下一步 | 拒绝文案指出真正能加载它的 `/name` 手势 |

本 bundle 与它所加固的包相互独立。它通过 plan-mode 控制器的公开 `get()` 读取计划状态、通过公开注册表读取 skill 目录、通过文档化的 waterfall 与 guard 缝进入工具流水线，因此能与一个未改动的检出目录组合，并在某个服务缺失时退化为空操作。

## 配置

每条 rail 在对应键给出取值之前都是**关闭**的，而**存在但不可用**的键会让插件**加载即失败**。因此省略键是关闭该 rail 的唯一方式，拼错的键无法冒充有意的省略。

| 键 | 类型 | 含义 | 默认 |
|---|---|---|---|
| `planDeniedTools` | 非空、互不相同、非空白的工具名数组 | 计划模式生效期间被拒绝的全局工具名 | rail 关闭 |
| `repeatAskAfter` | 整数 `0` 或 `>= 2` | 下一次调用送交审批前容许的连续相同调用次数；`0` 表示关闭 | rail 关闭 |
| `maxStepsPerTurn` | 整数 `>= 1` | 一轮最多可开启的步骤数 | rail 关闭 |
| `skillInvocationGuidance` | 布尔 | 模型调用"仅用户可调用"的 skill 被拒时，是否指出可行出路 | `true` |

加载期拒绝项（每条文案都由测试套件断言）：

| 输入 | 结果 |
|---|---|
| `planDeniedTools` 不是数组 | `planDeniedTools must be an array of tool names` |
| `planDeniedTools: []` | `planDeniedTools must not be empty — omit the key to disable the plan-mode rail` |
| 空白或非字符串条目 | `planDeniedTools entries must be non-empty tool names` |
| 重复的名字 | `planDeniedTools names "write" twice` |
| `repeatAskAfter` 非整数或 `< 0` | `repeatAskAfter must be an integer >= 0` |
| `repeatAskAfter: 1` | `repeatAskAfter must be 0 (off) or >= 2 — one call is not a loop` |
| `maxStepsPerTurn` 非整数或 `< 1` | `maxStepsPerTurn must be an integer >= 1` |
| `skillInvocationGuidance` 非布尔 | `skillInvocationGuidance must be a boolean` |
| 其他任意键 | `unknown config key(s) …` |

## 各条 rail

### 计划模式工具拒绝

注册方式是 `ctx.tools.guard()`，而不是 `tools/pre-execute` 监听器。guard 在整个可扩展的 pre-execute waterfall 之后求值，且没有 allow 结果，因此任何其他插件的监听器顺序都无法把拒绝翻转回许可。

guard 读取 `PlanModeController.get()`——与计划提示词段落**同一个**"已记录 + 已选择"判据——因此仍在等待下一个被接受步骤的选择，此刻就已经生效。拒绝文案形如：

```
Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off
```

未挂载 plan-mode 服务的部署什么都不会被限制：这条 rail 没有自己的状态可供臆造。随附 patch 刻意不包含 `bash` 与 `pwsh`——检出目录没有只读命令分类器，拒绝它们会一并拒绝规划阶段赖以开展的 `git status` 一类检查。

### 重复调用审批

连续相同调用达到 `repeatAskAfter` 次之后的那次调用，会作为 `tools/pre-execute` 的 `{ kind: 'ask' }` 返回，由人来为这次重复定价。计数留在 `tools/post-execute`，因为被拒绝或被取消的调用同样会流经该 waterfall——持续冲击门禁的模型会不断撞上它，而它被告知的连续次数也会持续上升。

用 `ask` 而非 `deny`，是因为合法的长重复确实存在：反复轮询同一个 `job_output`，或在外部进程改动后重复读同一文件。只有人能把它与循环区分开；拒绝会取消选择，而不是为选择定价。没有审批通道时，fail-closed 审批阶梯会拒绝该调用，这正是无人值守场景下的预期结果。

另有两处决策是承重的。批准**不会**重置连续链：批准本就是 `allowed-once`，重置等于让一次决定买下无限次重复。用户插话**会**重置它，因为跨越人类介入的重复不是循环。

调用身份 = 工具名 + 参数（对象键做深排序），因此仅属性顺序不同的两次调用是同一次调用。

本 rail 提供的 `reason` 是给审批人读的。当审批服务报告"无通道"时，模型读到的不是它：工具注册表会替换成 `tool "<name>" requires approval, but no approval channel is available`，因此无人值守部署用注册表的文案拒绝该调用，而不是本 rail 的文案。

### 步数预算

步骤号超过 `maxStepsPerTurn` 后，`agent/pre-step` 返回 `{ kind: 'reject' }`，并记录轮次、预算和被拒绝的步骤号。

判据就是循环已经携带在 pre-step payload 里的步骤号，所以这里不计数、不累加、不重置：重试、被拒的 pre-step、resume、fork 全部天然正确。循环在 driver 唤醒时会重置该编号，因此预算按轮生效——第二轮从新的预算开始。

被拒绝的步骤对模型不可见，因此日志是该轮为何提前结束的唯一记录。一次 `dsh --profile headless` 单发运行若因此被截断，会以非零码退出：runner 只在该轮以 `completed` 结束时退出 `0`，而预算拒绝让该轮以 `blocked` 结束。

### skill 调用引导

当模型用 `skill` 工具调用一个目录条目为"用户可调用、但模型不可调用"的 skill 时，拒绝文案给出可行手势：

```
Error: skill "user-only" is user-invoked only: ask the user to type /user-only in their next message
```

判据来自通过公开注册表读取的已解析目录——与 skill 工具自身所做的是同一次查找。两个接口都不可调用的 skill 保留加载器自己的拒绝，因为此时没有出路可给，编造一个会是错的。未知名字、调用的是另一个工具、`name` 参数缺失/非字符串/为空、未挂载 skill 服务、以及 `skillInvocationGuidance: false` 的部署，全部原样委托。

## 接线

本 bundle 在 profile 根之上插入一行，`cordis.patch.yml` 以包名发布该行——这是 bundle 被安装或发布后 profile 能解析的形式。下面两种形式都已对随附的 `headless` profile 真实启动验证过。

**以包名安装。** 让 profile 能解析到构建产物（安装或链接），然后启动：

```sh
cd plugins/prism-guardrails && npm run build
node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch plugins/prism-guardrails/cordis.patch.yml "<task>"
```

**未安装。** `loadOverlayPatches` 会把相对或绝对的 `name` 改写成锚定在 patch 文件旁的 `file://` URL，因此与 bundle 放在一起的 overlay 可以直接指向构建产物——无需安装，也不需要是 workspace 成员：

```yaml
- insert:
    - id: prism-guardrails
      name: '../../lib/index.js'
      config:
        planDeniedTools: [write, edit, str_replace_editor]
        repeatAskAfter: 5
        maxStepsPerTurn: 20
        skillInvocationGuidance: true
```

`tests/fixtures/cli-boot.patch.yml` 正是这个 overlay，它让计划模式这条 rail 走产品自己的单发路径：

```sh
node --import tsx/esm apps/cli/src/bin.ts --profile headless \
  --patch plugins/prism-guardrails/tests/fixtures/cli-boot.patch.yml --json "probe the rails"
```

```json
{"type":"tool_result","callId":"cap-1","status":"error","result":"Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off"}
{"type":"final","text":"planning complete"}
```

## 构建与验证

本 bundle 借用检出目录的包，而不声明 workspace 依赖：`src/` 里每一处 `@deepseek-ai/*` 导入都是 `import type`，因此产物不含任何 import，部署时无需安装任何东西。`tsconfig.json` 通过检出目录**已构建的**声明文件解析这些类型，这也正是仓库内各包彼此消费的方式——请先在检出目录里执行 `pnpm run build`。

```sh
npm run typecheck   # tsc against the checkout's built declarations: exit 0
npm run build       # lib/index.js, no runtime imports
npm run smoke       # artifact: exports, registered surfaces, fail-loud config
npm test            # 42 composed unit tests
npm run test:e2e    # 4 end-to-end capability runs against the shipped headless profile
```

`vitest.config.ts` 复用检出目录的 `tsconfig.base.json` paths facade 与装饰器预转换，因此 `tests/prism-guardrails.spec.ts` 组合的是**真实**服务——生产工具流水线、对脚本化 mock adapter 的生产 agent loop、真实 plan-mode 控制器、真实 skill 注册表——而不是为扩展点手搭的替身。断言落在模型可见的工具结果、实际产生的副作用与请求次数上。

`tests/capability.e2e.spec.ts` 更进一层：它用真实 Loader 启动随附的 **headless** profile，并以相对路径从构建产物加载本 bundle；模型由 mock adapter 脚本驱动，断言落在最终 session 事件上——计划模式的拒绝文案、两次放行后连续两次被拒的重复调用、在步数预算处 `blocked` 结束的一轮、以及"仅用户可调用"skill 的引导文案。该运行也是 overlay fixture 关掉会话标题 provider 的原因：它会通过同一路由发起自己的模型调用。

Vitest 需要 vite 在 Windows 上的 real-path 探测去启动子进程，而受限的文件沙箱会拒绝该操作；请在沙箱之外运行它。

## 已知限制与待办

- **本 bundle 在仓库测试运行器之外。** 它位于 `plugins/`，检出目录的 `vitest.config.ts` 不收集该目录，因此它自带配置，不参与 `pnpm run test` 与逐文件覆盖率门禁。它的证据是上面那两套测试，而不是 CI。
- **`skillNameArgument` 的非对象防护在当前工具集下不可达。** 注册表会在 pre-execute waterfall 之前用工具编译后的对象 schema 校验调用，因此非对象的参数列表会先被拒绝——测试套件固定了这一拒绝行为。保留这两行是为了让函数在模型 tool-JSON 边界上保持全定义，而不是在监听器里抛错（那会让该工具的每一次调用都失败）。
- **重复 rail 没有 `include`/`exclude` 模式。** `@deepseek-ai/dsh-repeat-tool-reminder` 提供通配符工具选择，本 rail 不提供；需要它的部署应先给出具体消费者。
- **未实现推理链层面的循环治理。** 本 bundle 只按"工具名 + 参数"检测重复。检测重复的**推理**前缀、并把污染区间从请求视图中裁掉（日志保留完整轨迹）是另一项更大的能力。
- **随附默认值是部署策略，不是推荐值。** `planDeniedTools`、`repeatAskAfter: 5`、`maxStepsPerTurn: 20` 取自本 fork 的 `CAPABILITY-PLAN.md`；不认同的部署请直接改这一行。
- **`plugins/` 不要求中文 README 对照件。** 仓库的 translation-pairing 门禁已经把同级的 `plugins/dsh-agent-progress/` 报为缺少对照件；本 bundle 主动提供对照件，因此不新增失败项。
