---
feature: prism-wiki
status: in-progress
updated: 2026-11-21
branch: feat/prism-wiki
commits: 尚未记录；交付时记录 base..head 范围
---

# Prism Wiki（LLM 维护的知识库插件）

[English](prism-wiki.md) | 中文

## Report

**已构建内容** — `@prism/prism-wiki` 在 `<DSH home>/knowledge` 维护一个 Markdown 知识库：不可变的 `raw/` 来源、模型拥有的 `wiki/` 页面、共同演化的 `AGENTS.md` schema、生成的 `index.md`、只追加的 `log.md`，以及插件私有的 `.wiki/`（内含可重建的 SQLite FTS5 缓存）。五个模型工具经 `ctx.tools.register` 注册，`/wiki` 是操作员界面，六条宿主 Fetch 路由承载 Web 知识库页面，包以预构建镜像发布在 `plugins/prism-wiki`。

Web 页面现在闭合了自己的回路，而不只是展示知识库：被引用的原始来源可以就地打开；解析不到页面的 wikilink 会为它要的名字打开草稿；新页面的路径随标题与类型推导，直到读者自己填写；首次进入即打开 `overview.md`；新草稿遇到库里已有的路径会拒绝写入；被拒的保存把库中正文并排显示在保留的草稿旁；窄视口把目录折叠到自己的开关后面。

**验证** — `npx vitest run packages/prism/prism-wiki` 在八个测试文件上通过 146 个测试，其中包含一个真实 Loader 组合：四个 shipped row 连同浏览器行、架在真实 Connection 上启动，并逐一调用六条路由；`tsc -b` 对两个面零诊断；包内 `oxlint` 无发现；`verify-package-dependencies` 在两处经审视的 safe 分类和一处已移除的运行时导入后符合策略；`verify-doc-budgets`、`verify-client-ui-i18n`、`verify-export-jsdoc`、README 摘要闸门、`verify-agent-note-format` 与 README 配对闸门通过。未达成：仓库的逐文件覆盖率闸门。`test:coverage` 仍在八个源文件上报告 667 处未覆盖——`src/client/WikiPage.tsx` 268 处、`src/vault.ts` 193 处、`src/search.ts` 71 处、`src/tools.ts` 55 处、`src/commands.ts` 33 处，其余在 `src/client/api.ts`、`src/service.ts` 与 `src/web.ts`。浏览器入口 `src/client/index.tsx` 与其他客户端注册入口一起在 `vitest.config.ts` 中豁免，因为目前没有 harness 挂载它注册所用的 slot 与 locale 服务；其余记为待办。

**历程记录** — 1) 本分支基于 resync 前的导入提交，落后 `master` 392 个提交；合并预演只有十处机械冲突，因此 resync 仍然推迟，而包作用域在本轮已改名为 `@prism/prism-wiki` 以对齐 `master` 的约定。2) `verify-package-dependencies` 卡在三处未分类的宿主导出：`defineTool` 与 `createUserMessage` 经审视归类为 safe（两者都返回普通冻结值，没有模块内身份），`CommandDefinitionId` 改用 `brandString<CommandDefinitionId>`，从而不再导入提供方的运行时。3) schema 帧的读取把异常抛进了 `agent/pre-step` waterfall，一个损坏的 `AGENTS.md` 就能让它正要准备的步骤失败；现在针对知识库级失败静默清账，其他失败仍向上抛出。4) Web 编辑器的"新建页面"会覆盖已存在的路径，因为新草稿没有可回传的修订号；页面现在拒绝写入并指出那一页，保存路由对任何客户端执行同一条规则。5) `plugins/prism-wiki/README.i18n.yaml` 与它的 README 对已经脱节，配对闸门发现后本轮重新记录。

## [S1] Problem

本仓库里的文档工作都是检索形态的。原始文件放在工作区中，模型从碎片里拼出一个答案，而这个答案在轮次结束时就被丢弃。没有任何东西沉淀下来，因此一个需要综合五份来源才能回答的问题，每次被问到都要从头重新推导一遍。

`prism-memory` 一条记录只存一个断言。它回答得了"我们知道什么"，却回答不了"这批来源整体上说了什么、它们在哪里互相矛盾"，因为它没有页面级产物，页面之间也没有交叉引用。

