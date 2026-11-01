# prism-guardrails

[English](README.md) | 中文

一个独立于仓库之外的 DeepSeek Harness bundle：把十项**建议性**能力变成**强制性**能力。

它的形态是"已发布插件"（`dsh.bundle.patch` + 一个可被 Loader 加载的 Host 半边），而不是对 Harness 检出目录的改动：每条 rail 都注册在文档化的扩展点上，没有改写任何上游包。

十条之中有四条是对 DeepSeek Harness 自带建议的加固，其余六条把三个方法包——**Ponytail**（偷懒阶梯：先复用再新写、先用标准库再引依赖、宁可标注捷径也不要默默留下它）、**Aegis**（先定路线再动手、先验证再声称完成）与 **Compose Next**（先写完自己排的计划再汇报）——的规则，从"要求模型遵守的文字"变成"工具流水线做出的判定"。rail 只读模型做了什么；Ponytail 模式本身属于本 bundle（见下文「Ponytail 模式」），Aegis 与 Compose Next 的 skill 仍留在其方法包安装的位置。

## 为什么需要它

| Rail | 单独使用时的固有行为 | 本 bundle 补充的行为 |
|---|---|---|
| 计划模式 | 只有一段提示词。`packages/plan/plan-mode/README.zh.md` 自称 "Guidance, not enforcement"，其背后的决策记录明确拒绝过按工具名过滤 | 一个单调 `tools.guard()`：计划模式生效期间拒绝部署声明的工具名 |
| 重复调用 | `@deepseek-ai/dsh-repeat-tool-reminder`：仅提醒，从不否决调用 | 连续相同调用达到配置次数后，下一次调用送交审批 |
| 轮次长度 | `packages/core/agent-loop/README.zh.md` 明说 "No built-in turn budget"，全仓库没有任何步数或迭代上限 | 一轮不能开启超过配置步数的步骤 |
| skill 调用 | 加载器抛出 `skill "X" is not available for model invocation`，没有给出下一步 | 拒绝文案指出真正能加载它的 `/name` 手势 |
| 路由（Aegis） | 方法包要求模型在首个非只读调用前给出路由决策；在它的其他宿主上，**破坏契约之后**才追加一个标记 | 在决策落档之前，该调用本身被拒绝 |
| 写盘广度（Ponytail） | 阶梯偏好复用已有 helper 而非新写，但背后没有任何机制 | 一轮写入的不同文件数超过部署额度后，下一条新路径送交审批 |
| 标记纪律（Ponytail） | 约定是 `shortcut: <ceiling>, <upgrade path>`（旧代码写作 `ponytail:`）；方法包自己的债务报告把"没有触发条件"的标记标为会腐烂的那一类 | 没有 upgrade path 的标记在写入之前就被拒绝 |
| 依赖变更（Ponytail） | "几行代码能做的，绝不新增依赖"只是一句散文 | 对依赖清单的写入送交审批 |
| 完成验证（Aegis） | `verification-before-completion` 把所需证据写在"要求模型去加载"的 skill 里 | 一轮写了文件却没跑验证时，在它能停下之前被送回补证据 |
| 轮次完成（Compose Next） | 工作流要求模型做完自己的任务并给出交付证据；但只要模型不再调用工具，循环照样结束该轮 | 模型自己写的 todo 清单里还有未完成项时，在它能停下之前被 steer 继续 |

本 bundle 与它所加固的包和方法包相互独立。它通过 plan-mode 控制器的公开 `get()` 读取计划状态、通过公开注册表读取 skill 目录、通过文档化的扩展点进入工具流水线、轮次边界与会话日志，因此能与一个未改动的检出目录组合，并在某个服务缺失时退化为空操作。

## Ponytail 模式

方法包自身的行为成为本 bundle 的一部分，而不是需要宿主另行安装的 skill。bundle patch 在 profile 中挂载第二行（`prism-guardrails-ponytail`，name 为 `prism-guardrails/ponytail`），因此每种 agent preset 下都存在：一个 system-prompt 段落陈述当前档位的规则，原先由 skill 描述的斜杠命令变成真实注册。

