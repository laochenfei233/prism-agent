---
feature: tool-name-suggestions
status: implemented
updated: 2026-11-25
branch: feat/tool-name-suggestions
commits: e161bdab89 (feat/tool-name-suggestions), e7c738b135 (master)
---

# Similar-name suggestions for unknown tool names

English | [中文](tool-name-suggestions.zh.md)

## Report

Implemented on `feat/tool-name-suggestions` (worktree `.worktrees/tool-name-suggestions`). guardrails gains a `tools/execute` wrapper (result path + fallback catch), `src/tool-hints.ts` (case-folded Levenshtein with a substring bonus, budget `max(2, ⌊len/3⌋)`, at most 3), and the `toolNameSuggestions` config (default `true`, in `KNOWN_KEYS`). 10 new cases (6 behavior cases through the real agent loop + tool pipeline, 4 pure-function cases) all pass. The spec's broken import was fixed in passing (`defineContentToolFixture` actually comes from `@deepseek-ai/dsh-tool-testkit`), making the whole suite runnable again: failures dropped from 85 to 55, and the remaining 55 are the pre-existing drift at HEAD between the old per-call `ctx.tools.execute` signature and the current batch API — unrelated to this feature. The README bilingual pair and i18n record were updated together.

## [S1] Problem

When the model misspells a tool name, prism's error is only `unknown tool "X"` (`packages/core/tools/src/contracts.ts:291-307`, thrown at `pipeline.ts:273/513/582`), and the model may retry blindly. ZCode v3.19.1 augments this error with similar-name suggestions. The home is `plugins/prism-guardrails`: it already subscribes to the tool seams and has the config/test/ledger infrastructure; no new plugin package is created (saving the whole new-package gate), and the base error path is untouched. A standalone small plugin was considered and dropped — the new-package gate cost did not match the feature's size.

## [S2] Design

### S2.1 Hook: the `tools/execute` waterfall wrapper

- guardrails adds a `tools/execute` listener (registration shape as in `packages/guard/timeout-policy/src/index.ts:52-76`; an existing in-repo listener precedent is `src/index.ts:272-284`). Tool resolution happens inside the waterfall's `next()` (`pipeline.ts:299-302` → `dispatchToolBody` `pipeline.ts:272-273`), so unknown-tool calls pass through this listener too.
- `try { return await next() } catch (error) { … }`: enhance only when the error is an unknown tool (`error.name === 'ToolNotFoundError'` or `error.info?.code === 'UNKNOWN_TOOL'`); rethrow everything else unchanged.

### S2.2 The suggestion algorithm (new `src/tool-hints.ts`)

- Candidates: `ctx.tools.schemas(exec.agent ?? undefined).map(t => t.name)` (enumeration precedent `packages/experimental/browser-use-runtime/src/mcp.ts:118`).
- Scoring: an inline Levenshtein (~15 lines, no new dependency) plus a case-insensitive prefix/substring bonus; threshold `max(2, ⌊name length/3⌋)`, keeping the closest 3 at most.
- Enhanced message: `unknown tool "X" — did you mean "y"?`; with several candidates `similar tools: "a", "b", "c"`; with none, the original message stands.

### S2.3 Return shape: no rethrow — return the enhanced error result

```ts
{ content: [{ type: 'text', text: `Error: ${enhanced}` }], isError: true,
  error: { message: enhanced, ...originalInfo } }   // preserves reachableFrom etc.
```

That result flows through `normalizeDispatchResult` (`pipeline.ts:570-588`) and post-execute normally, finally landing in the `tool/result` event the model sees (`batch.ts:258`). The decision logic (which calls are refused or allowed) is untouched — this feature only changes the error text.

### S2.4 Configuration

- A new boolean key `toolNameSuggestions`, **default `true`** (ZCode keeps this behavior always on; guardrails' stuck nudge is also a shipped-on precedent). It joins `KNOWN_KEYS` (`config.ts:206-226`); `configVersion` hashes the whole config, so it is covered automatically.
- No ledger/approval involvement (not a rail; no ask/deny action).

## [S3] Scope

- In scope: the `tools/execute` wrapper in guardrails, the `src/tool-hints.ts` algorithm, the error-result enhancement, the `toolNameSuggestions` config, unit and behavior tests, and the README.
- Out of scope: changes to the base `ToolNotFoundError` message or throw sites; MCP tool-catalog-side suggestions; a fuzzy-search dependency; automatic retry/corrected execution of the unknown tool.

## Tasks

- [ ] T1: config gains `toolNameSuggestions` + validation + KNOWN_KEYS (depends: none)
- [ ] T2: `src/tool-hints.ts` (Levenshtein + candidate scoring + message assembly) + unit tests (depends: none)
- [ ] T3: wire the `tools/execute` listener into `apply()` (depends: T1, T2)
- [ ] T4: behavior tests (a misspelled name gets suggestions; a correct name is unaffected; the switch off restores the original message; multi-candidate ordering; info preserved) (depends: T3)
- [ ] T5: README updates (depends: T3)

## [S4] Acceptance

- [ ] Calling the nonexistent `bashh` → the model receives error text containing `did you mean "bash"`, with `isError` semantics unchanged
- [ ] Calls with a correct name and wrong arguments are entirely unaffected (the message is byte-identical to today's)
- [ ] Several similar tools order by distance, at most 3; with no similar candidate the original message stands
- [ ] The original `error.info` (such as `reachableFrom`, `code: 'UNKNOWN_TOOL'`) is preserved
- [ ] With `toolNameSuggestions: false` the error text is exactly today's
- [ ] guardrails' existing tests stay green; the new cases cover the paths above
