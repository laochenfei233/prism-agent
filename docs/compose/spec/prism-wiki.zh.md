---
feature: prism-wiki
status: designed
updated: 2026-10-07
branch: feat/prism-wiki
commits: uncommitted working tree
---

# Prism Wiki（LLM 维护的知识库插件）

[English](prism-wiki.md) | 中文

## Report

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
| `wiki_read` | 完整返回一个页面，外加它的出链 wikilink、反向链接，以及它引用的 raw 来源；也可用于读取 `AGENTS.md` |
| `wiki_write` | 创建一个页面或更新一个页面：按 schema 校验 frontmatter、原子写入，然后刷新 `index.md`、追加 `log.md` 并更新检索索引 |
| `wiki_source` | raw 层：`list`（来源及其集成状态）、`read`（有界的来源文本）、`add`（把新来源登记进 `raw/`）、`integrate`（把来源标记为已集成，并记录它触及过的页面） |
| `wiki_lint` | 健康报告：孤儿页面、失效的 wikilink、被反复提及却没有独立页面的概念、尚未集成的来源、引用了不存在的 raw 文件的页面、frontmatter 违规，以及未解决的 `contradicts` 配对 |

### 操作员命令

`/wiki` 是人的操作面，且不消耗任何工具 schema：`status`、`lint`、`reindex`、`open <page>`、`log [n]`、`schema`。未知子命令返回一个指明用法的错误。

### schema 的投递

这个模式依赖 schema 处于上下文之中，但 vault 的 `AGENTS.md` 是共同演化的、因而会变——把它放进系统提示词会让每次编辑都重写被缓存的前缀。因此系统提示词中放的是一个静态协议段，承载机制性内容（布局、工具约定、frontmatter 字段、工作流），其字节由 Config 决定且稳定。

vault 自己的 `AGENTS.md` 则在每个会话中恰好追加一次：于该会话第一次调用 wiki 工具时，作为单条尾部消息，经一个先调用 `next()`、再把内容追加到返回决策上的 `agent/pre-step` 监听器投递；并且随时可以通过 `wiki_read` 读取。

### 种子 schema

播种在 `vault/AGENTS.md` 的模板只承载与领域相关的部分：这个 wiki 收哪些类别、什么内容值得拥有独立页面、页面文件如何命名、来源如何引用，以及综述的行文风格。它是这个模式中唯一预期由人和模型共同改写的部分，而插件在它存在之后不再重新生成。

### 检索

检索是在标题、正文与 frontmatter 上的 SQLite FTS5，在首次检索时惰性打开，从而让启动保持安静，也让不检索的会话完全不导入 `node:sqlite`。

分词器用 `trigram`，而不是 FTS5 的默认值。在本工具链上实测（Node v24.19.0、SQLite 3.53.3）：对中文文本做中文查询时 `unicode61` 返回零条命中，而 `trigram` 能命中。vault 预期会存放中文页面，因此默认分词器在这里不可用。

索引是缓存，永远不是真源。每次检索先按文件 mtime 做一次对账，因此在 Obsidian 或产品内所做的编辑无需文件系统 watcher 就能被看到；`/wiki reindex` 从文件重建；索引缺失或损坏时直接重建，而不是报错。

### 并发

有四个写入方会触碰 vault：模型的工具、Web 页面、外部编辑器，以及 git。插件的每次写入都是原子的。`wiki_write` 接受可选的 `expectedRevision`（内容哈希）；不匹配时返回携带当前页面的冲突结果并且不写入任何内容，这也是页面在加载页面后所发送的。

`index.md` 与 `log.md` 由插件拥有：索引声明 `generated: true` 并在每次变更时被重新生成而非合并，手工编辑它会在下一次变更时被覆盖。

### Web 页面

客户端新增一个 Knowledge 页面：作为带 key 的 `main` 条目，与一行 `sidebar.panellist` 配对，通过 `ctx.slots.inject` 注册——在向其他包的 slot 注册时这是必需的。vault 树、渲染器、搜索框、反向链接面板、编辑器与健康标签页都通过同一个 inject face 读取数据。

