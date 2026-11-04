---
feature: compose-next-mode
status: designed
updated: 2026-11-04
branch: feat/prism-team
commits: 50ff54bd96..50ff54bd96
---

# Compose Next As A Mode

## Report

## [S1] Problem

`compose-next` 是一份 skill：九阶段（Orient → Grill → Spec → Workspace → Implement → Verify → Review → Finalize → Finish），而且它自己第一句就规定「只在用户明确要求时进入，不要因为任务大就推断」。

结果是两个具体毛病：

- 一个跑了 30 步的长任务没有任何工作流约束，也没有任何东西会把它拉回来；`ponytail` 已经按会话自动切换等级，`compose-next` 没有对应物。
- 模式能力的两个家不一致：ponytail 是插件（`prism-guardrails/src/ponytail.ts`，bundle 挂进每个 profile），compose-next 只有 skill。同一个用户要用两次不同的机制。

要的是把 compose-next 变成和 ponytail 一样的插件能力：一个 system-prompt 段落 + 一条斜杠命令 + 一条自动规则，长任务自动进入。

## [S2] Design

### S2.1 落点：`prism-guardrails/src/compose.ts`

与 `ponytail.ts` 同构：`level`（`off | lite | full`）、`autoLongTaskSteps`、一段按会话解析的 section、一条 `/compose-next` 命令。bundle patch 里再加一行 `prism-guardrails-compose`。

不新建第二个模式插件：`ponytail` 已经证明 skill→插件的家在 `prism-guardrails`，同一件事不该有两个家。

### S2.2 等级与段落

`off` 不输出段落。`lite` 是五阶段（Orient → Spec → Implement → Verify → Review），`full` 是九阶段（多了 Grill、Workspace、Finalize、Finish，以及每一步的门）。段落正文是阶段的**契约**，不是 skill 的全文：措辞保持 `prism-guardrails` 的风格，用祈使句写清每一步要做什么、哪一步不许跳。

段落共用 `ponytail` 的收尾约束：只在「真正开放的产品决定、无法绕开的阻塞、需要同意的破坏性操作」三种情况停下来，其余不停；两遍失败就换策略；不许把跳过的阶段说成「已经做完了」。

### S2.3 自动规则与它要付的代价

`autoLongTaskSteps` 默认 `20`（与 ponytail 的一致），`0` 关闭。会话累计步数达到阈值即在 section 里切到 `lite`。

**这条规则与 skill 自身的进入规则冲突**：skill 说不要按任务大小推断，而自动规则正是按任务大小推断。用户显式要求长任务自动进入，所以默认开启，但代价必须在 README 里写清楚：打开后，一个长任务会自己开始产出规格文档，即使没人要求。要退回 skill 的规则就把 `autoLongTaskSteps` 设为 `0`。

`/compose-next off|auto|lite|full` 覆盖自动规则；`auto` 放弃显式选择，回到自动规则。

### S2.4 状态

按会话存 `WeakMap<Agent, ComposeLevel>`（显式选择）与 `WeakMap<Agent, number>`（步数）。一个跑长任务的会话不影响旁边的会话，与 ponytail 的状态模型一致。

### S2.5 配置

```yaml
- id: prism-guardrails-compose
  name: 'prism-guardrails/compose'
  config:
    level: off            # 默认不进入；长任务靠自动规则
    autoLongTaskSteps: 20 # 0 = 关闭自动规则
```

两个键在装载时校验，非法值立刻抛错并指向键名。

## [S3] Scope

- In scope：`src/compose.ts`、`cordis.patch.yml` 一行、`package.json` 的 `./compose` 导出、`tsdown.config.ts` 的入口、`tests/compose.spec.ts`、`prism-guardrails` README 的 compose 段。
- Out of scope：改动 `prism-guardrails` 的十二条 rail；把 compose 状态写进会话日志；Web UI；替团队插件做模式路由（那是 `prism-team` 之外的另一件事）。

## Tasks

- [ ] T1: `src/compose.ts`（等级、自动规则、段落、命令）(depends: none)
- [ ] T2: 装载（`cordis.patch.yml` 行、`package.json` 导出、`tsdown` 入口）(depends: T1)
- [ ] T3: `tests/compose.spec.ts` (depends: T1)
- [ ] T4: README 的 compose 段与冲突说明 (depends: T2)

## [S4] Acceptance

- [ ] A1 默认配置下（`level: off` 且未到阈值）段落为空。
- [ ] A2 `level: lite` 的段落含五个阶段且不含 Grill；`level: full` 含九个阶段与 Finish。
- [ ] A3 `autoLongTaskSteps: 3` 时第 2 步不切、第 3 步切到 `lite`；设为 `0` 时永不切换。
- [ ] A4 `/compose-next full` 立刻改写段落，`off` 清空，`auto` 回到自动规则。
- [ ] A5 非法 `level` 与非法步数在装载时抛错，错误文本指向键名。
- [ ] A6 `prism-guardrails` 既有的 ponytail 与 rail 用例全绿（回归门）。