| 档位 | 效果 |
|---|---|
| `lite` | 只做被要求的事，并用一行说出你没采取的那个更小方案 |
| `full` | 完整阶梯，该有检查的逻辑留一个检查，回复里写明跳过了什么、有什么风险（默认） |
| `ultra` | 在 `full` 之上，对需求中必要性不足的部分先提出反对 |
| `off` | 不贡献段落；rail 与命令仍然挂载 |

| 命令 | 效果 |
|---|---|
| `/ponytail [lite\|full\|ultra\|off\|auto]` | 显示或切换档位；`auto` 取消显式选择，不带参数时打印当前档位与完整手势 |
| `/ponytail-debt [标记词]` | 扫描会话工作目录里的 `shortcut:`/`ponytail:` 标记并输出账本，给没有升级触发的行标 `[no-trigger]` |
| `/ponytail-review` | 把 agent 引入变更评审流程（正确性、安全、负载、测试、速度、精简） |
| `/ponytail-audit` | 对整仓库执行同一套流程 |
| `/ponytail-gain` | 官方基准记分板，附其诚实边界 |
| `/ponytail-help` | 参考卡片 |

工作中的会话会自动落到 `lite`，不需要任何命令：

| 规则 | 触发条件 | 结果 |
|---|---|---|
| coding preset | 会话创建时、或切换后运行在 `autoCodingPresets` 列出的 preset 下（默认 `standard`、`ptc`） | `lite` |
| 长任务 | 会话累计开启 `autoLongTaskSteps` 步（默认 20；`0` 关闭该规则） | `lite` |

对该会话而言，显式 `/ponytail` 选择优先于这两条规则；`/ponytail auto` 取消选择、让规则重新生效。档位在每次装配时按会话自身状态解析，因此一个正在跑 `lite` 的 coding 会话不会改变旁边会话的档位；行配置里的 `level:` 是起始值与兜底值。`index.ts` 里的 rail 仍是执行的那一半——模式陈述规则，rail 拒绝违反规则的写入，因此切换档位不会放宽工具流水线接受的写入。

提示词与工作流维护在这里，而不是从方法包的 `SKILL.md` 搬入：改措辞就是改 `src/ponytail.ts`，profile 里的其他东西都不用动。

## 配置

每条 rail 在对应键给出取值之前都是**关闭**的，而**存在但不可用**的键会让插件**加载即失败**。因此省略键是关闭该 rail 的唯一方式，拼错的键无法冒充有意的省略。

| 键 | 类型 | 含义 | 默认 |
|---|---|---|---|
| `planDeniedTools` | 非空、互不相同、非空白的工具名数组 | 计划模式生效期间被拒绝的全局工具名 | rail 关闭 |
| `repeatAskAfter` | 整数 `0` 或 `>= 2` | 下一次调用送交审批前容许的连续相同调用次数；`0` 表示关闭 | rail 关闭 |
| `maxStepsPerTurn` | 整数 `>= 1` | 一轮最多可开启的步骤数 | rail 关闭 |
| `unfinishedTodoContinuations` | 整数 `>= 0` | 一轮因为模型自己的 todo 清单仍有未完成项而被送回继续的次数；`0` 表示关闭 | rail 关闭 |
| `skillInvocationGuidance` | 布尔 | 模型调用"仅用户可调用"的 skill 被拒时，是否指出可行出路 | `true` |
| `writeTools` | 非空的 `{ tool, pathArgument, contentArgument? }` 数组 | 该部署的写文件工具；所有需要读取写入内容的 rail 都以它为前置 | 由这些 rail 要求 |
| `maxWrittenFilesPerTurn` | 整数 `>= 0` | 一轮可写入的不同文件数；超出后下一条新路径送交审批，`0` 表示关闭 | rail 关闭 |
| `requirePonytailUpgradePaths` | 布尔 | 写入的 `shortcut:` 注释（较早的 `ponytail:`）是否必须给出上限与升级路径 | `false` |
| `dependencyManifests` | 非空、互不相同、非空白的文件名数组 | 写入这些文件名时送交审批 | rail 关闭 |
| `routingContract.readOnlyTools` | 非空、互不相同、非空白的工具名数组 | 只做读取的工具；调用其他任何工具即为契约触发点 | rail 关闭 |
| `verificationGate.verifyTools` | 非空、互不相同、非空白的工具名数组 | 其成功调用被认可为验证的工具 | rail 关闭 |