渲染复用 `MarkdownText`，配上由 `t` 构建并经 memo 化的 `MarkdownLabels`。页面自行渲染 `[[wikilinks]]`，因为 `MarkdownText` 没有 wiki 链接语法。保存这类瞬时结果使用应用级的 `Toast`，它挂在 `shell.overlay` 条目中，从而比页面活得更久。

浏览器通过注册在 `ctx.connection.fetch` 上的精确 Fetch 路由访问宿主，路径前缀为 `/api/prism-wiki`，请求体经过校验，信封为 `{ ok, value } | { ok, error }`。这里不能用插件注册的 RPC channel：channel 服务自身的 context 并未注入 `webServer`，因此 `ctx.connection.rpc.handle()` 会在加载时抛错。

所有产品文案都通过注册在 `ctx.locale.register` 的类型化 locale 词典抵达呈现层。

### 插件的位置

源码位于 `packages/prism/prism-wiki`，是一个工作区包。Web 那一半无法在别处构建：`packages/client/tsdown.client.ts` 中的 `clientBundle()` 通过 glob `packages/*/*/package.json` 解析客户端包，对任何其他位置都会直接让构建失败；根 tsdown 工作区与根 vitest 的 include 都够不到 `plugins/*`；而 `verify-client-ui-i18n` 只发现 `packages/*/*/src/client` 下的源码。在 `plugins/` 下开发会同时失去受支持的客户端构建、该项复制门禁与根测试收集。

`plugins/prism-wiki` 是发布副本：`lib/`、`cordis.patch.yml`、`LICENSE` 与 README 三件套，不含源码，与 `plugins/prism-meeting` 一致。`apps/desktop/scripts/bundle-runtime.mjs` 在把 `plugins/*` 收进桌面运行时的时候，本来就会剥掉 `src`、`tests`、`scripts` 与 `*.ts`。

`packages/prism` 是一个新的包组，因此 `packages/README.md` 在同一次改动中加入它的行。

## [S3] Scope

- 范围内：`packages/prism` 包组行、`packages/prism/prism-wiki` 工作区包、vault 布局与 schema 模板、frontmatter 校验、五个工具、`/wiki` 命令、FTS5 索引、系统提示词段与 vault schema 尾部消息、宿主 Fetch 路由、Web 页面及其 locale 词典、单元测试与真实组合测试、包 README 三件套、`plugins/prism-wiki` 镜像，以及记录该插件归属与位置的 Agent Note。
- 范围外：不做图谱视图，因为 wiki 的形态由 Obsidian 的图谱视图呈现；不做 embedding、向量库或重排器，因为检索就是字面的 FTS5 排序，而该模式认为在这个规模上目录加一个普通检索已经足够；不做文件系统 watcher，因为外部编辑在每次检索时对账；不做自动摄取，也不做定时巡检，因为摄取与巡检由模型或操作员发起；不做幻灯片、图表或 canvas 等导出格式；不修改 `prism-memory`，不与之合并，也不依赖它。

## Tasks

