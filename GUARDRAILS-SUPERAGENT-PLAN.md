# prism-guardrails × dsh-superagent-prototype 迁移方案

**这份文档是什么**：一份可行性判断加分档落地规格。问题来自一句提问——[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的做法里，有没有能拿来做一版、增强 `plugins/prism-guardrails` 的东西。写给后续动手实现的人：每条结论都带出处，没有出处的地方明说"未验证"。

**结论先说**：能做，但能迁移的不是它的产品形态，而是它的**决策层四件套**（决定做成对象、强度与执行模式分离、授权带依据、策略版本）。四件里三件值得做，一件（授权重校验）这里判定**不做**。按价值除以代价排序，P0 是一个约 200 行的改动：一条 rail 决策台账 + 一个全局 `observe` 模式 + 一个配置版本号，三者共用 `/guardrails` 一个出口。

**为什么不是"抄它一个 rail"**：原型里没有 guardrails 缺的那种单点拦截。它有的是另一种东西——`off | observe | auto` 的执行模式、带依据的决策记录、可撤销重校验的授权。guardrails 缺的正好是这三样的外层。

---

## 1. 原型在做什么

一句话：**给一个 GitHub 仓库配一个主动式编码 agent**——监听 GitHub（可选飞书）→ 判定"这条消息算不算让 agent 干活" → 开一张工作项 → 在独立会话和独立目录里干活 → 回到原对话交付（通常是 PR），再配一个只列"需要人看的东西"的面板。它是一个 DSH bundle（`cordis.patch.yml` + 一层 Host 插件），不是 DSH 的改动。

它的自我定位是**注意力经济学**，不是安全：`docs/000-philosophy.md` 的第一条是"尽可能少占用人的注意力，尽可能多地给出价值"，每条消息、每个通知、每个设置都要证明自己的注意力成本。

阅读顺序：`docs/000`–`006`（设计意图按序递进），代码从 `src/policy.ts`（授权判定）、`src/core/`（领域模型）、`src/app/runtime.ts`（调度）三处切入即可。`docs/007-architecture.md`（70KB）是给改了代码的人看的，第一遍不必读。

**它不是护栏系统，这是关键区别**：guardrails 管"这一次工具调用要不要拦"，原型管"这次工作该不该开始、开始之后允许做到哪"。两者的交集在**决策怎么表达**，不在决策内容。

---

## 2. 四个可迁移机制

### M1 决策是对象，放行也要有依据

原型里每次判定都返回 `GateResult`：拒绝时是 `{ admissible: false, reason }`，放行时是 `{ admissible: true, strength, basis }`，`basis` 逐项记下"谁、在哪个 scope、命中了准入表的哪一格、评估模式是什么"（`src/policy.ts:189-211`，类型在 `src/core/ports.ts:7`）。**放行也有记录**——这是它和"拒绝时喊一声"最本质的差别。理由码表 `REASONS` 覆盖决策、触发器、结束语，但文件开头就说明 gates 也可以发自己的字面码（`src/core/reasons.ts:2-3`，`policy.ts:173,210` 里的 `not_human`、`not_a_member` 就是），所以它是"优先用码表"，不是封闭词表。

为什么对护栏有意义：guardrails 的十二个 rail 只产出"要发生的事"——给模型看的拒绝文本、给审批人看的理由文本、或者一条 steer。**"没拦"这件事什么都没留下**。连它自己都承认这点：turn budget 的拒绝"is not model-visible, so the log line is the only record of why the turn stopped"（`plugins/prism-guardrails/README.md:159`）。

### M2 强度阶梯与执行模式分离

原型把"这次工作有多强的授权"和"要不要真的执行"拆成两个维度。授权强度只有两级——`Strength = 'explicit' | 'inferred'`（`src/core/model.ts:96`）；准入判定的第三个结果是 `ignore`（`src/admission.ts:8`），文档里叫 "not admitted"，它不是强度，是没进入系统。执行侧是 `off` / `observe` / `auto`：`observe` 下**推断来的**候选照常评估、结论照常记下（"would accept" + 提案原文），但什么也不执行（`docs/002-authorization.md:91-101`，`src/policy.ts:55-58` 的 `would_accept`）。**显式请求在任何模式下都照做**（"Explicit requests work in every mode"，`docs/002-authorization.md:100`）——观察模式管的是"主动揽活"，不是"已被人点名的工作"。团队的切换路径因此是：`off` → `observe` 看它自己会揽什么 → 满意了再 `auto`。

为什么对护栏有意义：guardrails 的十二个 rail 是二值的——配置写上就真拦。部署者没法先看"这条 `sensitivePaths: [.env]` 到底会挡住什么"再决定要不要武装，只能靠被挡一次才知道。**这里的迁移是不对称的，得说清楚**：原型的 observe 只降"没被人点名的工作"这一档，因为显式请求已经有人背书；guardrails 没有这个分层，rail 面对的一切调用都同等对待，所以搬到护栏这边，observe 就是"所有 denial 都降成记录"。分层搬不过来，降档的动作搬得过来。

### M3 授权带依据，恢复前重校验（Mandate + revalidate）

授权不是一次放行终身有效：每个 Mandate 记下它的依据（通过哪个 scope、哪一格准入、哪条规则、什么强度），重新开工前用当前策略重算一遍；策略变了、发件人被移出名单、规则被禁用，授权就失效（`src/policy.ts:213-239`，`docs/002-authorization.md:131-141`）。

**这条在 guardrails 里没有对应物，但也不该硬搬**——见第 4 节的判定。

### M4 策略版本

`policyVersion()` 只对**影响授权判定**的设置取哈希：规则、接受模式、以及 `settings.policy.sources` 整块（每个 Source 的 allowed 名单、bot 名单、准入表都在里面），不包含模型、并发数、暂停状态这些改了也不该让旧决策失效的东西（`src/policy.ts:111-118`，`docs/002-authorization.md:109`）。版本变化时丢弃在跑的评估、把触发器重新排队，并通知受影响的在途工作项（`docs/002-authorization.md:111`）。

**哈希范围这件事在 M3 里是有后果的**：正因为整块 Source 策略都进了哈希，"把人从名单里删掉"才会让旧 Mandate 失效。只哈希准入表是不够的。

为什么对护栏有意义：`/guardrails` 报的是"当前配置"，但它报不出"这些拦截发生在哪份配置下"。配置只改一次就冻结在进程里，跨重启就没法把日志和配置对上了。

---

## 3. guardrails 的现状与缺口

十二个 rail 有**四种**出口形状，这点决定了台账要接几处（`plugins/prism-guardrails/src/index.ts:129-147`）：八处在 `tools/pre-execute` 返回 `{ kind: 'deny' }` 或 `{ kind: 'ask' }`；plan-mode 用的是 `ctx.tools.guard()`，返回的是一条拒绝字符串而不是决策对象（`:166-175`）；turn budget 在 `agent/pre-step` 返回 `{ kind: 'reject' }`（`:239-244`）；验证门与 todo 门在 `agent/turn-stopping` 上 `agent.steer()` 一条继续消息（`:460-476`、`:500-520`）。配置语义是"省略键即关闭，键在但不可用则加载失败"（`src/config.ts:1-15`）。`/guardrails` 把十二个 rail 的配置值打印一遍（`src/index.ts:819-848`）。

| 缺口 | 证据 |
|---|---|
| 没有试运行。rail 一武装就真拦，部署者无法先看它会拦什么 | 四种出口里没有"只记录"这一种 |
| 没有决策台账。拦了是模型可见文本，没拦是没发生 | `README.md:159` 自认 turn budget 只有一行日志 |
| 没有版本。拦截日志对不上当时的配置 | `/guardrails` 只报配置值 |
| 验证门只能"请"，不能"要" | `README.md:374` |

第四条不是缺陷是物理限制（停止点没有否决权），本文不碰。前三条是 M1、M2、M4 的落点。

---

## 4. 映射与判定

| 原型机制 | guardrails 落点 | 代价 | 判定 |
|---|---|---|---|
| M4 策略版本 | 对 resolved config 取哈希，进 `/guardrails` 输出、进每条决策记录 | 约 20 行 | **P0，先做** |
| M2 强度 × 模式 | 全局 `mode: 'enforce' \| 'observe'`；observe 下拒绝与审批只记录不拦 | 约 60 行 | **P0** |
| M1 决策对象 | per-session 内存台账 + `/guardrails` 末尾列最近决策 | 约 120 行（含每个出口一处替换） | **P0（内存）/ P1（持久化）** |
| M3 授权重校验 | routing contract 的会话闩锁换成带依据、可重校验的记录 | 约 80 行 | **不做**，理由见下 |
| — | 每条 rail 独立配 `enforce\|observe\|off` | 12 个新键 × 校验 | **暂不做**，见 P2 |

**M3 为什么不做。** 原型需要重校验，是因为授权来自**人的一条消息**：人可以被移出名单、规则可以被禁用、接受模式可以从 `auto` 降下来，这些都发生在原消息之外。guardrails 的 routing contract 不是这样：它的两条合格证据（加载 skill、说一句 `Route: fast-path`）都落在**同一个上下文窗口**里，模型自己看得见；而这个证据唯一会失效的时刻是压缩把它挤掉，那一处已经处理了（`src/index.ts:318-325` 在 `compaction/end` 丢弃记录）。再加一层重校验，等于反复追问一个模型本来就答得上的问题。它被列为已知限制，是因为它确实有个天花板（同一会话里第二个任务不会再被问一次，`README.md:373`），但修那个天花板需要的能力是"判断两段工作在语义上是不是同一件事"，那不是门禁能推出来的。**结论：记下不做的理由，比写 80 行去假装解决它更诚实。**

---

## 5. P0 规格（约 200 行）

### 5.1 配置面：一个键

```yaml
mode: enforce   # 默认；observe 时所有 rail 只记录不拦
```

- 取值 `'enforce' | 'observe'`，非法值在加载时报错，报错文案进 README 的错误表（与现有风格一致：`mode must be "enforce" or "observe"`）。
- 缺省 `enforce`，即**不改变任何现有部署的行为**。
- observe 只降低强度，不关闭 rail：`deny` 与 `ask` 在 observe 下都变成"放行 + 记一条账"；`steer` 不在此列，理由见 5.2。

### 5.2 决策台账：一个帮助函数 + 新文件

新增 `src/decision.ts`，导出：

```ts
type Outcome = 'deny' | 'ask' | 'steer' | 'observed'
interface Decision { rail: string; outcome: Outcome; subject: string; at: number }
```

- `record(agent, decision)`：写进 `WeakMap<Agent, Decision[]>`，**每个 session 一条环形缓冲，上限约 200 条**（超过就丢最旧的，台账不是审计日志）。
- `decisions(agent)`：读回，供 `/guardrails` 用。`/guardrails` 的 handler 拿得到 `invocation.agent`（`packages/interaction/commands/src/index.ts:44-52,77`），所以这是 per-session 的，一个会话的观察记录不会污染另一个。

`src/index.ts` 里加两个出口帮助函数，覆盖四种形状里的前三种（第四种只记账，见下）：

```ts
// 八个 pre-execute rail：记账，observe 时返回 next()，否则原样返回决策
decide(agent, 'command guard', 'ask', name, { kind: 'ask', reason }, next)
// plan-mode 的 guard：记账；observe 时返回 undefined（放行），否则返回那条字符串
guarded(agent, 'plan-mode', name, reasonText)
// turn budget 的 pre-step：observe 时同样只记账，然后 next() 让这一步照开
```

第四种形状（两处 `steer`）只记账，不改变行为——`steer` 本来就是"要求"，observe 不该把它也关掉，否则观察模式会顺带削弱"送回去补证据"这类正向能力。**记账的目的是看它会拦什么，不是让它在观察期间变哑。**

### 5.3 版本号

`configVersion(resolved)`：对 resolved config 里**影响决策**的字段取稳定哈希（rail 的开关、阈值、名单、模式），不包含路径与顺序等无关项。实现上用 `node:crypto` 的 `createHash('sha256')` 截 8 位即可，不引入依赖。`/guardrails` 第一行变成：

```
Guardrails: 12 of 12 rails armed (mode: enforce, config 3f2a9c1b).
```

### 5.4 `/guardrails` 报告

在现有十二行之后追加一块：

```
decisions this session: 4 (3 would-deny, 1 would-ask)
  observed  command guard  bash  "git push --force origin main"
  observed  sensitive reads  read  ".env.local"
```

**report 只列 observe 下的记录**——enforce 下的拦截模型已经看见了，再列一遍是冗余；observe 下的放行才是这个功能存在的理由。

### 5.5 验收

- `mode: enforce` 下，README 记的那 123 个组合测试全绿，模型可见文本一个字都不变（这是回归门）。
- 每个可观察出口（八处 deny/ask、plan-mode guard、turn budget reject，共十处）新增一个 observe 测试：断言"调用放行" + "台账里有一条 `observed`" + "模型侧看不到任何拒绝文本"。
- 一个反例：两处 `steer` 在 observe 下的行为与 enforce 完全一致。
- 一个混合测试：`/guardrails` 在 observe 模式下的输出包含版本号与至少一条 observed 记录。
- 版本号的稳定性测试：同一份配置两处不同书写顺序得到同一个哈希。

### 5.6 落点清单

| 文件 | 改动 |
|---|---|
| `src/config.ts` | `mode` 键 + 校验 + `ResolvedConfig.mode` |
| `src/decision.ts` | 新增：台账、环形缓冲、`configVersion()` |
| `src/index.ts` | 两个出口帮助函数 + 10 处决策出口替换 + 2 处只记账 + `/guardrails` 报告 |
| `README.md` / `README.zh.md` | 配置表加 `mode` 行、`/guardrails` 输出更新、限制里写清 observe 的安全后果 |
| `tests/prism-guardrails.spec.ts` | 10 处可观察出口各一个 observe 用例 + 版本用例 |
| `tests/fixtures/capability.patch.yml` 等 | 新增一个 `observe.patch.yml` |

---

## 6. P1 规格：把台账写进会话日志（**先决条件已查清，结论是现在走不通**）

如果开了口子就必须先解决一个硬约束：**这条路现在走不通**。

- 会话日志里放过期记录的正规通道是 `appendPluginRecord`（`packages/core/session/src/index.ts:468-498`），它写的是带 `ignorable: true` 的 `plugin:` 记录，读路径认得、迁移按 best-effort 保留（同处 JSDoc）。
- 但 `verify-plugin-record-callers` 用 `git ls-files --cached --others --exclude-standard` 扫**全仓**源文件（`scripts/verify-plugin-record-callers.ts:250-268`），只放行 `packages/experimental/`、该函数的 owner、测试文件和 gate 自己（同文件 `:104-106`）。`plugins/prism-guardrails/src/index.ts` 是被跟踪的 `.ts` 源文件，属于这份语料。
- 结论：在 `plugins/` 里调用 `appendPluginRecord` 会让 **`pnpm run hygiene` 失败**（该 gate 在 `sharedHygieneGates()` 里，`scripts/run-gates.ts:394`，`case 'hygiene'` 经 `hygieneLeafGates()` 展开到它）。**注意不是 `doc-sync`**：`doc-sync` 走的是 `docSyncLeafGates()`（`run-gates.ts:359` 分派到 `:805` 的函数），那份清单里没有这个 gate——照着"跑一下 doc-sync"验证的人会拿到绿色然后合进 CI 红。
- 这条**没有实跑 gate 验证**：本机用 tsx 跑任何脚本时，esbuild 拉起子进程被沙箱拒绝（`spawn EPERM`，`node --import tsx/esm scripts/verify-md-links.ts` 即复现）。结论来自读 `isAdmittedCaller` 的判定加 `git ls-files` 的成员资格检查。
- 绕开它也不行：`SessionEventMap` 声明的类型必须出现在生成物 `known-event-types.ts` 里，否则读路径拒绝解释这条日志（`packages/core/session/src/known-event-types.ts:8-20`；持久化侧在 `packages/session/session-persistence/src/storage-contract.ts:75` 抛出）——那等于写出一条自己都读不回来的会话。

所以 P1 是三选一，**都不该在 P0 之前决定**：

1. 把事件正式登记进仓库（改生成目录、文档、`packages` 侧不动），代价是会动生成物和文档门禁；
2. 台账落 storage 层而不是会话日志；
3. 干脆不持久化——内存台账 + `/guardrails` 已经覆盖了"这一次会话里它在拦什么"。

**我的建议是 3。** 台账的用途是调参那几十分钟，不是事后审计；等真有人要跨会话看，再按当时的证据选 1 或 2。

---

## 7. P2：每条 rail 独立强度（暂不做）

给每条 rail 加 `enforce | observe | off` 三态，配置面从 1 个键变成 12 个键，并且和现有的"省略键即关闭"冲突（关闭会有两种写法，而现有校验体系把"键在但不可用"当成加载失败，这正是它防止拼写错误的手段）。等 P0 的 observe 被证明太粗——例如有人只想让 command guard 观察、别的照拦——再按真实需求做，那时也才知道默认值该是什么。

---

## 8. 明确不借用的部分

| 原型的部分 | 为什么不搬到 guardrails |
|---|---|
| Source（GitHub / 飞书）、`src/sources/**` | 那是"消息从哪进来"，guardrails 的输入是工具调用，没有入口概念 |
| Ticket / Decision / Mandate / panel（`src/core/**`、`src/app/**`、`src/client/**`） | 一整套工作项生命周期。搬进来 guardrails 就变成了另一个产品，而不是一个 bundle |
| Eval 超时、重试、`unavailable` 状态 | 服务于一小时的模型评估；护栏的判定是同步的 |
| `prompts/**` 与 `skills/**` | guardrails 已经自带 ponytail 的 prompt 段与命令，没有第二套提示要管 |
| `src/app/migration.ts`（46KB） | 与护栏无关 |
| `limits.ts` 的校验上下界 | guardrails 的校验已经是逐键的，照它的风格加即可 |

---

## 9. 风险与必须写进 README 的限制

- **observe 是一种关闭护栏的方式。** 一个人以为自己在受保护、其实在观察模式，比一开始就没装更危险。`/guardrails` 的第一行必须把 mode 打印出来，且 observe 要用醒目写法；`mode` 不进默认配置，只在有人显式写了才有。
- **台账是内存态。** 进程重启即消失，不能当审计证据，也不能用来回答"上周拦过什么"。
- **版本号只覆盖 rail 配置。** 它不对 profile 里其他插件的状态负责，报告里要说明这一点，否则会让人以为它能证明整个部署。
- **`plugins/` 不在仓库测试跑批里**（`README.md:370`），P0 的所有证据来自 `npm test` 与 `npm run test:e2e`，不来自 CI。
- **本机 Windows 沙箱下 vitest 起不来**（vite 的 Windows 真实路径探测要 spawn 子进程，`README.md:366`），验证要在沙箱外跑。

---

## 10. 出处

原型（GitHub，`main`）：

- [`docs/000-philosophy.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md) — 注意力原则
- [`docs/002-authorization.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md) — 准入表、强度、accept mode
- [`src/policy.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/policy.ts) — `gate()` 的 basis、`assessmentOutcome()` 的 `would_accept`、`policyVersion()`、`revalidate()`
- [`src/core/reasons.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/reasons.ts) — 理由码表

本仓库：

- `plugins/prism-guardrails/src/index.ts` — 十二个 rail 的出口与 `/guardrails`
- `plugins/prism-guardrails/src/config.ts` — 校验风格
- `plugins/prism-guardrails/README.md:159,370,373,374` — 缺口与限制的原文（159 在「Turn budget」段，其余三条在「Known Limitations」）
- `scripts/verify-plugin-record-callers.ts:104,250` — P1 的硬约束
- `packages/core/session/src/known-event-types.ts:8-20` — 读路径对未登记类型的处理
- `packages/interaction/commands/src/index.ts:44,77` — 命令 handler 拿得到 agent

---

## 11. 交付记录（P0 已落地）

本节记录 §5 实际做出来的东西，以及与原规格的差异。

**做出来的**：`mode: enforce | observe` 一个键；`src/decision.ts`（每会话内存台账，上限 200 条，加 `configVersion()` 的 8 位摘要）；`src/index.ts` 的两个出口帮助函数 `decide()`（8 处 `tools/pre-execute`）与 `note()`（plan-mode 的 guard、pre-step 的 turn budget、两处 steer）；`/guardrails` 首行加模式与版本，observe 下追加决策块，只列 `observed` 行。

**与原规格的差异（三处，都有理由）**：

1. **`steer` 不随 observe 降档。** 原规格 §5.1 写"observe 下所有 rail 只记录不拦"，但把一轮送回补证据是"要求"而非"拒绝"，观察模式把它关掉会顺带削弱正向能力。现在 `steer` 只记账、行为不变，报告里 `observed` 计数因此与 `steer` 分开。
2. **没有新增 `observe.patch.yml`。** §5.6 列了这一项，但当前没有任何消费者：单测用 `commandHarness({mode:'observe'})` 直接构造，e2e 的四个用例绑定的是既有 fixture。为一个不存在的消费者加一个 fixture 文件是"for later"代码，等真有 e2e 场景再加。
3. **版本哈希取的是原始 `Config`（补上解析后的 `mode`），不是逐字段投影的 `ResolvedConfig`。** 所有 rail 配置都影响判定，逐字段投影要多写 14 行且不改变结论；代价是 `repeatAskAfter: 0` 与省略该键哈希不同——只影响报告里的一个字符串，不影响任何判定。

**证据**：`npm test` 138 通过（原 123 + 新增 15）；`npm run build` 成功，产物外部导入仍只有 `@deepseek-ai/dsh-commands/brand`、`@deepseek-ai/dsh-llm` 与内置的 `node:crypto`；`npm run smoke` 通过。
