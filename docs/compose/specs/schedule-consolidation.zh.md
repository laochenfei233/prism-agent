---
feature: schedule-consolidation
status: delivered
updated: 2026-11-24
branch: master
commits: c74c424c37
---

# 调度系统合并：以上游 Schedule 为准，退役 Cron

[English](schedule-consolidation.md) | 中文

## Report

**做了什么** —— 三组 cron 包整体删除（`packages/cron/cron`、`packages/cron/tool-cron`、`packages/api/cron-controller`、`packages/client/ui-cron`），以及所有指向它们的接线：`apps/cli/config/examples/cron` overlay、CLI 与 web-app bundle 的依赖行、tsconfig 别名与工程引用、`.changelog/config.json` 的版本文件行，以及 product-policy、README model-experience、目录生成器与两份 agent-preset 技能参考（cordis-composition-reference、dsh-doc）里点名它们的条目。web 组合只剩 `schedule` 与 `ui-schedule` 两行；schedule 本身未改动。

**随动文档与目录** —— `docs/subsystems/cron.*` 及其索引行删除；`capability-seams`、`event-producer-consumer`、`config-catalog`、`persistence-catalog`、`persistence-schema.json` 与英文 `tool-catalog` 由生成器在 master 源上重生成；`tool-catalog.zh.md` 与 `capability-seams.zh.md` 按英文结果手工同步（中文对照件走 pairing 流程，不由生成器写出）；`tool-cordis` 的 api catalog 去掉两个 cron 服务与除 schedule 自有的 `CronInput`、`CronScheduleRecord` 之外的全部 cron 类型；slot-catalog 由 gen-client-catalog 重生成。persistence 记录 `2026-11-24-cron-source-retirement` 以 `same-version` 确认变化的四个事件根（`agent/inbox/spliced`、`developer/message`、`session/title-llm-request`、`user/message`，`previous` 链接到 `2026-11-05-cron-message-source`）；`cron` storage domain 的字节留在磁盘上且不再被读取。新增升级指南条目与 changelog 片段说明移除与重建路径，历史 cron Note 头部加了退役指针，fork-upstream-divergence 的 A7 行改为「Cron 导入已退役」。

**验证（均在 master）** —— typecheck 5/5 通过；`gen-cordis-catalog` 137 个产物 `--check` 通过、`gen-doc-graphs` 写出 7 份图文档、`gen-tool-catalog`/`gen-client-catalog`/`gen-config-catalog`/`gen-persistence-catalog` 重生成且 `--check` 通过；`verify-persistence-changes` 通过（68 roots / 33 records）；`verify-persistence-formats --write` 刷新 3 个文件后通过；focused vitest 131/131 通过；`verify-doc-refs`（5745 个文件）、`verify-md-wrap`（3067 个文件）、`verify-upgrade-guides`、`verify-agent-note-format`（470 个 Note）、`verify-package-meta`、`verify-subsystem-pages`（61 组）、`verify-doc-budgets`、`verify-tsconfig-paths` 全部通过。活代码残留扫描（`dsh-cron|cron-controller|ui-cron|ctx.cron|cron_*` 工具名）仅剩本 spec、升级指南、历史 Note 与历史 resync spec。

**既有红灯（与本变更无关）** —— `verify-translation-pairing` 在 `apps/desktop/src-tauri/target` 构建产物 README、`prism-autonomy` spec 与 `upstream-resync-0.2.3-alpha.2` spec 上失败；`verify-md-links` 剩 apps/desktop 相关既有死链；`verify-package-paths` 剩 `prism-tasks` 与 `python-ptc-sandbox` 的既有死路径；`docs:build` 因本机 esbuild 不识别 `es2024` target 失败（website 主题文件，工具链与环境问题）；`test:snapshot -t meeting-minutes-list` 在 master 基线（暂存本变更后复测）同样失败。