- [ ] T1: 注册 `packages/prism` 包组并搭建 `packages/prism/prism-wiki` 骨架 — acceptance: 该包能经 `pnpm run build` 构建，其 `exports` 覆盖 `.`、`./client`、`./web`、`./cordis.patch.yml` (covers: S2 插件的位置; depends: none)
- [ ] T2: vault 核心——布局创建与接管守卫、frontmatter schema 与校验、原子读写、wikilink 与反向链接解析、修订哈希 — acceptance: 用例覆盖创建、拒绝接管、被拒绝的 frontmatter、原子写入与修订不匹配 (covers: S2 层次与布局, 页面 frontmatter, 文件访问; depends: T1)
- [ ] T3: 派生产物——从 frontmatter 生成 `index.md`、追加 `log.md`、播种 `AGENTS.md` 模板 — acceptance: 一次 `wiki_write` 就让两个派生文件保持一致，且被编辑过的 schema 不会被重新生成 (covers: S2 分工, 种子 schema; depends: T2)
- [ ] T4: 检索索引——使用 trigram 分词器的 FTS5、惰性打开、mtime 对账、重建路径 — acceptance: 中文查询能返回其页面，外部编辑在下一次检索时可见，`reindex` 能恢复被删除的索引 (covers: S2 检索; depends: T2)
- [ ] T5: 面向模型的工具——`wiki_search`、`wiki_read`、`wiki_write`、`wiki_source`、`wiki_lint` — acceptance: 五个工具都在 `ctx.effect` 内通过 `ctx.tools.register` 注册，释放 fiber 后全部移除 (covers: S2 面向模型的工具; depends: T2, T3, T4)
- [ ] T6: schema 投递——静态系统提示词段与每会话一次的 vault schema 尾部消息 — acceptance: 该段在两个请求之间字节完全相同，且 vault schema 每个会话恰好追加一次 (covers: S2 schema 的投递; depends: T2)
- [ ] T7: 操作员命令 `/wiki` — acceptance: `status`、`lint`、`reindex`、`open`、`log`、`schema` 各自返回结果，未知子命令返回指明用法的错误 (covers: S2 操作员命令; depends: T5)
- [ ] T8: 宿主 Fetch 路由 — acceptance: 格式错误的请求体返回 `{ ok: false, error }` 信封，携带过期 `expectedRevision` 的保存返回冲突码 (covers: S2 Web 页面, 并发; depends: T2, T4)
- [ ] T9: Web 页面——vault 树、渲染器、wikilink 跳转、反向链接、检索、编辑器、健康标签页与 locale 词典 — acceptance: 页面通过 `ctx.slots.inject` 注册进 `main` 与 `sidebar.panellist`，且每个产品字符串都经类型化 `t` 席位解析 (covers: S2 Web 页面; depends: T8)
- [ ] T10: 测试——vault 核心、frontmatter 校验、中文检索、巡检发现项、写入冲突、注册与释放、对生产服务的真实组合挂载，以及客户端页面 — acceptance: 测试套件通过，且真实组合用例驱动的是被挂载的服务 (covers: S2, S4; depends: T5, T9)
- [ ] T11: 打包——构建配置、`cordis.patch.yml`、镜像到 `plugins/prism-wiki`，以及产物烟测 — acceptance: `node scripts/smoke.mjs` 针对产出的 `lib/` 通过，镜像中包含 `lib/`、`cordis.patch.yml`、`LICENSE` 与 README 三件套且不含源码 (covers: S2 插件的位置; depends: T5, T9)
- [ ] T12: 文档——包 README 三件套（Summary、配置、工具约定、Model Experience、Known Limitations 与验证章节），以及记录该插件归属与位置的 Agent Note — acceptance: README 三件套通过配对门禁，Agent Note 通过 `verify-agent-note-format` (covers: S3; depends: T11)
- [ ] T13: 按验收标准进行验证与独立评审 — acceptance: S4 中每一条标准都带有命令输出或 `file:line` 依据 (covers: S4; depends: T10, T11, T12)

## [S4] Acceptance

- [ ] 在 `vaultRoot` 创建出文档所述布局的 vault，且插件拒绝接管一个无关的非空目录。
- [ ] `wiki_write` 能创建与更新页面、拒绝违反 schema 的 frontmatter，并在不需要第二次调用的情况下让 `index.md` 与 `log.md` 保持一致。
- [ ] 中文查询能检索到包含它的页面；对磁盘页面做外部编辑后再检索，能返回编辑后的文本。
- [ ] `wiki_lint` 能报告预置的孤儿页面、失效 wikilink、未集成来源与未解决的 `contradicts` 配对。
- [ ] `wiki_write` 在 `expectedRevision` 过期时返回携带当前页面的冲突，并且不写入任何内容。
- [ ] 五个工具能干净地注册与释放，且系统提示词段的字节在请求之间不变。
- [ ] vault schema 在每个会话中恰好追加一次，且位于请求尾部。
- [ ] Web 页面能列出 vault、渲染页面、跟随 wikilink、显示反向链接、执行检索，并保存一处随后在磁盘上可见的编辑。
- [ ] Web 页面中没有任何产品字符串绕过类型化 locale 词典。
- [ ] `plugins/prism-wiki` 是已构建包的镜像：`lib/`、`cordis.patch.yml`、`LICENSE` 与 README 三件套，且不含源码。
- [ ] README 三件套被记录为一致的配对，且 Agent Note 通过其格式与分类门禁。
- [ ] 该包通过类型检查，其测试套件通过，且覆盖 `packages/prism/prism-wiki` 与本文件的仓库门禁通过。
