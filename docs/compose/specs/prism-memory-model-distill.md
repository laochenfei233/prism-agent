---
feature: prism-memory-model-distill
status: delivered
updated: 2026-11-13
branch: feat/prism-memory-model-distill
commits: 3013583bd5..bb13e6e65b
---

# Prism-memory 模型辅助蒸馏 + 历史会话 bootstrap

## Report

**What was built** — `@prism/prism-memory` 的第四个写入方与一条冷启动路径。`assistedDistill`（默认关）开启后，turn-stopping 路径维护一个滚动轮次缓冲，每满 `assistedDistillEveryTurns` 个轮次把对话交给部署自己的模型（`ctx.llm.stream` 一次性调用，路由 `assistedDistillProvider`/`Model` 覆盖或沿用调用轮次的路由），读回 JSON 候选并以 `pending`、project/global 作用域写入；模型命名的消息以 `textHash` 指纹被引用，`/memory verify` 可重读。`/memory bootstrap [apply] [limit]` 用同一协议对本工作目录的既往会话逐个沉淀（调用会话除外，exact-cwd 权限），`bootstrap-log` 自记记录保证同一会话不二次处理，空跑零调用零写入，缺 sessionQuery/llm/路由/cwd 时 loud 失败。模型调用失败、不可解析输出、无路由都只留日志跳过，存储写入失败照旧传播。

**Verification** — host/client 双面 `tsc --noEmit` PASS（exit 0）；`vitest` 210/210 PASS（198 存量 + 12 新增，`tests/assisted.spec.ts` 覆盖：默认静默、每窗口一次调用、跨窗口去重、软失败、引用 intact、无 sourceMessage 不引用、缺 reader/cwd loud、dry-run 零调用、apply 幂等、limit 截断、journal 可读、重复计 skipped）；oxlint staged PASS；`git diff --cached --check` PASS；翻译配对 en/zh 一致。独立 review 报告的 3 个 CRITICAL（journal 不可读、空输出静默、sourceTurn 协议漂移）与可行动 MINOR 全部修复或落档，修复后重跑通过。

## [S1] Problem

`@prism/prism-memory` 的自动蒸馏是正则句式表，只认句式不认语义：一条换个说法的持久性 claim（约束、偏好、根因、约定）会被漏掉（README 已知短板第 3 条）。参考对象是微软 TokenEconomizer 的"项目规矩学习"：定期让模型回顾近期会话，提炼正则抓不到的事实。

同时，新装的 prism-memory 冷启动零记忆：既往持久化会话里的教训、偏好、约定不会被提炼，只有安装之后的新 turn 才有产出。参考对象是 TokenEconomizer 的 history_import。

## [S2] Design

### S2.1 模型辅助蒸馏（第四个 producer）

一个可选的、默认关闭的模型调用 producer，与现有三个 producer（模型工具写入、turn 文本正则蒸馏、外部导入）并列。