Karpathy 的 llm-wiki 模式指出了这个缺失的能力：三个层次（不可变的原始来源、由 LLM 拥有并以 `[[wikilinks]]` 互链的 Markdown 页面构成的 wiki，以及让模型成为有纪律维护者的 schema）、三个操作（摄取、查询、巡检），以及两个导航文件（内容目录与只追加的日志）。知识被编译一次并保持最新，而不是每次查询都重新推导。

本仓库中没有任何东西提供这套布局、这份 schema、这些操作，也没有在产品内阅读该结果的方式。

## [S2] Design

### 层次与布局

`vaultRoot` 是经过校验的 Config 字段，默认值为 `<DSH home>/knowledge`。该目录由插件拥有：首次使用时创建整套布局，并拒绝接管一个非空、且尚不是 vault 的目录。

```
$DSH_HOME/knowledge/          the vault — open this directory as an Obsidian vault
  AGENTS.md                   the schema: conventions the human and the model co-evolve
  index.md                    generated content catalog
  log.md                      append-only chronology
  raw/                        immutable sources, never modified by the plugin
    assets/                   locally downloaded images
  wiki/                       LLM-owned pages
    overview.md
    entities/  concepts/  sources/  comparisons/  syntheses/
  .wiki/                      plugin-private state, hidden from Obsidian and from git
    index.db                  SQLite FTS5 search cache, rebuildable, never authoritative
```

vault 是带 `[[wikilinks]]` 与 YAML frontmatter 的纯 Markdown，因此 Obsidian、任意编辑器与 git 都能原样操作它。`raw/` 对插件只读：真源永远不会被改写。

### 文件访问

因为 vault 位于会话工作区之外，模型自带的 `read`、`write`、`edit` 工具够不到它：在 `workspace-write` 下，`fs-sandbox` 后端只允许变更落在会话工作区或平台临时根目录之内。因此五个 `wiki_*` 工具是模型通往 vault 的唯一路径，而这也正是 frontmatter 校验与派生产物维护之所以能被强制执行、而非仅仅作为建议的原因。

插件自身的文件用 `node:fs/promises` 直接写入，遵循 `prism-memory` 的导出路数：沙箱围栏约束的是模型的变更，而不是可信的插件代码。每次写入都是原子的——先写入同目录的临时路径，再 rename——因此没有读者会看到半截页面。

### 页面 frontmatter

每个页面必填：`title`、`type`、`tags`、`updated`、`status`。可选：`sources`（本页引用的 raw 路径）、`aliases`、`confidence`、`contradicts`（本页所不同意的页面名）。

`type` 取 `overview`、`entity`、`concept`、`source`、`comparison`、`synthesis` 之一；`status` 取 `current`、`stub`、`superseded`、`disputed` 之一。`type` 决定目录，因此页面的路径与它的 frontmatter 不可能互相矛盾。

### 分工

模型负责读来源、做综合、写页面。插件只做机械且可校验的工作，并且从不调用模型。

`index.md` 与 `log.md` 是派生产物，不是模型的职责：插件从页面 frontmatter 重新生成目录，并在每次变更时追加一条日志。目录之所以不会与 wiki 漂移、日志之所以始终可解析，原因都在这里——两者都不依赖模型记得去更新它们。

### 面向模型的工具

五个工具，这个上限是刻意的，理由与 `prism-memory` 同样停在五个一样：工具 schema 位于被缓存的请求前缀中，每次请求都要付费。每个工具都在 `ctx.effect` 内通过 `ctx.tools.register` 注册，因此释放该 fiber 就会移除全部五个。

| 工具 | 约定 |
|---|---|
| `wiki_search` | 按字面查询返回排序后的页面，可按 `type`、`tags`、`status` 过滤；返回路径、标题、类型、更新日期与命中片段 |
| `wiki_read` | 完整返回一个页面，外加它的出链 wikilink、反向链接，以及它引用的 raw 来源 |
| `wiki_write` | 创建一个页面或更新一个页面：按 schema 校验 frontmatter、原子写入，然后刷新 `index.md`、追加 `log.md` 并更新检索索引 |
| `wiki_source` | raw 层：`list`（来源及其集成状态）、`read`（有界的来源文本）、`add`（把新来源登记进 `raw/`）、`integrate`（把来源标记为已集成，并记录它触及过的页面） |
| `wiki_lint` | 健康报告：孤儿页面、失效的 wikilink、被反复提及却没有独立页面的概念、尚未集成的来源、引用了不存在的 raw 文件的页面、frontmatter 违规，以及未解决的 `contradicts` 配对 |

