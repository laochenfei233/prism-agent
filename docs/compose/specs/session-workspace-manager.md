---
feature: session-workspace-manager
status: designed
updated: 2026-11-04
branch: feat/session-workspace-manager
commits: pending
---

# 会话与工作区管理能力（标注 + 批量）

## Report

## [S1] 问题

Prism 侧栏已经有归档（隐藏 / 全看 / 仅看）、置顶、重命名、分叉、标题与全文搜索、分组、排序，但会话只有这些二值状态。用户想给会话加自己的分类——收藏、待回看、优先级、标签、备注——失败的话只能在标题里塞关键词；想对一批会话做同样的事，只能一条一条点菜单。

第三方插件 `dsh-session-manager`（[README.zh.md](https://github.com/hkkz9522/dsh-session-manager/blob/main/README.zh.md)）提供了这套管理能力。本特性把其中「会话元数据 + 批量处理 + AI 整理的剪贴板往返」并入 Prism 原生的会话与工作区界面。

## [S2] 设计

### S2.1 标注存在哪里

标注是**每浏览器**的视图元数据，不是会话内容，也不是跨设备数据。它和 `groupBy` / `orderBy` / `archivedFilter` 一起放在现有的 `createWorkspaceViewStore()` 里，用同一个 `persist: 'dsh.workspace.view.v5'`（`localStorage` 整值 JSON）。新增字段 `annotations?: Record<SessionId, SessionAnnotation>`，按 `archivedFilter` 的先例声明为**可选**并防御式读取，因此旧 v5 blob 不会丢失用户已保存的分组、排序与展开状态。

`shortcut:` 标注按浏览器保存（换浏览器、清站点数据即丢失），需要跨客户端同步时改走 workspace 存储域 + Remote API。

不放进会话日志：会话事件是模型可见事实，用户备注不是，写进去会污染上下文与快照基线。

### S2.2 标注数据模型与规范化

```ts
interface SessionAnnotation {
  favorite?: boolean
  reviewLater?: boolean
  priority?: 1 | 2 | 3 | 4 | 5   // 缺省 = 3（普通）
  tags?: readonly string[]        // ≤ 20 个，每个 ≤ 32 字符
  note?: string                   // ≤ 2000 字符
}
```

规范化在写入前完成，纯函数放在新文件 `annotations.ts`：

- 标签分隔符同时接受英文 `,` 与中文 `，`；去首尾空白、丢空项、按大小写不敏感去重（保留首次出现的写法）、最多 20 个、每个截断到 32 字符。
- 备注去首尾空白后按 2000 字符截断；空备注等于没有备注。
- 优先级只接受 1–5 的整数；3 是默认值，写成 3 与不写等价（不占存储）。
- 一次标注全部为空（无收藏、无待回看、优先级 3、无标签、无备注）时，删除该会话的条目，标注表不随会话数量无限增长。

### S2.3 行内标记

会话行（分组列表、扁平列表、搜索结果）在标题后渲染三个标记，全部来自 locale 字典并可读：

- 收藏：实心图标，`aria-label` 为「已收藏」。
- 待回看：队列图标，`aria-label` 为「待回看」。
- 优先级：非默认值（≠3）时渲染数字徽标，`aria-label` 为「优先级 N」。

标记是纯展示，不拦截点击，不加宽行高。

### S2.4 筛选、排序与搜索

- 筛选：视图选项菜单新增「标注筛选」一节，三选一 `all` / `favorite` / `reviewLater`，与归档筛选、分组、排序叠加；存放在视图 store 的 `annotationFilter` 字段（同样可选 + 缺省 `all`）。
- 排序：`orderBy` 增加 `priority`。优先级升序（1 最先），同优先级按最近更新降序，再按会话 ID 稳定排序；置顶行仍然领衔，与现有分区规则一致。分组顺序在优先级模式下保持注册表顺序（不按活动度重排）。
- 搜索：本地匹配除标题与工作区名外，再匹配标签与备注（大小写不敏感）。搜索仍不读取聊天历史，Host 全文搜索保持不变。

### S2.5 编辑界面

会话行 `⋯` 菜单新增三项（与现有条目同属 `sidebar.workspaces.session.menu.item` 列表）：

- **收藏 / 取消收藏**（order 150）：一键切换。
- **待回看 / 取消待看**（order 160）：一键切换。
- **标签与备注…**（order 250）：打开对话框。

对话框是 `shell.overlay` 条目，沿用重命名对话框的做法：菜单项只发出请求（`SessionAnnotationTarget`），对话框按会话 id 作 key 打开，字段为收藏、待回看、优先级下拉（1 最高 … 5 最低）、标签输入框、备注文本域。取消丢弃草稿，保存写入标注。输入不做逐键保存，避免每次敲键都写 localStorage。

### S2.6 AI 整理（剪贴板往返，不调用模型）

对话框底部两个按钮：

- **复制 Prompt**：把当前会话标题、现有标注与输出格式要求拼成一段提示写入剪贴板。提示文案在 locale 字典里，含 `{title}` / `{json}` 占位符。
- **导入**：读剪贴板文本，解析出 JSON（可识别 Markdown 代码块包裹、开头 BOM、智能引号），按 S2.2 同样的规则校验后填进字段。解析失败在对话框内以 `role="alert"` 报错，不覆盖已填内容。

解析器只认 `favorite` / `reviewLater` / `priority` / `tags` / `note` 五个键，未知键忽略，类型不符的键忽略。

### S2.7 批量处理

- **入口**：视图选项按钮左侧新增「批量处理」开关按钮（`IconChecklistOutlineRegular`），只在宽状态显示。
- **选择**：批量模式下每行标题左侧出现复选框，点击行本身仍然打开会话。选择是会话 id 的集合，只存在于浏览器本地状态，不持久化；切换筛选或搜索结果后保留已选，退出批量模式清空。
- **工具栏**：批量模式下 header 让出一条工具栏：`全选当前筛选` / `清空选择` / `批量操作` 菜单 / 完成。
- **批量动作**：归档、取消归档、收藏、取消收藏、待回看、取消待看、设置优先级（1–5）、清空标签。
- **执行**：逐个串行执行，逐条捕获失败；结束后弹出一条结果通知（成功 N 条 / 失败 M 条），失败项不改变选中集合，便于重试。归档仍复用 Host 的归档命令，运行中的会话被 Host 拒绝即计入失败，不触发逐条确认对话框。

### S2.8 不在本次范围

- **跨工作区移动会话**（原插件 1.1 的「移动至工作区」）：Prism 的会话 cwd 存在**不可变的会话头**里（`working-directory` 包：`header 保留原始项目`），工作区归属校验（`entity.attachSession`）与启动引导都以 `header.cwd` 为依据。真正的移动要重写落盘头（JSONL/zstd、写租约、索引与投影缓存失效），属于会话格式级改动，与本特性的 UI 范围不同；用户已在本次显式选择不做。
- **删除会话**：产品当前没有删除会话的 Host 命令（会话只有创建、重命名、分叉、提示、附件、队列），批量删除没有可调用的执行者。
- **工作区归档 / 隐藏开关**：用户未选。
- **Agent 预设迁移**：用户未选。

## [S3] 范围

- 在范围内：`packages/client/ui-workspace`（标注模型与纯函数、视图 store、树派生、行渲染、标注对话框、批量模式、locale 字典、CSS）、该包的测试、本 spec 与包 README 的相应更新。
- 不在范围内：Host 存储域与 Remote API 新增、会话日志格式、跨工作区移动、删除会话、工作区归档、`packages/client` 之外的包。

## Tasks

- [ ] T1: `annotations.ts` — 类型、标签解析与格式化、备注规范化、空判定、Prompt 生成、剪贴板 JSON 解析（covers: S2.2, S2.6）
- [ ] T2: 视图 store 增加 `annotations` / `annotationFilter` 与 `setAnnotation` / `setAnnotationFilter` 写入动作（covers: S2.1, S2.4）
- [ ] T3: 树派生透传标注、标注筛选、优先级排序、搜索匹配标签与备注（covers: S2.3, S2.4）
- [ ] T4: 会话行与搜索行渲染标记；批量模式下渲染选择框（covers: S2.3, S2.7）
- [ ] T5: 标注菜单项与对话框（收藏 / 待回看 / 标签与备注）（covers: S2.5）
- [ ] T6: 对话框内「复制 Prompt」「导入」（covers: S2.6）
- [ ] T7: 批量模式入口、工具栏、批量动作执行与结果通知（covers: S2.7）
- [ ] T8: 测试（纯函数、store、派生、组件）与文档（本 spec、包 README、changelog 片段）（covers: S2.2–S2.7）

## [S4] 验收

- [ ] 给会话设置收藏 / 待回看 / 优先级 / 标签 / 备注后，刷新页面标记仍在（同一浏览器）。
- [ ] 标注筛选三态可用，并与归档筛选、分组、排序叠加生效。
- [ ] 优先级排序把 1 排在最前、3 与未设置并列、同优先级按最近更新降序。
- [ ] 搜索框输入标签或备注里的词能命中该会话。
- [ ] 菜单一键切换收藏与待回看，重复点击可取消。
- [ ] 对话框保存后行内标记立即变化；取消不写入。
- [ ] 复制 Prompt 把含当前标注 JSON 的提示写入剪贴板；导入合法 JSON 填入字段，非法 JSON 报错且不覆盖已填内容。
- [ ] 批量模式可多选、全选当前筛选、清空选择；批量归档 / 取消归档 / 收藏 / 待回看 / 设置优先级 / 清空标签逐条执行并给出成功与失败条数。
- [ ] 退出批量模式清空选择，且不改变任何会话数据。
- [ ] `pnpm run test:gui`、`pnpm --filter @deepseek-ai/dsh-client-ui-workspace exec vitest run --coverage`、`tsc -b tsconfig.client.json`、`pnpm run verify-client-ui-i18n` 全绿。