`writeTools` 条目填写的是该工具**自己**的参数键，因此参数名不同的部署是被"配置"而不是被"特判"。对 DeepSeek Harness 自带的工具集而言即 `{ tool: write, pathArgument: file_path, contentArgument: content }` 与 `{ tool: edit, pathArgument: file_path, contentArgument: new_string }`；不携带文本的工具省略 `contentArgument`。

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
| `unfinishedTodoContinuations` 非整数或 `< 0` | `unfinishedTodoContinuations must be an integer >= 0` |
| `skillInvocationGuidance` 非布尔 | `skillInvocationGuidance must be a boolean` |
| `writeTools` 不是数组或为空 | `writeTools must be an array of { tool, pathArgument, contentArgument? } entries` |
| 条目没有给出工具名或路径参数 | `writeTools entries must name a tool` / `writeTools entry "write" must name its pathArgument` |
| `contentArgument` 为空白 | `writeTools entry "write" must name a non-empty contentArgument or omit it` |
| 重复的工具名 | `writeTools names "write" twice` |
| 未知的条目键 | `unknown writeTools key(s) …` |
| `maxWrittenFilesPerTurn` 非整数或 `< 0` | `maxWrittenFilesPerTurn must be an integer >= 0` |
| `requirePonytailUpgradePaths` 非布尔 | `requirePonytailUpgradePaths must be a boolean` |
| `dependencyManifests` 为空、空白或重复 | `dependencyManifests must not be empty — omit the key to disable the dependency rail`、`… entries must be non-empty file names`、`… names "package.json" twice` |
| `routingContract` 不是对象或含未知键 | `routingContract must be an object { readOnlyTools }`、`unknown routingContract key(s) …` |
| `verificationGate` 不是对象或含未知键 | `verificationGate must be an object { verifyTools }`、`unknown verificationGate key(s) …` |
| `readOnlyTools` / `verifyTools` 为空 | `… must be a non-empty array of tool names` |
| 开启读写入内容的 rail 却没有 `writeTools` | `… all read written files — name writeTools as well` |
| 开启 `requirePonytailUpgradePaths` 却没有任何 `contentArgument` | `… at least one writeTools entry must name its contentArgument` |
| 其他任意键 | `unknown config key(s) …` |

最后两行是本 bundle 的跨字段规则：读取写入内容的 rail 自身不掌握任何工具知识，因此只开启 rail 而不声明工具的部署没有可执行的对象。这种情况在加载期就失败，而不是加载一条永不触发的 rail。

## 各条 rail

### 计划模式工具拒绝

注册方式是 `ctx.tools.guard()`，而不是 `tools/pre-execute` 监听器。guard 在整个可扩展的 pre-execute waterfall 之后求值，且没有 allow 结果，因此任何其他插件的监听器顺序都无法把拒绝翻转回许可。

guard 读取的是 `PlanModeController.get()`——与计划指引提示词分段使用的、同一个"已落档且已选中"判据——因此一个仍在等待下个被接受步骤的选中态已经会被拒绝。拒绝文案为：

```
Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off
```

没有挂载 plan-mode 服务的部署不受任何限制：这条 rail 没有自己的状态可供臆造。随附 patch 中刻意不含 `bash` 与 `pwsh`，因为检出目录里没有只读命令分类器，拒绝它们会连规划所依赖的 `git status` 一类查看也一并拒绝。

### 重复调用审批

连续 `repeatAskAfter` 次相同调用之后的那一次，由 `tools/pre-execute` 返回 `{ kind: 'ask' }`，让人类为这次重复定价。计数留在 `tools/post-execute`，因为被拒绝或被取消的调用同样会走这条 waterfall——持续撞击这道闸门的模型会不断遇到它，而被告知的连续次数也在持续攀升。

选择 `ask` 而不是 `deny`，是因为合法的长跑确实存在：轮询同一个 `job_output`，或复读一个被外部进程改动的文件。只有人类能把它们和死循环区分开，而拒绝等于取消了选择，而不是为选择定价。在没有审批通道时，故障关闭（fail-closed）的审批阶梯会拒绝该调用，这正是无人值守下期望的结果。

另有两个决策是承重的。审批**不会**重置连续计数：审批是 `allowed-once` 的，重置等于用一次决定换来无限次重复。而一条主张所有权的用户消息**会**重置它，因为跨越人类插话的重复不是死循环。