### 操作员命令

`/wiki` 是人的操作面，且不消耗任何工具 schema：`status`、`lint`、`reindex`、`open <page>`、`log [n]`、`schema`。未知子命令返回一个指明用法的错误。

### schema 的投递

这个模式依赖 schema 处于上下文之中，但 vault 的 `AGENTS.md` 是共同演化的、因而会变——把它放进系统提示词会让每次编辑都重写被缓存的前缀。因此系统提示词中放的是一个静态协议段，承载机制性内容（布局、工具约定、frontmatter 字段、工作流），其字节由 Config 决定且稳定。

vault 自己的 `AGENTS.md` 则在每个会话中恰好追加一次：于该会话第一次调用 wiki 工具时，作为单条尾部消息，经一个先调用 `next()`、再把内容追加到返回决策上的 `agent/pre-step` 监听器投递。`/wiki schema` 操作员命令可以按需打印它。知识库无法提供 schema 时（没有 `AGENTS.md`，或没有配置根目录）只清账不发帧，不会让该步骤失败；其他读取失败仍会向上抛出。

### 种子 schema

播种在 `vault/AGENTS.md` 的模板只承载与领域相关的部分：这个 wiki 收哪些类别、什么内容值得拥有独立页面、页面文件如何命名、来源如何引用，以及综述的行文风格。它是这个模式中唯一预期由人和模型共同改写的部分，而插件在它存在之后不再重新生成。

### 检索

检索是在标题、正文与 frontmatter 上的 SQLite FTS5，在首次检索时惰性打开，从而让启动保持安静，也让不检索的会话完全不导入 `node:sqlite`。

分词器用 `trigram`，而不是 FTS5 的默认值。在本工具链上实测（Node v24.19.0、SQLite 3.53.3）：对中文文本做中文查询时 `unicode61` 返回零条命中，而 `trigram` 能命中。vault 预期会存放中文页面，因此默认分词器在这里不可用。

索引是缓存，永远不是真源。每次检索先按文件 mtime 做一次对账，因此在 Obsidian 或产品内所做的编辑无需文件系统 watcher 就能被看到；`/wiki reindex` 从文件重建；索引缺失或损坏时直接重建，而不是报错。

### 并发

有四个写入方会触碰 vault：模型的工具、Web 页面、外部编辑器，以及 git。插件的每次写入都是原子的。`wiki_write` 接受可选的 `expectedRevision`（内容哈希）；不匹配时返回携带当前页面的冲突结果并且不写入任何内容，这也是页面在加载页面后所发送的。

`index.md` 与 `log.md` 由插件拥有：索引声明 `generated: true` 并在每次变更时被重新生成而非合并，手工编辑它会在下一次变更时被覆盖。

`expectedRevision` 过期时会被拒绝，并返回一个携带已存储页面的冲突：模型在工具结果中读到它，Web 保存路由在失败信封中携带它，编辑器则把它显示在保留的草稿旁边。

### Web 页面

客户端新增一个 Knowledge 页面：作为带 key 的 `main` 条目，与一行 `sidebar.panellist` 配对，通过 `ctx.slots.inject` 注册——在向其他包的 slot 注册时这是必需的。vault 树、渲染器、搜索框、反向链接面板、编辑器与健康标签页都通过同一个 inject face 读取数据。

渲染复用 `MarkdownText`，配上由 `t` 构建并经 memo 化的 `MarkdownLabels`。页面自行渲染 `[[wikilinks]]`，因为 `MarkdownText` 没有 wiki 链接语法。保存这类瞬时结果使用应用级的 `Toast`，它挂在 `shell.overlay` 条目中，从而比页面活得更久。

