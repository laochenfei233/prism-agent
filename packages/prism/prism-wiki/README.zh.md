---
description: "Prism 知识库 bundle：由模型维护、相互链接的 Markdown 页面集合，带可重建的 SQLite 全文缓存、五个面向模型的 wiki 工具、/wiki 运维命令和 Web 知识库页面，供用户在 dsh profile 中加入持久知识库。"
kind: "package-bundle"
---

# @prism/prism-wiki

[English](README.md) | 中文

## 概述

这个 bundle 为 `dsh` profile 加入一个持久化的 Markdown 知识库。模型读入原始来源、撰写相互链接的页面，并在之后据此作答；本包只做机械工作：知识库目录、生成的目录页和日志、可重建的 SQLite 全文缓存、五个 wiki 工具、`/wiki` 运维命令，以及 Web 知识库页面。知识库就是一个纯文件目录，Obsidian 可以直接打开，因此 profile 学到的东西比写入它的会话活得更久。目前没有随包发布的 profile 包含这一层；profile 通过安装本包并重启来获得它。

## 目录

- [知识库布局](#vault-layout)
- [配置](#configuration)
- [面向模型的工具](#model-facing-tools)
- [`/wiki` 命令](#the-wiki-command)
- [检索](#retrieval)
- [Web 知识库页面](#web-knowledge-page)
- [验证](#verification)
- [安装](#installation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="vault-layout"></a>
## 知识库布局

知识库分三层，每层只有一个归属方。`raw/` 存放不可变的来源：插件只登记一次，之后拒绝覆盖。`wiki/` 存放页面，由模型通过 `wiki_write` 撰写。`AGENTS.md` 存放这个知识库自己的约定，从随包模板播种一次后不再重新生成，因此从此由人和模型共同拥有。

```text
<vaultRoot>/
  AGENTS.md       the vault's own schema, seeded once and never regenerated
  index.md        the generated catalog, grouped by page kind
  log.md          one dated heading per page write
  raw/            immutable sources, cited by path relative to this directory
    assets/       attachments; excluded from the source listing
  wiki/           the pages the model owns
    overview.md   the single front door
    entities/     one page per durable thing: a person, project, product, organization, or tool
    concepts/     one page per idea, method, or term
    sources/      one page per ingested raw source
    comparisons/  one page per decision between alternatives
    syntheses/    one page per conclusion drawn across several pages
  .wiki/          the SQLite full-text cache, hidden from Obsidian and from git
```

`ensureLayout()` 在首次使用时创建这棵树。已经含有 `AGENTS.md` 的目录会被接管；不含该文件的非空目录会以 `WIKI_ROOT_NOT_VAULT` 拒绝，而不是被填入内容。`index.md` 和 `log.md` 是派生文件：每次写入后目录页都按页面前置数据重写，日志每次写入追加一个标题，因此两者都不手工编辑。

-----

<a id="configuration"></a>
## 配置

服务从 [`src/service.ts`](src/service.ts) 读取配置，随包的 [`cordis.patch.yml`](cordis.patch.yml) 给出知识库根目录和三个上限。所有字段都是 volatile 的，因此后续 patch 层或运行中的配置界面都能修改它。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `vaultRoot` | 无；必填 | 知识库的绝对目录。为空或未设置时所有操作都以 `PRISM_WIKI_NO_VAULT_ROOT` 失败；随包 patch 将其设为 `!!js dshHomePath('knowledge')`。 |
| `protocolSection` | `DEFAULT_PROTOCOL` | 描述知识库机制的静态系统提示文本；随包文本在「模型体验」一节原文引用。 |
| `schemaDeliveryEnabled` | `true` | wiki 工具调用是否可以把该会话标记为欠一次知识库 schema 帧。 |
| `maxSearchResults` | `6` | `wiki_search` 命中数的硬上限，在模型自己给出的 `limit` 之上再收一次。 |
| `maxSourceChars` | `40000` | 单次来源读取和单个登记来源的字符上限；更长的 `add` 以 `PRISM_WIKI_TOO_LARGE` 拒绝。 |
| `maxPageChars` | `200000` | 单次页面正文写入的字符上限；更长的正文以 `PRISM_WIKI_TOO_LARGE` 拒绝。 |

-----

<a id="model-facing-tools"></a>
## 面向模型的工具

`./tools` 行注册五个定义。每次调用都会把该会话标记为欠一次知识库 schema 帧；每次拒绝都以结果返回，携带 `ok: false`、稳定的 `code` 和模型可以据此行动的消息，而不是未处理的工具错误。

| 工具 | 输入 | 返回内容 |
|---|---|---|
| `wiki_search` | `query`（必填）、`type`、`tags`、`status`、`limit` | 排好序的命中（路径、标题、类型、状态、更新日期，以及首个匹配词周围的摘录），`bm25()` 最优者在前，数量不超过 `maxSearchResults`。 |
| `wiki_read` | `path`（必填） | 一整页：它的前置数据字段、正文、出链、反向链接，以及它引用的原始来源。 |
| `wiki_write` | `path`、`title`、`type`、`body`（必填）；`status`、`tags`、`sources`、`aliases`、`contradicts`、`confidence`、`expectedRevision` | 存储路径、新的 SHA-256 修订号，以及本次写入是否新建了页面。过期的 `expectedRevision` 以 `WIKI_REVISION_CONFLICT` 拒绝。 |
| `wiki_source` | `action`（必填：`list`、`read`、`add` 或 `integrate`）；`path`、`text`、`maxChars` | 按 action 分别为：每个来源及其引用页面，单个来源的有界文本及是否被截断，登记后的路径，或引用某个来源的页面。 |
| `wiki_lint` | 无 | 检查过的页面数和来源数，以及每条发现及其种类、页面（知识库级发现为 null）和说明。 |

五个定义是刻意的上限：工具 schema 位于被缓存的请求前缀中，冷启动和每次切换 profile 都要为它付费。

-----

<a id="the-wiki-command"></a>
## `/wiki` 命令

`./commands` 注册 `/wiki`，即知识库维护的人类侧入口。它不占用任何工具 schema，因此不会改变被缓存的前缀，模型也无法调用它。

| 子命令 | 报告内容 |
|---|---|
| `/wiki` 或 `/wiki status` | 知识库根目录、页面数、来源数及其未被任何页面引用的数量，以及最新的日志标题。 |
| `/wiki lint` | 与 `wiki_lint` 相同的发现，以文本呈现。 |
| `/wiki reindex` | 丢弃搜索缓存并从页面文件重建。 |
| `/wiki open <page>` | 一页及其链接、反向链接和引用的来源。 |
| `/wiki log [n]` | 最新 `n` 条日志标题，最新在前；`n` 缺失或不可用时为 10 条。 |
| `/wiki schema` | 知识库自己的 `AGENTS.md` 文本。 |

未知子命令以错误结果返回用法文本。

-----

<a id="retrieval"></a>
## 检索

检索是字面匹配，不是语义匹配。`wiki_search` 把查询转义成 FTS5 短语、用 `AND` 连接，并用 `bm25()` 排序，因此每个词都必须出现在页面中，查询里的 FTS5 运算符会被当作要搜索的文本而不是被应用。长度不足三个字符的查询什么都匹配不到；`type`、`tags`、`status` 在同一查询上收窄：`type` 和 `status` 精确匹配，每个请求的标签都必须作为完整词出现。

缓存是派生的，永远不是事实来源。行由页面文件重新生成，`reconcile()` 只重读文件 mtime 变化的行并删除页面已消失的行，`rebuild()` 则整体丢弃并重新填充。索引位于 `<vaultRoot>/.wiki/index.db`，以仅属主可读写的权限创建，并带有自己的 SQLite `application_id` 和派生的 schema 版本：属于其他应用的文件会被拒绝而不是被覆盖，旧派生 schema 版本写成的缓存会就地重置。不可用的数据库会被丢弃并重新打开一次；若仍不可用，搜索返回零命中，而不是让工具调用失败。

分词器是 `trigram`（`tokenize = 'trigram'`），它为每个三字符序列建索引，也是 FTS5 内置分词器中唯一能匹配中文文本的一个；默认的 `unicode61` 会把整段 CJK 文本当作一个词，对子串查询返回零命中。`title`、`body`、`tags`、`type`、`status`、`updated` 建索引，`path` 和 `mtime_ms` 不带索引地保留，用于行查找和协调。一条命中最多携带首个匹配词周围 200 个码点的正文，每个截断边缘带省略号；更短的正文整段返回。

-----

<a id="web-knowledge-page"></a>
## Web 知识库页面

`./web` 和 `./client` 把知识库入口加入侧边栏面板栏、它打开的 `wiki-vault` 主面板，以及承载页面临时通知的整帧宿主。页面通过本插件在 `/api/prism-wiki` 下自己的 `POST` 路由读写模型工具所用的同一个知识库：`list`、`read`、`search`、`save`、`source`、`lint`。每个应答都是同一个信封——`{ ok: true, value }` 或 HTTP 400 的 `{ ok: false, error: { code, message } }`——页面据 `prism-wiki/revision-conflict` 和 `prism-wiki/not-found` 分支。

页面有三个标签页。**页面**按类型分组显示知识库树并带类型和状态筛选，把选中的页面渲染为带可点击 wikilink 的 Markdown，列出它的反向链接，可就地打开它引用的任意原始来源，并编辑它的前置数据和正文。保存会回传它加载时的修订号；冲突时草稿保留、原位提示冲突，并把库中正文并排显示以便比对；不带修订号的保存一旦遇到库里已有的路径就会被拒绝，因此草稿只能新建页面，而不会替换它从未读过的页面。点击解析不到页面的 wikilink 会为它打开一份草稿。新页面的路径随标题和类型推导，直到读者自己填写；知识库有 `overview.md` 时首次进入即打开它；窄视口下目录折叠到自己的开关后面。**搜索**按字面排序命中，默认 20 条。**健康**运行检查并以其本地化种类标签列出每条发现。

该行注入 `wikiVault`、`connection` 和 `webServer`，因此只组合了 Connection 而没有 web server 的 profile 会让这一行保持 pending 而不是失败。

-----

<a id="verification"></a>
## 验证

以下是覆盖本包的仓库命令。

```sh
pnpm run test
pnpm run typecheck
pnpm run test:docs
pnpm run verify-translation-pairing packages/prism/prism-wiki/README.md
```

- `pnpm run test` 运行单元测试套件：针对真实临时知识库目录的 `tests/vault.spec.ts`、针对真实 FTS5 数据库文件的 `tests/search.spec.ts`、经真实注册表的 `tests/tools.spec.ts` 与 `tests/commands.spec.ts`、经真实 Connection Fetch 注册表的 `tests/web.spec.ts`、覆盖浏览器客户端的 `tests/client-api.client.spec.ts`、在 jsdom 中覆盖页面的 `tests/client-page.client.spec.tsx`，以及经 vendored Loader 启动随包行的 `tests/composition.host.spec.ts`。
- `pnpm run typecheck` 以当前检出编译 host 和 client 程序。
- `pnpm run test:docs` 运行文档闸门：配对、换行、链接、字数预算和包 README 检查。
- `pnpm run verify-translation-pairing packages/prism/prism-wiki/README.md` 只检查这一对 README。

本包尚未满足仓库的逐文件覆盖率闸门：`test:coverage` 仍报告未覆盖分支，其中最多的是 `src/client/WikiPage.tsx`、`src/vault.ts` 和 `src/search.ts`。

-----

<a id="installation"></a>
## 安装

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin` 会把它作为 profile 层来协调，而不是挂载单个插件。把 tarball 安装到 profile，然后重启该 profile。

```sh
dsh plugin --profile <profile> add /absolute/path/to/prism-prism-wiki-0.1.0.tgz
dsh --profile <profile>
dsh plugin --profile <profile> remove @prism/prism-wiki
```

patch 插入四行，每一行的行为都由其包拥有。

- `prism-wiki` 注册 `ctx.wikiVault`，带知识库根目录和三个上限。
- `tool-prism-wiki` 注册五个面向模型的工具。
- `command-prism-wiki` 注册 `/wiki`。
- `web-prism-wiki` 注册浏览器路由和知识库页面。

该 profile 需要这些行注入的服务：知识库行需要 `systemPrompt`，工具行需要 `tools`，命令行需要 `commands`，Web 行需要 `connection` 和 `webServer`。没有 Web Connection 的 profile 会让 Web 行保持 pending 而不是失败，因此无头 profile 拥有服务、工具和命令而没有页面。客户端模块在启动时扫描，因此页面在 profile 重启后出现。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型看到的内容

一个名为 `prism-wiki` 的固定段落，提示顺序 2550，位于工具指引带内，在目标段落与工作流段落之间。它的文本来自 `protocolSection`，每次组装请求时从配置读取。

##### 随包协议文本

```markdown
A wiki vault is a persistent, interlinked body of markdown pages that is compiled once and kept current, instead of being re-derived per question. Three layers: `raw/` holds immutable sources; `wiki/` holds the pages you own; `AGENTS.md` holds this vault's conventions. This vault's conventions are handed to you the first time you touch the vault in a session; follow them for every page you write. Ingest: read a source with `wiki_source`, then write or revise every page it changes with `wiki_write`. One source commonly touches several pages. Query: find pages with `wiki_search`, read them with `wiki_read`, and answer from them. A good answer is worth filing back as a page. Lint: run `wiki_lint` periodically and act on what it reports.
```

#### Token 影响

插件加载期间每个请求都有一段短文；知识库自己的 schema 文本不在其中。

#### KV 缓存影响

在 `protocolSection` 及其之前排序的段落不变时保持前缀稳定；改动其中任何一个都会从该点起使其后的复用失效。

### 知识库约定帧

#### 模型看到的内容

任何 `wiki_*` 工具调用之后，该会话的下一步会多带一条 user 消息：它以 `<prism-wiki-schema>` 开头，携带知识库的 `AGENTS.md` 文本，并以 "These are this vault's conventions. Follow them for every page you write." 结尾。帧送达后这笔欠账即被清除，`schemaDeliveryEnabled: false` 会完全抑制这一帧。知识库无法提供 schema 时（没有 `AGENTS.md`，或没有配置根目录）只清除欠账而不发帧，不会让该步骤失败；其他读取失败仍会向上抛出。

#### Token 影响

有条件的：不跟在 wiki 工具调用之后的步骤没有这一帧；携带它的步骤上，其大小由知识库 `AGENTS.md` 的大小决定。

#### KV 缓存影响

在尾部追加：这一帧是既有历史之后的一条新消息，因此更早的前缀仍然可复用。

### 面向模型的工具

#### 模型看到的内容

五个工具定义，`wiki_search`、`wiki_read`、`wiki_write`、`wiki_source` 和 `wiki_lint`，带上面表格描述的参数和输出 schema。

#### Token 影响

工具行挂载时每个请求都有五个固定定义；`/wiki` 命令不增加任何定义。

#### KV 缓存影响

在工具可见性和定义不变时保持前缀稳定；挂载或卸载工具行会重写工具块，并从该点起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是这一层的当前约束，不是泛泛的比较。

- **检索是字面匹配，不是语义匹配** —— `trigram` 匹配三字符子串，因此与页面没有任何三字符公共片段的改写会被漏掉；没有向量嵌入也没有重排器，每个查询至少需要三个字符。
- **命中是摘录，不是页面** —— `wiki_search` 每条命中最多返回 200 个码点的正文，因此模型要引用或改写内容时必须调用 `wiki_read`。
- **知识库写在会话工作区之外** —— 插件直接使用 `node:fs/promises`，随包根目录是 `dshHomePath('knowledge')`，因此模型自己的文件工具既到不了也不受限于知识库；wiki 工具才是它的写入路径。
- **冲突保护只有一次修订检查** —— 写入是原子的，同一知识库实例上的变更操作会串行化，但没有任何机制仲裁两个 harness 进程操作同一个知识库，`expectedRevision` 是防止丢失更新的唯一手段。
- **不能删除页面或来源** —— 工具和知识库页面都不删除、移动或重命名页面，因此 schema 对重命名的答案是给新页面加别名；原始来源只能新增。
- **`wiki_source add` 拒绝已存在的路径** —— 已登记的来源不可变（`WIKI_REVISION_CONFLICT`），要修订原始来源就得用新路径重新登记。
- **检查报告只看页面和原始来源** —— 只被生成的 `index.md` 引到的页面仍算孤立页面；少于三个页面请求的名字只会报为 `broken-link`，永远不会报为 `missing-page`。
- **知识库 schema 只播种一次，永不重新生成** —— 只有在 `AGENTS.md` 不存在时才写入随包模板，因此模板后续的改进不会到达已有的知识库。
- **`updated` 由写入方盖章** —— `wiki_write` 存当前 UTC 日期，前置数据解析器只校验它的 `YYYY-MM-DD` 形式，因此页面的日期记录的是写入而不是内容。
- **浏览器两半没有端到端验证** —— 组件 spec 只在 jsdom 中渲染页面，因此本仓库没有任何东西把组装后的 Web 页面与宿主路由一起启动。
- 本包不发布运行时不变量配套，因为它不拥有任何观测可能相互偏离的关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

Prism 拥有此包；服务保留 DSH 的 `ctx.wikiVault` 键。bundle 载体是一个包，它同时发布自己插入的服务、工具、命令和浏览器行，因此本 README 遵循 bundle 模板，而「模型体验」一节保持结构化形式：系统提示、schema 帧和工具定义正是本包自己的贡献。

</details>