调用身份由"工具名 + 深度按键排序后的参数"构成，因此仅属性顺序不同的两次调用是同一次调用。

这条 rail 给出的 `reason` 是审批人读到的话。当审批服务报告无通道时，模型读到的并不是它：工具注册表会替换为 `tool "<name>" requires approval, but no approval channel is available`，因此无人值守部署是以注册表的措辞拒绝该调用的。

### 轮次预算

一旦步骤号超过 `maxStepsPerTurn`，`agent/pre-step` 返回 `{ kind: 'reject' }`，并记录轮次、预算与被拒的步骤号。

判据就是循环本身已携带在 pre-step 载荷里的步骤号，所以这里不计数、不推进、不重置：重试、被拒步骤、resume 与 fork 在构造上都是正确的。驱动被唤醒时循环会重置该编号，因此预算是按轮计算的——第二轮从全新预算开始。

被拒绝的步骤对模型不可见，因此这行日志是"这一轮为什么停下"的唯一记录。被这样截断的一轮，`dsh --profile headless` 一次性运行会以非零退出：运行器只在轮次以 `completed` 结束才退出 `0`，而预算拒绝让它以 `blocked` 结束。

### skill 调用指引

模型调用 `skill` 工具去加载一个"仅用户可调用、模型不可调用"的 skill 时，被拒绝并附上真正可行的手势：

```
Error: skill "user-only" is user-invoked only: ask the user to type /user-only in their next message
```

判定通过公开注册表读取已解析的目录——与 skill 工具执行的是同一次查找。两种接口都无法调用的 skill 保留加载器自己的拒绝，因为没有任何出路可言，臆造一条是错的。未知的名字、调用的是别的工具、`name` 参数缺失／非字符串／为空、没有挂载 skill 服务的部署、以及 `skillInvocationGuidance: false` 的部署，全部原样放行。

### 路由契约

对 `routingContract.readOnlyTools` 之外的工具的首次调用，在路由决策落档之前会被拒绝：

```
Error: the routing contract is not satisfied: `write` is the first non-readonly call of this session. Load the task's skill with the `skill` tool, or declare `Route: fast-path` with a one-line reason, then repeat this call.
```

两种决策都能满足契约，且都是按**会话**而不是按调用记录：一次对 `skill` 工具的调用，或一条文本中包含 `Route: fast-path` 的 assistant 消息。声明是从已落档的 `assistant/message` 会话事件读取的，而不是从流式尝试读取，因此一次被重试或被丢弃的尝试无法满足契约。

`Route: fast-path` 是协议常量而非配置项。它是 Aegis 方法包两侧共同约定的措辞，改写它的部署等于向模型索要一句该方法包自己的 skill 并不提及的话。

一次拒绝的代价是一次往返，而不是死循环：模型给出决策，而给出决策本身就是被放行的调用。当声明与它前置的调用出现在同一响应里时，闸门在第一次尝试上就满足；当声明出现在调用之后时，模型看到一次拒绝并重发该调用。既没加载 skill 也没声明路由的模型，则会被重复调用 rail 接住。

记录在 `compaction/end` 时清除，因为模型的下一次请求已不再携带它当初做出的决策。记录按会话为键，因此一个会话的决策不会为另一个会话背书；agent 被释放时记录也随之清除。

### 写盘预算

让一条新路径成为本轮第 `maxWrittenFilesPerTurn + 1` 个不同文件的调用，会送交审批：

```
this turn has already written 8 distinct files and `write` would make `src/late.ts` the 9th, beyond the 8 the deployment allows; approve only if the wider change is intended
```

计数的是不同**路径**，不是写入次数，因此反复编辑同一个文件的一轮不会因为编辑本身被计价——广度才是未经审阅的一轮 diff 无法挽回的东西。已在集合中的路径是免费的。

只有未报错完成的调用才会花掉预算。被拒绝或失败的调用同样会走到 `tools/post-execute`，把它计入等于把预算花在从未落盘的写入上——一个不断提出新路径的模型会在什么都没写的情况下耗尽额度。

轮次编号与已写路径集合存放在同一份按轮记录里，由循环自己的 `agent/pre-step` 载荷推进。这里不数轮次：当循环开启一个记录没见过的轮次时记录恰好被重置，因此重试、被拒步骤、resume 与 fork 在构造上保持正确。

### Ponytail 标记纪律

