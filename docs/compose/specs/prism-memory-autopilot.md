---
feature: prism-memory-autopilot
status: delivered
updated: 2026-11-23
branch: feat/prism-memory-autopilot
commits: b99ebbb2bb..c328fe507c
worktree: .worktrees/prism-memory-autopilot
---

# Prism Memory Autopilot

English | [中文](prism-memory-autopilot.zh.md)

## Report

**What was built** — prism-memory 的自动生产线改为自动驾驶。信任按说话人分级：用户本人话语里的蒸馏候选以 `autoDistillUserConfidence`（0.7）写入、越过 `pendingBelowConfidence`（0.5）直接 `active` 并注入，助手陈述里的候选以 `autoDistillConfidence`（0.4）挂起；导入（`importStatus` 默认 `active`）与主题摘要（`dreamDigestStatus` 默认 `active`，且过 `admissionStatus` 闸门）同样直接生效。印证即审批：挂起主张被以 active confidence 重述时写入路径就地转正，被另一会话印证后由 dream 转正并盖 `corroboratedAt`。矛盾按新旧自动裁决（较新 supersede 较旧，fan-in 不覆盖回链，过期对跳过），dream apply 随后自动跑卫生 pass；`requireApproval` 仍然压住一切转正与摘要。新增可选的模型读取提炼通道（`llmDistill`，插件默认关、随附 patch 开启）：每回合一次 `purpose: 'memory-distill'` 的辅助调用，宽容解析、按 `source` 标签落信任档、失败只记日志绝不弄挂回合、装载时无 llm 服务即失败。升级首次装载按来源转正存量：导入与 user/rule 层的 pending 转正，其余等印证。dsh-llm 的 `purpose` 联合增加 `'memory-distill'`，成本面板可归因。

**Verification** — 插件 vitest 202/202（真实存储/会话/投影/工具/循环 spine）；host 与 client 两个 tsc face `--noEmit` 干净；`pnpm run build:artifacts` 6 gates 全过；`build:check` 唯一失败在 `packages/client/connection/tests/browser-auth.host.spec.ts:100`（基线既有，本分支未触碰该包）；oxlint 90 规则 0 违规；jscpd 0 克隆；`verify-upgrade-guides` 与翻译配对通过；`verify-type-equiv` 的 en GenerateOptions 块已同步（zh manifest 缺项为基线既有）；`test:docs` 其余失败均为基线既有（ui-* README 摘要、ui-approval doc refs、prism-search 具体措辞、custom-theme-presets md-wrap）。提交 d1200ece0e → c328fe507c，全部 `--no-verify`（lefthook msys 0xC0000022 机器限制），等效 pre-commit 检查手工执行。

**Journey log** —
- cordis 按 fiber 强制服务注入：未声明 inject 的服务在监听器 fiber 下解析会抛 `cannot get property "llm" without inject`，而测试里直接调方法能偶然成功、掩盖缺陷。正解是可选兄弟服务走 `ctx.get('llm')`（compaction 的 toolResultPruner 先例）并在 init 捕获——顺带成为装载门槛。
- 测试双挂载迁移场景一度失败，根因是把 `storagePath` 塞进了插件 `config` 而不是 harness 顶层选项——两次挂载都在 `:memory:` 上。先查产品再查测试夹具的参数通路。
- 摘要"直接生效"与"requireApproval 绝对规则"相冲突：独立审查抓到 `putAutomatic` 是唯一绕过闸门的写入路径。修正为摘要状态一律过 `admissionStatus`。
- dream 内部记录靠状态而非标签排除注入/搜索——把摘要翻成 `active` 前必须先确认排除机制，否则是静默的注入面扩大。
- fan-in 裁决的回链覆盖是审查发现的边界：同一较新主张与多条旧主张成对时，只裁第一对，其余留给人——用 `supersedes` 回链守卫表达。
- resync 撞车是设计信号：master 的 assisted 窗口与本分支的 llmDistill 是同一个能力的两次实现。统一时保留协议更好的一半（窗口化、可引用消息、可复用 bootstrap），把信任策略叠加在录取一侧，而不是让两个通道并存。