- **开关与触发。** `assistedDistill`（默认 `false`）总开关。`agent/turn-stopping` 监听器里维护 turn 计数，每满 `assistedDistillEveryTurns`（默认 `40`，正整数，否则插件加载失败）个 turn 触发一次。窗口是私有计数器，蒸馏是尽力而为的补充路径，重启清零可接受（与 dream 的"语料为界"窗口不同：dream 的产出是确定性的，这里每次都花模型调用）。
- **输入。** 内存滚动缓冲：最近 `assistedDistillBufferTurns`（默认 `12`）个 turn 的 user 消息与 assistant 最终文本。缓冲与 turn 关闭时现有蒸馏读的是同一份文本，不加额外读路径。`shortcut: 重启丢缓冲，窗口重计，代价是装后前几十个 turn 无辅助蒸馏；若需跨重启连续性再改为从持久日志回放`。
- **模型调用。** 照 `compaction-basic` 的 `summarizeWithLlm` 先例（`packages/compaction/compaction-basic/src/summarizer.ts:119`）：`ctx.llm` 服务 + `BlockAssembler` 收集 text-delta。target 解析链：`assistedDistillProvider`/`assistedDistillModel` 配置（都设才生效）→ 当前 agent 的路由 → 都没有则跳过本次并留一条日志（外部依赖不可用不是存储损坏，不炸 turn）。
- **llm 服务的绑定。** 与 `sessionQuery` 同款可选 fiber 注入（`ctx.inject(['llm'], ...)`，出现即绑定、消失即清理）。llm 未挂载时 producer 静默不可用，其余路径不受影响。
- **提示词与输出协议。** system 消息带指令（只收约束、偏好、根因、约定、流程五类持久性陈述），单条 user 消息带编号对话文本（与 compaction 先例同形的一次性调用）。要求输出 JSON 数组，上限 `assistedDistillLimit`（默认 `3`）条，每条给 `text`、`kind`（fact/decision/pitfall/preference/procedure 之一）、可选 `layer`、可选 `sourceMessage`（依据的第几条消息，1 起）。解析失败或输出为空 → 0 产出 + 日志，不重试（避免循环花费）。
- **写入。** 走现有 `remember` 写入路径，因此获得现有去重（近似重复报告、identical 跳过）与容量治理。产出固定：`status: 'pending'`（显式，与 confidence 无关，人审治理不变——模型不能提升自己的 claim）、`origin: 'session'`、`evidenceNote: 'assisted'`（写进 `evidence.note`，与 importer 用同一字段标注来源）、confidence `assistedDistillConfidence`（默认 `0.5`）。
- **引用。** 模型给出有效 `sourceMessage` 时，evidence 引该条消息（`messageId`/`textHash`，与现有蒸馏同款指纹；user 或 assistant 皆可，以模型命名的为准）；给不出或越界则无 evidence——nothing is invented。
- **失败分层。** 模型调用失败、解析失败、无可用 target：日志 + 跳过，不传播（外部依赖失败不应炸 turn）。存储写入失败：照现有 turn-end pass 传播（broken store should be loud）。
- **注入面不变。** pending 不注入、不进 live 计数，只进 review inbox 与 `memory_search`。cache-safety 声明不受影响：本 producer 不新增任何模型可见文本。

### S2.2 历史会话 bootstrap（`/memory bootstrap`）

操作员命令，显式触发——模型调用花钱，永不自动跑。

- **形态。** `/memory bootstrap` 为 dry-run：列出将读的会话（id、消息数、是否已被 bootstrap 过）与将用的 provider/model，不调用模型、不写入。`/memory bootstrap apply [limit]` 执行。
- **依赖。** `sessionQuery` 引擎与 `llm` 服务都必须可用；任一缺失，命令报错并说明缺什么（操作员显式调用点是"earliest resolvable point"，fail loud）。
- **会话选取。** 与 session 工具同款权限：目标会话的 `cwd` 与调用会话完全相等；按最近优先；上限 `min(limit, bootstrapMaxSessions)`（默认 `10`）。已被 bootstrap 过的会话跳过。
- **逐会话蒸馏。** 每个会话一次模型调用：该会话的 user/assistant 模型可见文本（截断到每会话字符上限），同一 S2.1 提示词协议，产出上限 `bootstrapClaimsPerSession`（默认 `3`）条。
- **写入。** `scope: 'project'`（scopeKey = cwd）、`status: 'pending'`、`origin: 'session'`、`reviewNote: 'bootstrap'`；evidence 引该会话内被依据的消息（同 S2.1 引用规则）。文本重复走写路径 dedupe，dry-run 之后的结算汇报 stored / skipped / failed 计数。
- **幂等。** 每次成功 apply 把处理过的会话 id 写进一条自记记录（tag `bootstrap-log`，与 dream-journal 同款：不入注入、不入搜索，可在 `/memory journal` 读到）。同一会话不二次蒸馏；plan 只列将处理的会话，已处理的以 `processedCount` 聚合计数在结算里汇报。
- **同步结算。** apply 是长任务（最多 10 次模型调用），命令同步等待并在结算时汇报。`shortcut: 同步等待，默认上限 10 会话把最坏情况留在分钟级；若真实使用超过此界再改后台 job`。

### S2.3 配置字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `assistedDistill` | `false` | 模型辅助蒸馏总开关 |
| `assistedDistillEveryTurns` | `40` | 触发窗口（turn 数）；非正整数加载失败 |
| `assistedDistillBufferTurns` | `12` | 滚动缓冲保留的 turn 数 |
| `assistedDistillLimit` | `3` | 单次触发产出上限 |
| `assistedDistillConfidence` | `0.5` | 产出的 confidence |
| `assistedDistillProvider` | 空 | 覆盖 provider；须与 model 同时设置 |
| `assistedDistillModel` | 空 | 覆盖 model；须与 provider 同时设置 |
| `bootstrapMaxSessions` | `10` | apply 单次读的会话上限 |
| `bootstrapClaimsPerSession` | `3` | 每会话产出上限 |
| `bootstrapMaxChars` | `24000` | 每会话送入模型的文本截断 |
| `assistedDistillMaxTokens` | `1024` | 一次辅助模型调用的 token 上限 |