浏览器通过注册在 `ctx.connection.fetch` 上的精确 Fetch 路由访问宿主，路径前缀为 `/api/prism-wiki`，请求体经过校验，信封为 `{ ok, value } | { ok, error }`：`list`、`read`、`search`、`save`、`source`、`lint`。这里不能用插件注册的 RPC channel：channel 服务自身的 context 并未注入 `webServer`，因此 `ctx.connection.rpc.handle()` 会在加载时抛错。

页面的编辑回路遵循知识库自己的约定，而不只是把它们显示出来：

- 被引用的原始来源经 `source` 路由就地打开，套用与模型 `wiki_source read` 相同的已配置字符上限，并报告截断。
- 点击解析不到页面的 wikilink 会为它要的名字打开草稿：标题取该目标，路径由链接所指的目录推导，无法识别的目录归入 `concepts/`。
- 只要路径仍是推导出来的，新草稿的路径就随标题与类型联动；读者自己填写的路径不会被覆盖。
- 知识库有 `overview.md` 时首次进入即打开它。
- 新草稿遇到库里已有的路径会被拒绝并指出该路径，因为它没有可比的修订号，否则就会静默替换那一页。`save` 路由自身执行这条规则，因此任何浏览器客户端都受它约束；无法解析的已存页面会被拒绝，而不是在未被看见的情况下被替换。
- 被拒的保存保留草稿、原位提示冲突，并把库中正文并排显示。
- 767px 以下目录列折叠到自己的开关后面，两栏布局变为一栏。

所有产品文案都通过注册在 `ctx.locale.register` 的类型化 locale 词典抵达呈现层。

### 插件的位置

源码位于 `packages/prism/prism-wiki`，是一个工作区包。Web 那一半无法在别处构建：`packages/client/tsdown.client.ts` 中的 `clientBundle()` 通过 glob `packages/*/*/package.json` 解析客户端包，对任何其他位置都会直接让构建失败；根 tsdown 工作区与根 vitest 的 include 都够不到 `plugins/*`；而 `verify-client-ui-i18n` 只发现 `packages/*/*/src/client` 下的源码。在 `plugins/` 下开发会同时失去受支持的客户端构建、该项复制门禁与根测试收集。

`plugins/prism-wiki` 是发布副本：`lib/`、`cordis.patch.yml`、`LICENSE` 与 README 三件套，不含源码，与 `plugins/prism-meeting` 一致。`apps/desktop/scripts/bundle-runtime.mjs` 在把 `plugins/*` 收进桌面运行时的时候，本来就会剥掉 `src`、`tests`、`scripts` 与 `*.ts`。

`packages/prism` 是一个新的包组，因此 `packages/README.md` 在同一次改动中加入它的行。

## [S3] Scope

- 范围内：`packages/prism` 包组行、`packages/prism/prism-wiki` 工作区包、vault 布局与 schema 模板、frontmatter 校验、五个工具、`/wiki` 命令、FTS5 索引、系统提示词段与 vault schema 尾部消息、宿主 Fetch 路由、Web 页面及其 locale 词典、单元测试与真实组合测试、包 README 三件套、`plugins/prism-wiki` 镜像，以及记录该插件归属与位置的 Agent Note。
- 范围外：不做图谱视图，因为 wiki 的形态由 Obsidian 的图谱视图呈现；不做 embedding、向量库或重排器，因为检索就是字面的 FTS5 排序，而该模式认为在这个规模上目录加一个普通检索已经足够；不做文件系统 watcher，因为外部编辑在每次检索时对账；不做自动摄取，也不做定时巡检，因为摄取与巡检由模型或操作员发起；不做幻灯片、图表或 canvas 等导出格式；不修改 `prism-memory`，不与之合并，也不依赖它。

## Tasks