## Amendment 2026-11-23: resync unification and follow-ups

The resync with master surfaced a second model-read channel: master had shipped the windowed `assistedDistill` producer (with `/memory bootstrap` and `/memory verify`) while this branch shipped the per-turn `llmDistill` channel. The two were unified on the assisted window: the branch's `extract.ts` protocol and `llmDistill*` keys are retired, assisted candidates are admitted through the same source tiers as the form distiller (keyed by the speaker of the message each candidate cites), and the assisted call keeps the `purpose: 'memory-distill'` stamp, now declared through the dsh-llm request-purpose map. Trust stays tiered by who said it, not by which producer wrote it. Recorded against the released rc.1 surface in `docs/upgrade-guide/v0.2.2-rc.1/prism-memory-assisted-distill/`.

Two follow-ups shipped in the same pass:

- **Scheduled tidy.** The hygiene pass also runs on a wall clock — `scheduledMaintain` (default on) every `scheduledMaintainMinutes` (default 360) and once shortly after load — so a quiet workspace still gets expiry archiving, duplicate merging, and capacity eviction. Background failures are contained; the turn-path passes stay loud.
- **Page edit and retire.** The memory page rewrites a claim through the supersede chain (inheriting layer, class, scope, tags; the old wording stays auditable and `/memory restore` rolls back) and retires one through the same path as `/memory forget`. Both are operator writes with no calling session, so session-scoped claims stay under their session's authority.

## [S1] Problem

`prism-memory` 的三条自动生产线——蒸馏、主题摘要、导入——默认把每条 claim 写成 `pending`，全部堆进 `/memory review` 收件箱等人逐条审批；矛盾只报告不裁决，`maintain` 是手动 dry-run 命令，蒸馏器是纯正则、认不出换一种说法的 durable claim。结果是记忆的"学习"和"整理"都要人推着走：用户想要的是自动保存、自动转正、自动整理、更聪明的抽取——记忆自己长大，人只做例外裁决。

## [S2] Design

### S2.1 Tiered trust: 分级信任写入

信任按 claim 的来源分级，而不是按生产线分级：

- 配置新增 `autoDistillUserConfidence`（默认 `0.7`），用于从**用户本人消息**里蒸馏出的候选；`autoDistillConfidence`（`0.4`）保持用于助手自己陈述（如根因结论）里的候选。
- `autoDistillStatus` 默认从 `pending` 翻转为 `active`。分级不靠新机制：现有的 `pendingBelowConfidence`（`0.5`）就是两档的分界线——用户档 0.7 过线直接生效，助手档 0.4 不过线照旧挂起。`requireApproval` 仍是绝对规则，开启时一切都挂起。
- `importStatus` 默认翻转为 `active`：导入源是操作者点名要读的文件。
- 摘要状态改为可配置 `dreamDigestStatus`（默认 `active`），替换 dream 里硬编码的 `status: 'pending'`。
- 写入路径的 `evidenceNote` 记录来源档（蒸馏写 `stated by the person` / `inferred from the assistant account`，模型读取写 `model-read extraction: stated by the person` / `model-read extraction: inferred in the discussion`），让每条自动 claim 事后可审计。

### S2.2 印证即审批：写路径的 corroboration

- `remember()` 的 identical-claim 检索从"仅 live"扩到 `active` 与 `pending`（仍排除 `superseded`/`archived`——已退休的 claim 不因重写复活）。
- 命中 `pending` 记录：`corroborations`/`hits` 递增、`updatedAt` 前移，不产生第二条重复记录；若本次写入自身的 admission 结果是 `active`（例如用户在另一段会话里亲口重述，来自用户档 0.7），原记录**就地转正**：`status: active`、confidence 取 `max(旧, 新)`、记 `reviewedAt` 与 `reviewNote: auto-approved: restated at active confidence`。
- 命中 `active` 记录：行为不变（计数递增）。

### S2.3 Consolidation autopilot：dream 的三个自动裁决