**偏离** —— S2.2 的快照清单不成立：没有任何已录制快照包含 cron 的工具面；PTC system prompt 里的 `kind: "cron"` 是 schedule 的 `CronScheduleRecord`，JSONL 里的是冻结的 skill 目录文本；`snapshots/web/ptc-round-scoped/` 不存在。因此快照保持原样。本次落地直接在 master（installer-master worktree）进行；`feat/prism-wiki` 行经其常规 resync/merge 流程获取本变更。persistence 记录的 `previous` 链曾误算，由 `verify-persistence-changes` 的 fork 检测纠正为 `2026-11-05-cron-message-source`。

**评审轮** —— 评审修正了本变更在自己的文档里引入的两处错误：升级指南列出了并不存在的 `cron_view` 工具（tool-cron 只有五个工具）；指向历史 cron Note 的退役指针留下一条指向已删除 overlay 的死链，被 `verify-md-links` 标出，现改为文字说明删除事实。


## [S1] Problem

树里并存两套定时任务系统：fork 早期导入的 cron（`packages/cron/cron` 的 `ctx.cron` 服务、`packages/cron/tool-cron` 的模型工具、`packages/api/cron-controller` 的 Remote 控制器、`packages/client/ui-cron` 的任务面板，外加 `apps/cli/config/examples/cron/cordis.yml` overlay）和上游 0.2.x 的 schedule（`packages/schedule/schedule` + `tool-schedule` + `client/ui-schedule`，"Automation tasks" 页）。web 组合里 `ui-schedule` 已启用（`packages/bundle/web-app/cordis.patch.yml`），`ui-cron` 在同一文件里以 `disabled: true` 搁置，cron 全套要靠显式 overlay 才生效。双入口、双 storage domain、双文档与目录行，认知和维护成本翻倍；cron 后端包在树里却没有默认组合接入，处于半吊子状态。决策：以上游为准合并——保留 schedule，整体退役 cron。

## [S2] Design

### S2.1 保留面：schedule 已覆盖 cron 的定时词汇

- schedule 的 `CronScheduleRecord`（`packages/schedule/schedule/src/types.ts`）原生支持五段 Vixie cron 表达式 + 显式 IANA 时区（`CronInput { expression, time_zone }`），另有 after/at/every/daily/weekly 五种规则。cron 的核心能力（五段表达式、时区、向会话投递 prompt、任务跨重启存续）全部被覆盖。
- schedule 的投递目标（既有会话 / 建一个复用 / 每次新建）对应 cron 的 `CronExistingSessionTarget` / `CronNewSessionTarget`。
- schedule 与其 UI 在 web 组合中保持现状，不改行为。

### S2.2 退役面：cron 全链路删除

依赖核查结论：`@deepseek-ai/dsh-cron` 只被 `tool-cron` 与 `cron-controller` 依赖，无其他消费方，可以整体摘除。删除清单：

- 包：`packages/cron/**`（cron、tool-cron 与组 README 三件套）、`packages/api/cron-controller/**`、`packages/client/ui-cron/**`。
- 组合：`apps/cli/config/examples/cron/cordis.yml` overlay；`apps/cli/package.json` 的 `dsh-api-cron-controller` 与 `dsh-cron` 依赖行；web-app patch 的 `ui-cron` 行及 `packages/bundle/web-app/package.json` 对应依赖行。
- tsconfig：`tsconfig.base.json` 的 cron 系别名、`tsconfig.host.json`/`tsconfig.client.json` 的引用行。
- typert：随包删除即撤销 face-purity 注册（resync 时给 cron 加的 `@typert service cron`、`./typert` export 不复存在）。
- 文档与目录：`docs/subsystems/cron.md/.zh.md/.i18n.yaml` 三件套及 `docs/subsystems/README(.zh).md` 的 cron 行；`docs/capability-seams(.zh).md` 的 `ctx.cron`/`ctx.cronController` 行与 mermaid 节点；`gen-cordis-catalog` 的 cron/cronController SERVICE_PAGE 行、`gen-doc-graphs` 的 cron SERVICE_ROLES 行；重生成 `docs/config-catalog(.zh).md`。
- 快照：cron 工具面出现在 `snapshots/sdk/desktop-ptc-context*/system-prompt.expected.md`、`snapshots/web/{ptc-round,ptc-round-scoped,optional-string-editor,official-subagent-bundle}/system-prompt.expected.md`、`snapshots/session/meeting-minutes-list/session.v4.jsonl`，逐一更新；`snapshots/web/schedule-catalog/` 是 schedule 的，保留。
- 偏离索引：`docs/compose/spec/fork-upstream-divergence(.zh).md` A7 行把 cron 从"进行中的导入"改为"已退役（见本 spec）"。