- [x] T1: 注册 `packages/prism` 包组并搭建 `packages/prism/prism-wiki` 骨架 — acceptance: 该包能经 `pnpm run build` 构建，其 `exports` 覆盖 `.`、`./client`、`./web`、`./cordis.patch.yml` (covers: S2 插件的位置; depends: none)
- [x] T2: vault 核心——布局创建与接管守卫、frontmatter schema 与校验、原子读写、wikilink 与反向链接解析、修订哈希 — acceptance: 用例覆盖创建、拒绝接管、被拒绝的 frontmatter、原子写入与修订不匹配 (covers: S2 层次与布局, 页面 frontmatter, 文件访问; depends: T1)
- [x] T3: 派生产物——从 frontmatter 生成 `index.md`、追加 `log.md`、播种 `AGENTS.md` 模板 — acceptance: 一次 `wiki_write` 就让两个派生文件保持一致，且被编辑过的 schema 不会被重新生成 (covers: S2 分工, 种子 schema; depends: T2)
- [x] T4: 检索索引——使用 trigram 分词器的 FTS5、惰性打开、mtime 对账、重建路径 — acceptance: 中文查询能返回其页面，外部编辑在下一次检索时可见，`reindex` 能恢复被删除的索引 (covers: S2 检索; depends: T2)
- [x] T5: 面向模型的工具——`wiki_search`、`wiki_read`、`wiki_write`、`wiki_source`、`wiki_lint` — acceptance: 五个工具都在 `ctx.effect` 内通过 `ctx.tools.register` 注册，释放 fiber 后全部移除 (covers: S2 面向模型的工具; depends: T2, T3, T4)
- [x] T6: schema 投递——静态系统提示词段与每会话一次的 vault schema 尾部消息 — acceptance: 该段在两个请求之间字节完全相同，且 vault schema 每个会话恰好追加一次 (covers: S2 schema 的投递; depends: T2)
- [x] T7: 操作员命令 `/wiki` — acceptance: `status`、`lint`、`reindex`、`open`、`log`、`schema` 各自返回结果，未知子命令返回指明用法的错误 (covers: S2 操作员命令; depends: T5)
- [x] T8: 宿主 Fetch 路由 — acceptance: 格式错误的请求体返回 `{ ok: false, error }` 信封，携带过期 `expectedRevision` 的保存返回冲突码 (covers: S2 Web 页面, 并发; depends: T2, T4)
- [x] T9: Web 页面——vault 树、渲染器、wikilink 跳转、反向链接、检索、编辑器、健康标签页与 locale 词典 — acceptance: 页面通过 `ctx.slots.inject` 注册进 `main` 与 `sidebar.panellist`，且每个产品字符串都经类型化 `t` 席位解析 (covers: S2 Web 页面; depends: T8)
- [x] T10: 测试——vault 核心、frontmatter 校验、中文检索、巡检发现项、写入冲突、注册与释放、对生产服务的真实组合挂载，以及客户端页面 — acceptance: 测试套件通过，且真实组合用例驱动的是被挂载的服务 (covers: S2, S4; depends: T5, T9)
- [x] T11: 打包——构建配置、`cordis.patch.yml`、镜像到 `plugins/prism-wiki`，以及产物烟测 — acceptance: `node scripts/smoke.mjs` 针对产出的 `lib/` 通过，镜像中包含 `lib/`、`cordis.patch.yml`、`LICENSE` 与 README 三件套且不含源码 (covers: S2 插件的位置; depends: T5, T9)
- [x] T12: 文档——包 README 三件套（Summary、配置、工具约定、Model Experience、Known Limitations 与验证章节），以及记录该插件归属与位置的 Agent Note — acceptance: README 三件套通过配对门禁，Agent Note 通过 `verify-agent-note-format` (covers: S3; depends: T11)
- [x] T13: 按验收标准进行验证与独立评审 — acceptance: S4 中每一条标准都带有命令输出或 `file:line` 依据 (covers: S4; depends: T10, T11, T12)
- [x] T14: 关闭依赖闸门 — acceptance: 在 `defineTool` 与 `createUserMessage` 经审视归为 safe 导出、且 `CommandDefinitionId` 改用共享 brand 助手之后，`verify-package-dependencies` 以零退出 (covers: S2 模型侧工具、操作员命令; depends: T13)
- [x] T15: 让 schema 帧对知识库级失败不再致命 — acceptance: 缺少 `AGENTS.md` 与未配置 `vaultRoot` 都让步骤正常进入且不带帧，而意外的读取失败仍让步骤拒绝 (covers: S2 schema 投递; depends: T2)
- [x] T16: 向页面提供原始来源 — acceptance: `source` 路由返回被引用来源的文本与截断标记，缺失来源答 `prism-wiki/not-found`，畸形请求体被拒绝 (covers: S2 Web 页面; depends: T8)
- [x] T17: 闭合页面的编辑回路 — acceptance: 未解析的 wikilink 在推导出的路径上打开草稿；新页面路径随标题与类型推导直到读者自行填写；首次进入打开 `overview.md`；已存在的路径被拒绝而不是覆盖 (covers: S2 Web 页面; depends: T9)
- [x] T18: 被拒保存时并排显示库中页面，并在窄视口折叠目录 — acceptance: 冲突时把库中正文渲染在保留草稿旁，目录开关报告其展开状态 (covers: S2 Web 页面; depends: T9)
- [x] T19: 刷新随包文档 — acceptance: README 三件套引用随包协议文本、列出六条路由与页面的编辑回路、写明覆盖本包的套件，并重新记录配对使镜像 sidecar 保持最新 (covers: S3; depends: T16, T17, T18)
- [x] T20: 把包作用域改名为 `@prism` — acceptance: 包、镜像、文档、tsconfig 别名与生成的客户端目录中都不再残留 `@prism-ai/prism-wiki`；构建产出的 bundle 以 `@prism/prism-wiki` 注册；lockfile 保持一致 (covers: S2 插件的位置; depends: T19)
- [x] T21: 证明 shipped rows 能被一同调用 — acceptance: 真实 Loader 组合把四个 row 连同浏览器行架在真实 Connection 上启动，六条路由全部应答；工具写入的页面能被浏览器路由读到，浏览器保存也能被模型侧工具读到 (covers: S2 Web 页面; depends: T20)