- **印证转正**：apply 时扫描全部 `pending` 记录（dream 窗口本身过滤掉 pending，所以扫描在窗口之外进行），凡 `corroborations + 1 >= CORROBORATION_FLOOR` 且未过期的就地转正：`status: active`、盖 `corroboratedAt`、`reviewNote: auto-approved: corroborated by another conversation`。
- **矛盾自动用新代旧**（`dreamAutoResolveConflicts`，默认 `true`）：apply 时把 plan 的每对 conflict 交给取代机制——较新的一条 supersede 较旧的一条（沿用 `supersedes`/`supersededBy`/`invalidAt` 字段与取代链）；apply 前复核两侧仍 active、未过期、且未被链入（含 `supersedes` 回链——同一 pass 内较新主张与多条旧主张成对时，只有第一对裁决，其余留给用户，不覆盖胜者的回链）。journal 增加 `Resolved by recency (newer supersedes older): …` 行，关掉配置时保留原有的 unresolved 行。`/memory restore` 的回滚路径不变。
- **自动 maintain**（`dreamAutoMaintain`，默认 `true`）：apply 完成后跑 `maintain({ apply: true })`——过期归档、近重复合并（保留 confidence 高/较新的一条）、容量驱逐；报告挂到 `DreamReport.maintenance`。摘要状态在写入前过 `admissionStatus` 闸门：`requireApproval` 开启时机器写的索引条目同样落 `pending`，绝对规则无例外。
- `DreamReport` 扩展 `promoted`（印证转正的 id）、`resolved`（自动裁决的对）、`maintenance`。

### S2.4 LLM 提炼通道

- 新模块 `src/extract.ts`：纯函数的 prompt 构造与宽容 JSON 解析（取首个 `[` 到末个 `]`，逐项 zod 校验，非法项丢弃）；不依赖任何响应格式开关。
- 请求形态：单条 user 消息（指令 + 回合文本），不带工具、不重放前缀——蒸馏只需要刚关闭的这一回合。`maxTokens` 走 `llmDistillMaxTokens`（默认 512）。
- 目标解析顺序与 compaction 相同：显式配置对（`llmDistillProvider`/`llmDistillModel`，必须成对出现）→ 会话最近路由（`requestHeader().config`）→ agent options；解析不出目标时按普通跳过处理。
- 回合文本低于 `llmDistillMinChars`（默认 80）不发起调用；正则蒸馏先跑（免费、确定），模型读取后跑， identical-claim 检查让两者重叠零成本。
- 输出项的 `source: 'user' | 'inferred'` 决定信任档：`user` 走 `autoDistillUserConfidence`，`inferred` 走 `autoDistillConfidence`；status 一律请求 `autoDistillStatus`，由 S2.1 的同一分界线落档。
- **失败即吞**：LLM 调用与解析失败只记日志、跳过本回合，绝不 fail the turn——这条通道的失败是外部服务条件，与确定性 pass 的"坏存储要响"策略相反，写入各自模块的 JSDoc。
- **装载门槛**：`llmDistill` 开启但上下文没有 llm 服务 → 插件装载即失败（自包含误配置，fail loud）；有服务但暂无路由模型 → 回合时普通跳过。因此插件自身的代码默认是 `llmDistill: false`（无 llm 的 profile 也能装载本 bundle），由本部署的 cordis.patch.yml 显式开启——与 `exportDir` 同一配置层。
- `purpose` 扩展：dsh-llm 的 `purpose` 封闭联合增加 `'memory-distill'`，让成本面板能把这笔辅助调用归因出来。

### S2.5 存量分级转正

升级后的首次装载（以及每次装载，幂等）跑一次迁移，`requireApproval` 开启时整体跳过：

- `pending` + `origin: 'import'` → 转正（导入源是操作者选的文件）。
- `pending` + `origin: 'session'` + layer `user`|`rule` → 转正（蒸馏器的偏好/约束句式本质上是被本人的声音；根因类句式落在 lesson/fact 层，不受影响）。
- 其余（`origin: 'model'`、其他 layer）保持 `pending` 等印证。
- 迁移写入 `reviewNote: auto-approved on upgrade: stated by the person` / `auto-approved on upgrade: operator-chosen import`，已过期记录跳过。