写入文本中含有"注释前缀 + `shortcut:`"标记、却没有给出升级路径的写入会被拒绝：

```
Error: `src/lock.ts` writes a `shortcut:` marker with no upgrade path: "global lock". The convention is `shortcut: <ceiling>, <upgrade path>` (older code says `ponytail:`); name the limit and the trigger that would revisit it, or delete the marker.
```

约定是一个分隔符加其后的内容——`shortcut: global lock, per-account locks if throughput matters` 被接受，`shortcut: global lock` 不被接受。当前前缀 `shortcut:` 与较早的 `ponytail:` 都会被读取，且写入文本里的每一行标记都会被读取，不只第一行。

拒绝写入是修补免费的唯一点：文件一旦落盘，没有触发条件的标记就是一条没人会读的债务条目。只有带注释前缀的标记才算数，因此仅仅提及该约定的散文——包括本文件自己的 JSDoc——不是标记。

### 依赖审批

文件名命中 `dependencyManifests` 的写入会送交审批，按任一分隔符下的最后一段路径匹配：

```
`write` changes the dependency manifest `package.json`; approve only if the new dependency is genuinely needed rather than already covered by the standard library, the platform, or a library this project already depends on
```

阶梯把标准库、平台能力、以及项目已依赖的库放在新依赖之前，而对清单的写入正是这个次序真正被花掉的地方。为这次写入定价，等于在替代方案仍然便宜的唯一时机把它摆到人类面前。

### 完成验证闸门

写了文件却没跑验证的一轮，会在它的停止边界被打断：

```
This turn wrote src/lock.ts and ran no verification (`bash`, `pwsh`). Run the check that would fail if the change is wrong, then report what you ran, its result, what it covers, and what remains unverified — or say plainly why no check is available. Do not claim the work is complete until then.
```

停止边界没有否决权——DeepSeek Harness 里没有任何东西能拒绝 assistant 的最终文本——因此这条 rail 使用机器自身的继续通道：在 `agent/turn-stopping` 处 steer，会让循环观察到待处理输入并再跑一步。这正是 `packages/hooks/hooks-claude-code` 为阻塞式 `Stop` hook 所用的机制。

对任一 `verifyTools` 工具的**成功完成**调用即为证据，且**失败**的检查也算数：这条 rail 问的是"有没有跑过检查"，而不是"检查是否通过"，而一份"检查失败"的报告恰恰是这道闸门存在的意义所在。

一轮最多被打断一次。忽略该请求的模型会在下一个边界停下，而不是陷入循环，因此最坏情况是多花一步。

### 未完成 todo 闸门

模型自己的 todo 清单里仍有 `pending` 或 `in_progress` 项的一轮，会在它的停止边界被打断：

```
Your todo list still has 3 unfinished item(s): "T2 make Shortcuts.invoke return ShortcutResolution | undefined", "T3 command palette (store, component, locale, command)", "T4 region landmarks in workspace, conversation, sidebar-right". Continue with the next one, and rewrite the list when an item is no longer needed. Report the work as complete only when every item is completed or removed with its reason; if an item is blocked on a human decision, say which decision and why.
```

这份清单是模型通过 `todo_write` 为自己排的计划，因此"停下时还有未完成项"就等于这一轮在半途结束——长实施跑到一半汇报"进展"而不是"完成"时就是这个形状。DeepSeek Harness 没有任何东西阻止这次停止：模型不再调用工具，一轮就结束，日志里只留下 `turn/end` 的 `completed`，与诚实的完成一模一样。这条 rail 补的正是这个缺口，机制沿用完成验证闸门：在 `agent/turn-stopping` 处 steer，会让循环观察到待处理输入并再跑一步。

快照从会话日志读取，因此恢复、分叉或被压缩过的会话按它实际持有的清单判定；从未写过清单的会话不受影响。`unfinishedTodoContinuations` 限定每轮可被送回的次数——一直带着未完成项停下的模型用满额度后，下一个边界不再被打断，最坏情况是多花这么多步，而不是循环。

## 接线

本 bundle 在 profile 根之上打一行 patch，`cordis.patch.yml` 以包名形式随附这一行——即 bundle 被安装或发布后 profile 能解析的形态。下面两种形态都针对随附的 `headless` profile 真实启动过。