仅 `assistedDistillProvider`/`assistedDistillModel` 单侧设置、`assistedDistillEveryTurns` 非正整数、`bootstrapMaxSessions` 非正整数：插件加载失败。

### S2.4 治理与不变量

- 产出永远是 pending，提升只经 `/memory approve`——模型不能提升自己的 claim，人审治理不变。
- 不新增任何模型可见文本、工具 schema、注入段；cache-safety 套件全绿是硬门槛。
- store 域版本不动；全部新字段是配置，不是 record schema 变更（`reviewNote` 已存在，复用）。

## [S3] Scope

- In scope:
  - S2.1 辅助蒸馏 producer（配置、fiber 绑定、缓冲、窗口、调用、解析、写入、失败分层）
  - S2.2 `/memory bootstrap` 命令（dry-run/apply、会话选取、幂等日志、结算汇报）
  - S2.3 配置字段与加载校验
  - 测试（fake llm 服务注入）+ README 三语 + changelog 条目
- Out of scope:
  - guardrails 卡住提醒（独立 feature，独立分支）
  - 嵌入向量/语义检索
  - corroboration 自动激活、证伪自动丢弃（与既定人审治理冲突）
  - 辅助蒸馏接入 dream 窗口
  - bootstrap 后台 job 化

## Tasks

- [ ] T1: 配置字段、校验与加载失败路径（depends: none）
- [ ] T2: llm 可选注入 fiber、滚动缓冲、窗口触发、模型调用、JSON 解析、pending 写入与 evidence（depends: T1）
- [ ] T3: `/memory bootstrap` 命令与 bootstrap-log 幂等记录（depends: T2）
- [ ] T4: 测试：fake llm 下窗口恰一次调用、失败静默、pending 产出、sourceTurn 引用、bootstrap 限界/幂等/缺依赖 loud（depends: T2, T3）
- [ ] T5: README/README.zh/README.i18n + changelog 条目（depends: T2, T3）

## [S4] Acceptance

- [ ] `assistedDistill: false`（默认）时行为与现状逐字节一致：不发任何模型调用、不加注入、不加 schema
- [ ] 开启后窗口到达时恰好一次模型调用，产出写 `pending`、进 review inbox、不自动注入
- [ ] 模型调用失败或输出不可解析时 turn 正常关闭，日志留痕，下个窗口照常
- [ ] 有效 `sourceTurn` 产出携带 `evidence.textHash`，`/memory verify` 能读它；无 `sourceTurn` 产出无 evidence
- [ ] `/memory bootstrap` 在缺 sessionQuery 或缺 llm 时 loud 报错；dry-run 零调用零写入
- [ ] apply 后同一会话在 dry-run 中列为已处理且 apply 跳过；重复 claim 走 skipped
- [ ] 全部新配置字段的非法值在插件加载时失败
- [ ] 现有 198 specs 全绿 + 新增 specs 覆盖上述路径；双面 typecheck 通过

## Journey log

- **`sourceTurn` → `sourceMessage`。** 实现时发现 turn 粒度太粗：蒸馏与 bootstrap 共用一个协议，而 bootstrap 的输入是消息流不是 turn。统一为消息编号，evidence 引模型命名的消息（无论 user 或 assistant）——比原设计引用面更精确。Review 确认行为等价，amendment 落档。
- **`reviewNote` → `evidenceNote`。** 计划里把来源标记写进 `reviewNote`，但该字段语义是"人审留下的注"，由 `/memory approve`/`reject` 写；机器来源标记的既有先例是 importer 的 `evidenceNote`（进 `evidence.note`）。随先例。
- **testkit 已挂真 `LlmRuntime`。** 计划用继承 `LlmRuntime` 的 stub 服务，实际 `mountAgentLoopTestDependencies` 已注册 `llm` 服务，二次注册冲突。改为在真实例上替换 `stream` 并以 WeakMap 持脚本状态——绑定关系与生产一致（同一个 `ctx.llm`）。
- **Review 修复三件**：`journal()` 原来不认 `bootstrap-log`（README 承诺了 `/memory journal` 可读）；辅助窗口空输出原来静默返回（缺"0 产出 + 日志"）；`BootstrapSessionPlan.processed` 是永假的死字段（删，聚合语义由 `processedCount` 承担）。
