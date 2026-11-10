---
feature: subagent-job-bridge
status: delivered
updated: 2026-11-10
branch: feat/subagent-job-bridge
commits: df1583090a.. # 交付时填写
---

# 子 Agent 任务桥接

[English](subagent-job-bridge.md) | 中文

## Report

**构建内容** —— `@prism/prism-subagent-jobs`（`packages/subagent/subagent-jobs/`）把子 Agent 委派镜像进后台任务注册表：每个面向父会话投递的激活周期都注册一个归属委派会话的 `subagent` 类型 job，于是 `job_list` 与 `job_kill` 可以像管理 shell、workflow 后台工作一样管理委派，补齐了 LangChain 异步子 Agent 模型里 `check_async_task` / `cancel_async_task` / `list_async_tasks` 的词汇。终止 job 的效果与 `interrupt_agent` 完全一致（本地子级收件箱停靠，外部执行永久停止）。job 不携带子 Agent 的回答 —— 子 Agent 结算通知仍是唯一的完成报告 —— 且 `dsh-tool-jobs` 对这一类型抑制完成通知。生命周期 payload 增加了只读的 `parentId` 与 `delivery` 字段（cordis 总线事件，不是 `SessionEventMap` 成员）；caller 投递的 workflow 激活不产生 job，保证抑制恒正确。

**验证** —— `pnpm run typecheck` 通过（5 个聚合门禁）；vitest `packages/subagent/subagent-jobs` 10/10、`packages/jobs/tool-jobs` 62/62，加 `packages/sdk/server` + `packages/experimental/hooks-claude-code` + `packages/subagent/subagent/tests` 574 通过（1 跳过）；`pnpm run duplication` 27 个克隆与基线一致、无一触及变更包；变更文件上 `verify-cordis-catalog`、`verify-plugin-packages`、`verify-tsconfig-paths`、`verify-package-readme-model-experience`、`verify-translation-pairing` 全部通过。基线预存且未触碰：real-product 规格失败（subagent-codex/subagent-claude-code，需外部二进制）、27 个 jscpd 克隆、speech-to-text-http 的 README/product-use/pairing 失败、MeetingSpeechStatus type-equiv 漂移。

**历程记录** —— 委派缝本就已全线异步（非阻塞 `subagent` 工具，`manager.ts` 里的 steer/followup 结算投递）；真正的缺口只是控制面词汇，所以桥接把激活镜像进 `ctx.jobs` 而不是造新工具。caller 投递的激活（workflow 引擎）必须排除在 job 之外——否则 tool-jobs 抑制会丢掉它们唯一的完成报告。审查抓出四个过期生成物（cordis 目录、plugin-packages 参考、tsconfig 别名）与缺失的产品包分类；全部以再生成加一行 optional 分类修复。

## [S1] 问题

LangChain Deep Agents 的异步子 Agent 模型（`start_async_task` / `check_async_task` / `cancel_async_task` / `list_async_tasks`）与本仓库已发布的能力几乎一一对应：非阻塞委派加自动送达的结算通知、`send_message`、`interrupt_agent` 与 `list_agents`。唯一真正的缺口是控制面词汇：运行中的子级无法通过模型控制其余一切后台工作的同一族工具（`job_list`、`job_kill`）来列出或停止，因为子 Agent 激活从未注册进任务注册表。

## [S2] 设计

### S2.1 桥接包

新组合插件 `@prism/prism-subagent-jobs`，位于 `packages/subagent/subagent-jobs/`。它把 subagent 服务与任务注册表耦合起来，而两者互不依赖：

- 声明 `JobKindMap` 合并：`subagent: 'subagent'`。
- 注入 `subagents` 与 `jobs`。
- 在 `ctx.effect()` 内订阅 subagent 生命周期总线事件：
  - `subagent/start` —— 启动一个 job：`kind: 'subagent'`，owner 为委派发起父会话的会话 id，label 为 `<provider> subagent <childId>`；hooks 在配对的 end 边上兑现。
  - `subagent/end` —— 结算配对的 job：`completed` → `completed`；`aborted` → `killed`；`max-tokens`/`error`/`refusal` → `failed`，停止原因作为终态 `detail`。`result` 保持未设置 —— 管理器的结算通知已经把子 Agent 的回答带给父会话，所以 job 是控制面记录，绝不是第二条投递通道。
- job 句柄上的 `cancel` 以指名归属会话的人类父级授权，委托 subagent 服务对该子级的中断；服务再校验 job 归属围栏已证明的同一条父链路，子级保留收件箱，与 `interrupt_agent` 一致。
- 归属组合中需要 job controller（`dsh-tool-jobs`）；没有 controller 时，`ctx.jobs.start` 抛出"no job controller serves this agent"错误，由生命周期包含逻辑接住并记录 —— 委派本身不受影响。

### S2.2 生命周期 payload 上的父级身份

生命周期 payload（`SubagentRunInfo`、`SubagentRunEndInfo`）增加只读的 `parentId: SessionId` 与 `delivery` 字段，由在创建观察者时已持有父级的管理器填充。仅限 cordis 总线 payload 扩展 —— 这些 payload 不是 `SessionEventMap` 成员，因此不触发会话格式或读取者兼容性工作。

### S2.3 完成通知抑制

`dsh-tool-jobs` 对 `subagent` 类型的 job 跳过完成通知：子 Agent 结算通知是该子级唯一的完成报告，第二条"job 已完成，读取其输出"的通知会在空输出环上重复它。其他类型保持现状。

### S2.4 一个 job 对应一个激活周期

一个 job 恰好覆盖一个激活周期（start 边 → end 边）。可续聊子级之后接受追加消息会开启新周期，因而产生新 job，与仓库报告子级工作的方式一致。已结算的 job 记录像已结算的 `bash` job 一样保留在 `job_list` 中。

## [S3] 范围

- 范围内：带单元测试的桥接包；新增的 `parentId`/`delivery` payload 字段；带测试的 tool-jobs 抑制；新包 README、subagent 组 README 行、tool-jobs 说明；changelog 条目。
- 范围外：把子 Agent 转录活动流进 job 输出环；通过 job 记录携带委派任务文本或回答；子级的审批/`waiting` 状态（固定的子级权限范围是刻意的安全立场）；把进行中的子级注入父级系统提示词（触碰 model-visible ⟺ logged 规则）；开放字符串 `kind` 之外的远端/浏览器投影变更。

## Tasks

- [x] T1: 生命周期 payload 增加 `parentId` 并在管理器中填充（依赖：无）—— covers S2.2
- [x] T2: 实现 `prism-subagent-jobs` 桥接包与测试（依赖：T1）—— covers S2.1, S2.4
- [x] T3: tool-jobs 对 `subagent` 类型抑制完成通知，带测试（依赖：T2）—— covers S2.3
- [x] T4: README（新包、组 README 行、tool-jobs 说明）+ changelog 条目（依赖：T2）—— covers S2.1

## [S4] 验收

- [ ] 一次委派产生一个归属委派会话的 `subagent` 类型 job；运行期间在 `ctx.jobs.list(owner)` 可见，子级结算时以映射后的状态结算。
- [ ] 对运行中的 subagent job 执行 `ctx.jobs.kill` 会停止子级当前轮次（收件箱停靠），job 结算为 `killed`。
- [ ] 已结算的 subagent job 不产生 tool-jobs 完成通知；已结算的 `bash` job 仍然产生。
- [ ] 缺少 job controller 时，委派仍然完成，失败的注册被记录而不是抛进委派路径。
- [ ] `pnpm run typecheck` 通过；焦点单元测试通过；`pnpm run duplication` 无新增克隆。