**以包名安装。** 链接或安装构建产物，让 profile 能解析它，然后启动：

```sh
cd plugins/prism-guardrails && npm run build
node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch plugins/prism-guardrails/cordis.patch.yml "<task>"
```

**未安装。** `loadOverlayPatches` 会把相对或绝对的 `name` 改写成锚定在 patch 文件旁边的 `file://` URL，因此随 bundle 一起提供的 overlay 直接指向构建入口——无需安装，也无需成为 workspace 成员：

```yaml
- insert:
    - id: prism-guardrails
      name: '../../lib/index.js'
      config:
        planDeniedTools: [write, edit, str_replace_editor]
        repeatAskAfter: 5
        maxStepsPerTurn: 200
        unfinishedTodoContinuations: 3
        skillInvocationGuidance: true
        writeTools:
          - { tool: write, pathArgument: file_path, contentArgument: content }
          - { tool: edit, pathArgument: file_path, contentArgument: new_string }
        maxWrittenFilesPerTurn: 8
        requirePonytailUpgradePaths: true
        dependencyManifests: [package.json]
        routingContract:
          readOnlyTools: [read, read_image, glob, grep]
        verificationGate:
          verifyTools: [bash, pwsh]
```

`tests/fixtures/cli-boot.patch.yml` 就是这种形态的 overlay，它让计划模式 rail 走完产品自己的一次性路径：

```sh
node --import tsx/esm apps/cli/src/bin.ts --profile headless \
  --patch plugins/prism-guardrails/tests/fixtures/cli-boot.patch.yml --json "probe the rails"
```

```json
{"type":"tool_result","callId":"cap-1","status":"error","result":"Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off"}
{"type":"final","text":"planning complete"}
```

## 构建与验证

本 bundle 借用检出目录里的包，而不声明 workspace 依赖。`src/` 里每一处 `@deepseek-ai/*` 导入都是 `import type`，只有一处例外——`createUserMessage`，完成验证闸门需要以值的形式用它来 steer agent——因此产物恰好携带这一个外部导入，由加载它的 profile 解析，部署本身不需要额外安装任何东西。`@deepseek-ai/dsh-llm` 因此是本 bundle 唯一的 peer dependency。

`tsconfig.json` 通过检出目录的**已构建**声明解析这些类型，这也是仓库内各包互相消费的方式——请先在检出目录里跑 `pnpm run build`。`tsdown.config.ts` 让 `@deepseek-ai/*` 保持外部，与同级的 `plugins/prism-memory` 一致：打包进副本会在 harness 依赖的跨实例身份上遮蔽 profile 自己的服务实例。

```sh
npm run typecheck   # tsc against the checkout's built declarations: exit 0
npm run build       # lib/index.js with one external harness import
npm run smoke       # artifact: imports, exports, fail-loud config
npm test            # 93 composed unit tests
npm run test:e2e    # 4 end-to-end capability runs against the shipped headless profile
```

`vitest.config.ts` 复用了检出目录 `tsconfig.base.json` 的 paths 门面与装饰器预处理，因此 `tests/prism-guardrails.spec.ts` 组合的是**真实**服务——生产工具流水线、脚本化 mock adapter 驱动的生产 agent 循环、真实 plan-mode 控制器、真实 skill 注册表、以及循环自身的停止边界——而不是为扩展点手搭的替身。断言落在模型可见的工具结果、实际发生的效果、以及请求次数上。

`tests/capability.e2e.spec.ts` 更进一步：它通过真实 Loader 启动随附的 **headless** profile，以相对路径从构建产物加载本 bundle，用 mock adapter 脚本化模型，并在产生的会话事件里断言每条 rail 的强制力——计划模式拒绝文案、两次被允许后两次被拒的重复调用、以 `blocked` 结束于步骤预算的一轮、以及"仅用户可调用" skill 的指引。这次运行正是 overlay fixture 关闭会话标题提供者的原因：它会通过同一条路由发出自己的模型调用。它同时也是"构建产物那一个外部导入在真实 profile 中可解析"的证明。

`scripts/smoke.mjs` 对构建产物的文本做断言，而不执行它——产物导入的是 profile 的 harness 包，一个没有 profile 安装的检出目录无法解析它。rail 的注册由 Vitest 套件负责验证。

Vitest 需要 vite 在 Windows 上的 real-path 探测去启动子进程，而受限的文件沙箱会拒绝它；请在沙箱之外运行。

