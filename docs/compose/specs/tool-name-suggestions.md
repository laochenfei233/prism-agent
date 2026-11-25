---
feature: tool-name-suggestions
status: implemented
updated: 2026-11-25
branch: feat/tool-name-suggestions
commits: e161bdab89 (feat/tool-name-suggestions), e7c738b135 (master)
---

# 未知工具名的相近名称建议

English | [中文](tool-name-suggestions.zh.md)

## Report

已实现于分支 `feat/tool-name-suggestions`（worktree `.worktrees/tool-name-suggestions`）。guardrails 新增 `tools/execute` 包装（结果路径 + 兜底 catch）、`src/tool-hints.ts`（大小写折叠 Levenshtein + 子串优惠，预算 `max(2, ⌊len/3⌋)`，至多 3 个）、`toolNameSuggestions` 配置（默认 `true`，进 `KNOWN_KEYS`）。新增 10 个用例（6 个经真实 agent loop + 工具管线的行为用例、4 个纯函数用例）全部通过。顺带修复 spec 的失效导入（`defineContentToolFixture` 实际来自 `@deepseek-ai/dsh-tool-testkit`），使整个套件恢复可运行：失败数从 85 降到 55，剩余 55 个失败是 HEAD 上既有的 `ctx.tools.execute` 逐调用签名与现批量 API 的漂移，与本特性无关。README 双语与 i18n 配对已同步。

## [S1] Problem

模型写错工具名时，prism 的报错只有 `unknown tool "X"`（`packages/core/tools/src/contracts.ts:291-307`，抛出点 `pipeline.ts:273/513/582`），模型可能盲目重试。ZCode v3.19.1 为这种报错补充"相近名称建议"。落点选在 `plugins/prism-guardrails`：它已订阅工具缝、已有配置/测试/台账基建；不新建插件包（省掉新包门禁全套），也不动基库报错路径。曾考虑独立小插件，因新包门禁成本与功能体量不匹配而放弃。

## [S2] Design

### S2.1 挂点：`tools/execute` 瀑布包装

- 在 guardrails 新增 `tools/execute` 监听（注册形状同 `packages/guard/timeout-policy/src/index.ts:52-76`；guardrails 现有监听先例 `src/index.ts:272-284`）。工具解析发生在瀑布 `next()` 内部（`pipeline.ts:299-302` → `dispatchToolBody` `pipeline.ts:272-273`），因此未知工具调用也会经过本监听。
- `try { return await next() } catch (error) { … }`：仅当错误是未知工具（`error.name === 'ToolNotFoundError'` 或 `error.info?.code === 'UNKNOWN_TOOL'`）时增强，其余原样 rethrow。

### S2.2 建议算法（新 `src/tool-hints.ts`）

- 候选集：`ctx.tools.schemas(exec.agent ?? undefined).map(t => t.name)`（枚举先例 `packages/experimental/browser-use-runtime/src/mcp.ts:118`）。
- 评分：内联 Levenshtein（约 15 行，无新依赖）+ 大小写不敏感前缀/子串加分；阈值 `max(2, ⌊名称长度/3⌋)`，取最近的至多 3 个。
- 增强消息：`unknown tool "X" — did you mean "y"?`；多个候选时 `similar tools: "a", "b", "c"`；无候选时保持原消息。

### S2.3 返回形态：不 rethrow，返回增强后的错误结果

```ts
declare const enhanced: string
declare const originalInfo: Record<string, unknown>
const enhancedResult = {
  content: [{ type: 'text', text: `Error: ${enhanced}` }],
  isError: true,
  error: { message: enhanced, ...originalInfo }, // keep reachableFrom and the rest
}
```

该结果经 `normalizeDispatchResult`（`pipeline.ts:570-588`）与 post-execute 正常流转，最终写入 `tool/result` 事件到达模型（`batch.ts:258`）。判定逻辑（哪些调用被拒/放行）完全不变——本特性只改错误文本。

### S2.4 配置

- 新增布尔键 `toolNameSuggestions`，**默认 `true`**（ZCode 该行为常开；guardrails 的 stuck-nudge 亦有出厂开启先例）。加入 `KNOWN_KEYS`（`config.ts:206-226`）；`configVersion` 哈希整个 config，自动覆盖。
- 不涉及台账/审批（非 rail，无 ask/deny 动作）。

## [S3] Scope

- In scope: guardrails 内 `tools/execute` 包装、`src/tool-hints.ts` 算法、错误结果增强、`toolNameSuggestions` 配置、单测与行为测试、README。
- Out of scope: 基库 `ToolNotFoundError` 消息与抛出点改动；MCP 工具目录侧建议；模糊搜索第三方依赖；对未知工具的自动重试/纠正执行。

## Tasks

- [ ] T1: config 新增 `toolNameSuggestions` + 校验 + KNOWN_KEYS（depends: none）
- [ ] T2: `src/tool-hints.ts`（Levenshtein + 候选评分 + 消息拼装）+ 单测（depends: none）
- [ ] T3: `tools/execute` 监听接入 `apply()`（depends: T1, T2）
- [ ] T4: 行为测试（写错工具名得到建议；正确工具名不受影响；开关关闭回到原消息；多候选排序；info 保留）（depends: T3）
- [ ] T5: README 补充说明（depends: T3）

## [S4] Acceptance

- [ ] 调用不存在的 `bashh` → 模型收到含 `did you mean "bash"` 的错误文本，`isError` 语义与现状一致
- [ ] 名称正确、参数错误的调用不受任何影响（消息与现状逐字一致）
- [ ] 多个相近工具按距离排序，至多 3 个；无相近候选时保持原消息
- [ ] 原 `error.info`（如 `reachableFrom`、`code: 'UNKNOWN_TOOL'`）保留
- [ ] `toolNameSuggestions: false` 时错误文本与现状完全一致
- [ ] guardrails 既有测试全绿；新增用例覆盖上述路径
