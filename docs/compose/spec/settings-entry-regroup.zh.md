---
feature: settings-entry-regroup
status: delivered
updated: 2026-10-31
branch: feat/settings-entry-regroup (worktree .worktrees/settings-entry-regroup)
commits: 421ebe5731..4481fd6089
---

# 设置入口重组

[English](settings-entry-regroup.md) | 中文

## 报告

**交付内容** — 未登录的侧栏入口是纯粹的「设置」按钮：齿轮图标按钮，经现有 `openSettings` 直接打开设置对话框，不再有菜单；已登录入口保留头像菜单，但只列「设置」（含外壳组合键）与「退出登录」。登录入口移到模型页的 DeepSeek 卡片：账号包以键 `llm-deepseek` 注册 `settings.models.provider-card`，未登录时卡片在各种形态下都显示「登录」动作，点击走启动器承载的同一个登录弹窗。意见反馈以 `settings.general.item` 行（id `feedback`，order 110）收尾通用设置列，在新标签页打开 `ContactConfig.issuesUrl`——新增的经过校验的引导字段，默认 `https://github.com/laochenfei233/prism-agent/issues`；被替换的飞书问卷路径（`contactUs` 操作、`contact-url.ts`、`contactFormUrl`/`contactSource`）删除。复用的反馈标签词条由 `contactUs` 改名为 `feedback`；无关的 `more` 词条保留给账号设置的余额行。

**验证** — `pnpm run typecheck`：5 项门禁通过。`pnpm exec vitest run packages/client/ui-settings-account`：24 个文件 378/378。Web e2e（`vitest.web.config.ts`）：onboarding-native 2（models 黄金文件刷新：DeepSeek 卡片出现「登录」按钮；删除未登录菜单黄金文件）、account-login 1（经 DeepSeek 卡片登录）、menu-material 1（以面板「更多」菜单替换账号菜单作为测量面；session-menu 黄金文件刷新）、shortcuts 7、collapse-timing + agent-team-panel 7、settings-chrome 18（对话框黄金文件刷新）、workspace-management 17、bonus-notice 1、window-drag-coverage 1 + 5 项平台跳过。提交钩子（暂存文件 lint、翻译配对、空白）：通过。`verify-md-wrap`：通过（移除分叉索引文档对中预先存在的重复 Report 段落）。`gen-config-catalog` 重新记录部署参考。本机预先存在的失败（已验证与 master 一致）：全仓 oxlint（涉及路径 285 个错误；类型感知规则本地解析失败）、duplication（13 个克隆；master 14）、`verify-package-readme-summaries`（ui-chat/ui-conversation）、doc-standard（prism-backup README.zh）、`verify-repository-references`（uv.lock 钉住行）。

**历程记录** — account-login e2e 最初找不到「登录」按钮：web 脚手架在无钥匙回放中禁用 `llm-deepseek`，除非设置 `deepSeekMissingCredential: true`（该标记同时遮蔽环境钥匙）；遮蔽后又会触发首次运行凭证对话框盖住工作区，因此 fixture 同时设置 `credentialOnboarding: false`。`src/client/index.ts` 上的 tsgolint 崩溃（`slice bounds out of range`）根因是标记插入脚本写出了缺少 `//` 注释前缀的 `PRISM-DIVERGENCE:` 行——一个标签语句形式的语法混乱——并非工具缺陷；同样的失误本会破坏 CSS 构建，因此添加标记的脚本必须断言自己写出的注释语法。

## [S1] 问题

未登录时，左下角启动器显示"更多"，把"设置""意见反馈""登录"藏进一层菜单。这三个去处本不属于一起：设置是主入口；登录属于使用账号的地方（模型页的 DeepSeek 模型卡片）；意见反馈应与通用设置里的其他偏好并列。

## [S2] 设计

**S2.1 — 未登录启动器回归纯粹的"设置"按钮。** `AccountMenu` 渲染齿轮图标加"设置"文案的按钮，点击经现有 `openSettings` 直接打开设置对话框；侧栏折叠时只显示图标。已登录时保留头像菜单，但菜单只列"设置"与"退出登录"。未登录专用菜单及其宽度样式类移除；`more` 词条保留给账号设置的余额行。

**S2.2 — 登录入口移入 DeepSeek 模型卡片。** 账号包以键 `llm-deepseek` 注册模型页的 `settings.models.provider-card` 插槽，在未登录时贡献"登录"动作。点击走共享登录流程（`start()`），其对话框仍由启动器承载；凭据存储后按钮消失，已登录的"DeepSeek 账号"行照旧显示"已登录"。不改动 `ui-settings-models` 源码：插槽按声明消费。

**S2.3 — 意见反馈是通用设置的最后一行。** 账号包以 id `feedback`、order 110（排在版本行的 100 之后）注册 `settings.general.item`。该行渲染"意见反馈"与外链图标，在新标签页打开配置的 GitHub issues 地址；复用的标签词条名为 `feedback`。

**S2.4 — issues 地址是经过校验的引导配置字段。** `ContactConfig` 新增 `issuesUrl`（HTTPS 模式），默认 `https://github.com/laochenfei233/prism-agent/issues`，经本包现有的 `__DSH_CONTACT_CONFIG__` 引导注入行组件，部署可自行改指。

**S2.5 — 被替换的问卷路径删除。** 菜单项移除后，飞书问卷不可达：删除 `contactUs` 操作、`contact-url.ts`、其测试以及 `contactFormUrl`/`contactSource` 字段；`bonusAckRetryDelayMs`/`bonusAckRetryMaxDelayMs` 保留。不可达代码无法通过逐文件覆盖率门。

**S2.6 — 分叉记账。** 每处分叉点携带 `PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A13.` 标记，索引新增 A13 领域。两个受影响包的 README 双语同步更新。

## [S3] 范围

- 范围内：启动器重塑、DeepSeek 卡片登录注册、通用反馈行、`ContactConfig` 字段变更、问卷路径删除，以及相应的测试、快照、README 和分叉索引条目。
- 范围外：已登录头像菜单的视觉设计、退出登录的搬迁、桌面引导流程，以及 `ui-settings-models` 的任何行为变更。

## 任务

- [x] T1: 未登录启动器渲染"设置"按钮；菜单只留"设置/退出登录"（依赖：无）
- [x] T2: 注册 DeepSeek 卡片登录动作（`settings.models.provider-card`，键 `llm-deepseek`）（依赖：无）
- [x] T3: 注册通用设置反馈行（order 110），打开 `ContactConfig.issuesUrl`（依赖：无）
- [x] T4: 删除问卷路径及其字段；清理包内测试（依赖：T1、T3）
- [x] T5: 更新期望快照、onboarding-native e2e 及其黄金文件（依赖：T1-T3）
- [x] T6: 更新 README，添加分叉标记与索引领域（依赖：T1-T4）

## [S4] 验收

- [x] 未登录时，左下角启动器是一个"设置"按钮，激活即打开设置对话框；不再渲染菜单。
- [x] 已登录时，左下角菜单恰好列出"设置"与"退出登录"。
- [x] 未登录时，模型页的 DeepSeek 卡片提供"登录"；激活后打开登录对话框；凭据存储后按钮消失。
- [x] 通用设置以"意见反馈"行收尾，在新标签页打开 `https://github.com/laochenfei233/prism-agent/issues`，且遵循被覆盖的 `issuesUrl`。
- [x] `rg -n "contactFormUrl|contactSource|contactUs|contactUrl"` 无源码残留，包内聚焦测试通过。
- [x] 双语文档对与两对 README 通过配对门；分叉索引列出新领域。