## 已知限制与待办

- **本 bundle 在仓库测试运行器之外。** 它位于 `plugins/`，检出目录的 `vitest.config.ts` 不收集该目录，因此它自带配置，也不参与 `pnpm run test` 或逐文件覆盖率门禁。它的证据是上述套件，而不是 CI。
- **写入路径按调用写下的原样比较。** `a.ts` 与 `./a.ts` 是两条路径，会花掉写盘预算里的两个文件。要规范化它们，需要用调用的工作目录去解析文件系统，那会给这条 rail 一个它本不需要的 provider 依赖。完成验证闸门的文案报告的也是同样的字符串。
- **`writeTools` 每个工具只能声明一个内容参数。** 写入文本随命令落在不同参数里的工具——`str_replace_editor` 的 `create` 用 `file_text`、`str_replace` 用 `new_str`——不在标记纪律覆盖范围内，随附 patch 也因此把它排除在 `writeTools` 之外。要覆盖它需要一个按命令映射的参数表，而目前没有任何消费者提出这个需求。
- **路由记录在整个会话内闭锁。** 一个会话声明过一次 `Route: fast-path` 后，直到 `compaction/end` 都不会再被追问。要检测"这次声明已不再适用于当前任务"，是比一道闸门能从一条消息里推断的更大的能力。
- **完成验证闸门只能请求，无法强制。** 停止边界没有否决权，因此无视 steer 直接停下的模型照样会结束该轮。这条 rail 的强制力是"多一步 + 一条明确的请求"，而不是拒绝；只有工具流水线能拒绝，而它对最终文本没有发言权。
- **完成验证闸门不检查它所索要的证据内容。** 它只检查某个 `verifyTools` 调用完成了，不检查模型随后给出的结论是否与那个结果相符。
- **未完成 todo 闸门读的是模型自己写的清单。** 模型在停下前把所有项标成 `completed` 就能结束该轮，因此这道闸门换来的是"对计划的注意力"，而不是"计划确实被执行"的证明。清单还会跨轮保留，所以上一轮遗留的未完成项会把后面某一轮也推开，直到模型把它关闭或重写。它也区分不了"为提问而停"和"提前收工而停"：唯一压力是那几次有上限的 steer，而它要求的回应——说明被卡住的是哪一项、等的是哪个决定——仍然是模型自己的文字。
- **`skillNameArgument` 的非对象防护在当前工具集下不可达。** 注册表会在 pre-execute waterfall 之前用工具编译后的对象 schema 校验调用，因此非对象的参数列表会先被拒绝——测试套件固定了这一拒绝行为。保留这两行是为了让函数在模型 tool-JSON 边界上保持全定义，而不是在监听器里抛错（那会让该工具的每一次调用都失败）。
- **重复 rail 没有 `include`/`exclude` 模式。** `@deepseek-ai/dsh-repeat-tool-reminder` 提供通配符工具选择，本 rail 不提供；需要它的部署应先给出具体消费者。
- **未实现推理链层面的循环治理。** 本 bundle 只按"工具名 + 参数"检测重复。检测重复的**推理**前缀、并把污染区间从请求视图中裁掉（日志保留完整轨迹）是另一项更大的能力。
- **随附默认值是部署策略，不是推荐值。** `planDeniedTools` 与 `repeatAskAfter: 5` 取自本 fork 的 `CAPABILITY-PLAN.md`。`maxStepsPerTurn: 200` 是失控兜底，而不是日常工作上限：计划里的 `20` 在本 fork 自己的部署中截断了 20 个 turn 里的 11 个，每个都在约一分钟的工作后被截断，且没有任何一个 turn 是在该上限处自然结束的。`maxWrittenFilesPerTurn: 8` 与路由契约的只读列表，是本 bundle 对 DeepSeek Harness 工具集的第一次取值；不认同的部署请直接改这一行。`unfinishedTodoContinuations: 3` 同理：足够把一次"汇报进展式停下"推回工作，又不至于让永远做不完的模型一直跑下去。
- **`plugins/` 不要求中文 README 对照件。** 仓库的 translation-pairing 门禁已经把同级的 `plugins/dsh-agent-progress/` 报为缺少对照件；本 bundle 主动提供对照件，因此不新增失败项。