## [S4] Acceptance

- [x] 在 `vaultRoot` 创建出文档所述布局的 vault，且插件拒绝接管一个无关的非空目录。
- [x] `wiki_write` 能创建与更新页面、拒绝违反 schema 的 frontmatter，并在不需要第二次调用的情况下让 `index.md` 与 `log.md` 保持一致。
- [x] 中文查询能检索到包含它的页面；对磁盘页面做外部编辑后再检索，能返回编辑后的文本。
- [x] `wiki_lint` 能报告预置的孤儿页面、失效 wikilink、未集成来源与未解决的 `contradicts` 配对。
- [x] `wiki_write` 在 `expectedRevision` 过期时返回携带当前页面的冲突，并且不写入任何内容。
- [x] 五个工具能干净地注册与释放，且系统提示词段的字节在请求之间不变。
- [x] vault schema 在每个会话中恰好追加一次，且位于请求尾部。
- [x] Web 页面能列出 vault、渲染页面、跟随 wikilink、显示反向链接、执行检索，并保存一处随后在磁盘上可见的编辑。
- [x] Web 页面中没有任何产品字符串绕过类型化 locale 词典。
- [x] `plugins/prism-wiki` 是已构建包的镜像：`lib/`、`cordis.patch.yml`、`LICENSE` 与 README 三件套，且不含源码。
- [x] README 三件套被记录为一致的配对，且 Agent Note 通过其格式与分类门禁。
- [x] 该包通过类型检查，其测试套件通过，且覆盖 `packages/prism/prism-wiki` 与本文件的仓库门禁通过。
- [x] 知识库无法提供 schema 帧时只清账而不致命，意外的 schema 读取失败仍会让步骤失败。
- [x] 被引用的原始来源在页面内以模型工具相同的字符上限打开，缺失来源答 `prism-wiki/not-found`。
- [x] 跟随未解析的 wikilink 会打开带目标标题与推导路径的草稿；新草稿路径随标题与类型推导直到读者自行填写。
- [x] 新草稿遇到库里已有的路径会被拒绝，页面不会调用保存路由，且该路由本身也拒绝在已存在页面上做无修订号的写入。
- [x] 被拒的保存把库中正文渲染在保留草稿旁，目录开关报告其展开状态。
- [ ] 该包对它所发布的每个源文件都满足仓库的逐文件覆盖率闸门（`test:coverage`）。
- [x] 包名为 `@prism/prism-wiki`，源码、镜像、文档、路径别名与生成的 slot 目录中都不再残留旧作用域。
- [x] 四个 shipped row 经真实 Loader 组合，六条浏览器路由在真实 Connection 上全部应答，工具与路由读写同一个 vault。