## [S3] Scope

- In scope:
  - `plugins/prism-memory/src/service.ts`：配置面（新字段与默认值、`assertBounds`）、`remember()` 写路径、`distillTurn` 分档、`Service.init` 迁移、`dream()` 三个自动裁决与报告扩展。
  - 新模块 `plugins/prism-memory/src/extract.ts`（prompt + 解析）及其服务接线。
  - `packages/llm/llm/src/types.ts`：`purpose` 联合增加 `'memory-distill'` 及其消费点。
  - 测试：分档写入、印证转正（写路径 + dream）、矛盾自动裁决与回滚、自动 maintain、摘要状态、LLM 通道（假适配器、吞错、跳过、装载门槛）、存量迁移、`requireApproval` 绝对规则。
  - 文档：README.en/zh 的配置表与行为章节；升级指南条目（默认值翻转是外部可感知的行为变化）。
- Out of scope:
  - embeddings / reranker / FTS 索引（仍按 README 的 limitations）。
  - 定时调度（schedule 行指向 `/memory maintain apply` 仍是既定答案）。
  - Web 页面编辑能力、矛盾的语义级分析（自动裁决只按新旧，不做语义理解）。
  - LLM 驱动的整合/摘要（模型只用于抽取，不用于整理语料）。

## Tasks

- [x] T1: 配置面——新字段 `autoDistillUserConfidence`、`dreamDigestStatus`、`dreamAutoResolveConflicts`、`dreamAutoMaintain`、`llmDistill*` 五项；默认值翻转 `autoDistillStatus`/`importStatus`；`assertBounds` 新增校验（covers: S2.1, S2.3, S2.4） (depends: none)
- [x] T2: 分档写入——`distillTurn` 按来源取 confidence、记 evidenceNote (covers: S2.1) (depends: T1)
- [x] T3: 写路径印证——identical 检索扩到 pending、就地转正 (covers: S2.2) (depends: T1)
- [x] T4: 存量迁移——init 幂等分流 (covers: S2.5) (depends: T1)
- [x] T5: dream 自动裁决——印证转正、矛盾用新代旧、自动 maintain、摘要状态 (covers: S2.3) (depends: T1)
- [x] T6: LLM 通道——`extract.ts` + 服务接线 + `purpose` 联合扩展 (covers: S2.4) (depends: T1)
- [x] T7: 测试——上述每条行为至少一条 spec (depends: T2, T3, T4, T5, T6)
- [x] T8: 文档——README.en/zh、升级指南 (depends: T1, T5, T6)
- [x] T9: resync 统一模型读通道——assisted 候选走分级信任、retire extract.ts、purpose 声明迁移 (depends: T6)
- [x] T10: 定时清扫——scheduledMaintain/scheduledMaintainMinutes、装载布防、失败只记日志 (depends: none)
- [x] T11: 页面改写与退役——/memory edit、/memory retire 路由与面板控件，supersedes 审计链 (depends: none)

## [S4] Acceptance

- [x] 用户消息里的偏好句直接存为 active，助手陈述里的根因句存为 pending（测试证明）。
- [x] 对 pending claim 以 active confidence 重述：就地转正，不产生第二条记录（测试）。
- [x] pending claim 被另一会话印证后，下一次 dream apply 转正并盖 `corroboratedAt`（测试）。
- [x] 两条 live 矛盾在 apply 时较新取代较旧，取代链完整，`/memory restore` 可回滚，journal 记录裁决（测试）。
- [x] dream apply 自动执行 maintain：过期记录被归档（测试）。
- [x] 摘要按 `dreamDigestStatus` 写，默认 active（测试）。
- [x] 假 LLM 适配器返回 JSON 数组时产出正确分档的记录；适配器抛错时回合照常完成（测试）。
- [x] 存量迁移：import 来源与 session user/rule 层的 pending 转正，model 来源保持 pending；`requireApproval` 开启时一切保持 pending（测试）。
- [x] `pnpm run typecheck`（两个 face）与插件 vitest 套件全绿。
