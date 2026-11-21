---
feature: prism-wiki-coverage
status: designed
updated: 2026-11-21
branch: feat/prism-wiki
commits: 尚未记录；交付时记录 base..head 范围
---

# Prism Wiki 覆盖率

[English](prism-wiki-coverage.md) | 中文

## Report

尚未交付。S1 中的测量值是本计划的起点。

## [S1] Problem

仓库按文件卡覆盖率：`vitest.config.ts` 对 `packages/*/*/src` 下的文件要求 statements、branches、functions、lines 均为 `perFile: 100`，CI 通过 `check:ci:coverage` 执行这条规则——先分片跑、再合并做一次阈值检查。达不到的包无法通过 PR。

resync 之后，`@prism/prism-wiki` 报告 **八个源文件、660 处未覆盖**：

| 源文件 | 未覆盖 |
|---|---|
| `src/client/WikiPage.tsx` | 268 |
| `src/vault.ts` | 193 |
| `src/search.ts` | 71 |
| `src/tools.ts` | 48 |
| `src/commands.ts` | 33 |
| `src/client/api.ts` | 18 |
| `src/service.ts` | 16 |
| `src/web.ts` | 13 |

这些不是缺失的功能。每个套件都驱动了各自功能的主路径；未覆盖的是已经在发布的代码里的第二、第三条分支：解析器拒绝的写法、只有异常文件才会产生的错误类、路由对意外失败的映射、可选参数缺失的那一侧，以及读者切换标签页或清空筛选后才会到达的页面状态。包的 README 记录了这笔欠账，早先版本甚至声称工具、命令、路由与浏览器四半没有直接 spec。

## [S2] Design

### 本计划遵守的规则

1. **测试描述行为，且经真实组合驱动。** 用例驱动产品实际组合的面：磁盘上的临时知识库、真实注册表、真实路由处理器，以及 jsdom 中的页面。不添加只给测试用的生产 API，也不 mock 被测代码。
2. **删掉跑不到的分支，而不是为它写测试。** 类型系统已排除的状态（类型边界后的不可能状态）直接从代码里删除。信任边界上的校验——排队输入、模型/工具 JSON、磁盘文件、线上请求体——保留并补测试。
3. **豁免必须带理由。** 文件要离开闸门，需在 `vitest.config.ts` 里写明理由，并在包 README 里记一行。目前唯一的豁免是浏览器入口 `src/client/index.tsx`，因为还没有 harness 挂载它注册所用的 slot 与 locale 服务。
4. **不改变行为。** 已发布代码只因删除死分支而变，或因为新测试暴露的缺陷而修；修复独立成一次提交并带回归测试。

### 每个文件缺的测试驱动什么

- `src/commands.ts` —— 经真实命令注册表执行每个 `/wiki` 子命令，包括带计数与不带计数的 `log`、不可用的计数、未知子命令的用法文本，以及知识库失败的错误映射。
- `src/web.ts` —— 每条路由的失败分支：各路由的畸形请求体、前置数据无法解析的已存页面、不得冒充 wiki 失败的意外错误，以及搜索可选字段存在与缺失两侧。
- `src/service.ts` —— pre-step 监听器对被拒绝或被中止的步骤让行、`schemaDeliveryEnabled: false`、没有 agent 的调用，以及未配置根目录的知识库。
- `src/client/api.ts` —— 线上字段收窄时拒绝错误的数字、布尔、可空与联合字段，每个读取器一个用例。
- `src/tools.ts` —— `wiki_source` 缺参分支、页面存在性探测遇到每种错误类，以及意外错误向上抛出而不是变成结果。
- `src/search.ts` —— 属于其他应用的数据库、被替换一次的不可读数据库、回滚路径、空集与满集上的 `rebuild`，以及摘要与匹配器的边界。
- `src/vault.ts` —— 解析器拒绝的写法（缺少分隔符、块未闭合、需要列表处给了标量、置信度超范围）、每个前置数据字段的失败、不可读页面的遍历，以及拒绝路径穿越或「文件当目录」的路径守卫。
- `src/client/WikiPage.tsx` —— 读者会到达的状态：空知识库、列表读取失败与页面读取失败、每个筛选与清除筛选、折叠的分组、搜索页的空闲/搜索中/无结果/有命中、健康页在检查前后、编辑器的每个字段、来源面板的加载中/截断/失败，以及 wikilink 重写器对围栏代码块与行内代码的处理。

### 顺序

由便宜到贵，让闸门剩余面在每个提交后都缩小：`client/api`（18）、`web`（13）、`service`（16）、`commands`（33）、`tools`（48）、`search`（71）、`vault`（193），最后 `WikiPage`（268）。共享夹具先行，避免两个大文件各自复制一份。

## [S3] Scope

- 范围内：上述测试补充、它们共享的夹具、对跑不到分支的删除，以及新测试暴露出的缺陷修复；记录结果的 README 与 spec 更新。
- 范围外：新功能或行为改动、覆盖率阈值本身、其他包的覆盖率欠账，以及为浏览器入口手写 slot/locale harness。

## Tasks

- [ ] T1: 共享夹具 —— 畸形前置数据表、损坏与外来的搜索数据库、页面构造器；验收：每个助手至少被两个套件使用且带 JSDoc（依赖：无）
- [ ] T2: `client/api.ts` 达到 100% —— 每个字段读取器一个拒绝用例（依赖：T1）
- [ ] T3: `web.ts` 达到 100% —— 每条路由的失败分支，包括无法解析的已存页面与意外错误（依赖：T1）
- [ ] T4: `service.ts` 达到 100% —— pre-step 的让行路径与 schema 投递开关（依赖：T1）
- [ ] T5: `commands.ts` 达到 100% —— 经命令注册表的每个子命令与参数分支（依赖：T1）
- [ ] T6: `tools.ts` 达到 100% —— 缺参、错误类与意外错误向上抛出（依赖：T1）
- [ ] T7: `search.ts` 达到 100% —— 外来、不可读与空的数据库，以及摘要边界（依赖：T1）
- [ ] T8: `vault.ts` 达到 100% —— 解析器与校验器的拒绝、不可读页面遍历、路径守卫（依赖：T1）
- [ ] T9: `WikiPage.tsx` 达到 100% —— 读者状态：空、失败、筛选、折叠、搜索、健康、编辑器字段、来源面板（依赖：T1）
- [ ] T10: 验证 —— 包的闸门以零退出，README 的覆盖率说明被结果替换，feature spec 记录结果（依赖：T2, T3, T4, T5, T6, T7, T8, T9）

## [S4] Acceptance

- [ ] `npx vitest run packages/prism/prism-wiki --coverage --coverage.include='packages/prism/prism-wiki/src/**'` 以零退出，除已记录的浏览器入口豁免外，每个文件的 statements、branches、functions、lines 均为 100%。
- [ ] `pnpm run check:ci:coverage` 不再报告任何 `packages/prism/prism-wiki` 文件。
- [ ] 没有新增只给测试用的生产 API，也没有新增 `as unknown` 断言。
- [ ] 所有既有测试保持不变并通过；若修改，改动在对应提交中说明。
- [ ] 包 README 的覆盖率说明从欠账改为实测结果。
- [ ] 每个被判定为跑不到而删除的分支，其提交中写明它无法运行的类型层原因。