### S2.3 数据处置：不迁移、不删除

cron 仅经 opt-in overlay 启用，默认组合从未包含它，真实受影响用户极小。存储里的 `cron` domain（`CronJob` v1 记录）保留磁盘字节不清理，符合"永不删除已提交世代"的持久化规则；代码删除后这些记录成为无人读取的孤儿。升级指南写明：曾用 cron overlay 的部署需在 schedule（Automation tasks 页）重建任务。

考虑过启动时一次性转换（`CronJob{expression, timeZone, prompt, target}` → schedule `kind:'cron'` 记录），放弃：cron 的 per-task `agentPreset`/`permissionPreset`/`model`/`overlapPolicy`/`misfirePolicy` 在 schedule 里没有对应字段，转换有损；且这会让 fork 侧代码长期持有 cron 的解码知识，与"退役"目标相悖。

### S2.4 文档

升级指南新增 breaking 条目（cron 移除、以 schedule 重建的路径）；随包删除的 README 三件套一并移除；`docs/persistence-changes` 与 persistence catalog/formats 补记 `cron` domain 退役（记录保留、不再读取）。

## [S3] Scope

- In scope：S2.2 全部删除与接线清理、目录/文档重生成、快照更新、persistence 退役记录、升级指南、A7 行更新。
- Out of scope：schedule 功能增强；cron→schedule 自动迁移；桌面壳与安装器改动；`.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.*` 历史设计 Note 的改写（作为历史记录保留，仅在其头部加一行"已退役"指向本 spec）。

## Tasks

- [x] T1: 删除三组包与全部接线（overlay、bundle 行、cli 依赖、tsconfig 别名/引用） (depends: none)
- [x] T2: 文档与生成目录清理（subsystems 三件套、README 行、capability-seams、config-catalog 重生成、gen-cordis-catalog/gen-doc-graphs 行） (depends: T1)
- [x] T3: 受影响快照更新（S2.2 清单）——没有快照包含 cron 工具面，见「偏离」 (depends: T1)
- [x] T4: persistence catalog/formats 退役记录 + changes ack (depends: T1)
- [x] T5: 升级指南条目 + fork-upstream-divergence A7 行更新 (depends: T1)
- [x] T6: 验证：typecheck、build、doc-sync、test:snapshot 相关过滤、keyless 插件安装 (depends: T1,T2,T3,T4,T5) —— 在 master 上 typecheck 5/5 通过、目录/文档/persistence 门禁通过、focused vitest 131/131；doc-sync 剩余 7 项失败与快照场景失败均为 master 基线既有（见 Report）

## [S4] Acceptance

- [x] `rg -n "dsh-cron|cron-controller|ui-cron"` 在活代码（packages/apps/plugins/scripts）中清零，仅历史 Note 与升级指南保留提及。
- [x] web-app patch 的调度行只剩 `schedule` 与 `ui-schedule`；`apps/cli/config/examples/` 无 cron overlay。
- [x] typecheck 5/5 通过；config-catalog 与能力缝文档无 cron 残留。doc-sync 聚合剩余 7 项失败均为 master 基线既有（src-tauri 构建产物 pairing、prism-autonomy、resync spec 标题数、md-links 桌面死链、es2024 esbuild 环境等），与本变更无关。
- [x] 受影响快照为零：没有任何快照包含 cron 工具面，故无需改动；meeting-minutes-list 场景在 master 基线（暂存本变更后）同样失败，属既有漂移。
- [x] 升级指南说明 cron 已移除、任务需在 schedule 重建；persistence 记录标注 cron domain 退役且数据保留。
