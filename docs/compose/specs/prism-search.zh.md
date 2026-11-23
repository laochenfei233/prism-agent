---
feature: prism-search
status: delivered
updated: 2026-11-01
branch: feat/prism-search
commits: dd1145a3c5..cc6a6a6d02
---

# Prism 搜索

[English](prism-search.md) | 中文

## Report

**做了什么** —— `plugins/prism-search`（`@prism/prism-search`）：Host 半注册一个无需密钥的 `ctx.web` 搜索提供方 `prism-search`，并行查询 18 个免费引擎，以归一化 URL 上的倒数排名融合（RRF）合并它们的排名，经 `ctx.web.fetch` 读取靠前页面，并用一次辅助 `ctx.llm.stream()` 调用、以在「模型」中选定的模型为结果排序；浏览器半新增 设置 → 搜索，把 `web.searchProvider` 切到该提供方，并从实时模型 catalog 保存排序路由。自带的 `web_search` 工具及其卡片、限制与超时策略原样复用。

**验证** —— `tsc -p tsconfig.json --noEmit` 退出码 0；`vitest run --config vitest.config.ts` 9 个文件 / 68 个测试通过（引擎解析器、HTML/URL 助手、RRF 融合、重排解析、提供方流水线、设置桥、config schema、包装层解析、真实 Cordis 组合）；`tsdown --config tsdown.config.ts` 构建通过，`lib/index.js` 只外置 `@deepseek-ai/schemastery`，`lib/client.js` 只请求 `react`/`react/jsx-runtime`；在构建产物上运行 `node scripts/smoke.mjs` 打印 `{"registered":"prism-search","sources":1,"first":"https://example.org/article"}`；`verify-translation-pairing plugins/prism-search/README.md` 一致。

**过程记录** ——

- 首轮评审查出 Host 用 `Reflect.get(ctx, 'llm')` 读 LLM 服务却只注入 `web`，导致每次排序搜索都抛错而不是保持融合顺序。读取改为 `ctx.get('llm')`，并由一个真实 Cordis 组合测试覆盖排序与不排序搜索及销毁。
- 设置卡片只注入了 `remote`；`remote.settings` 与 `remote.session` 是各自独立的 inject 门控服务，设置节因此什么都读不到。现在两者都注入，列表由测试断言。
- 网页抓取最初用从引擎 HTML 里取到的 URL 打开插件自己的连接，绕过了部署的 fetch 策略。现在改为经 `ctx.web.fetch` 读取页面；它的跨源重定向规则随后弄坏了百度/搜狗/360 的包装层，解决办法是向引擎自己的重定向端点探测（不跟随重定向），再经同一 seam 读取目的地。
- 独立的 `page.ts` 读取器与无用的引擎显示标签被删除，而不是留在新路径旁边。
- 出树插件不能写会话事件，这一事实作为已知限制记录在 README：排序提示词始终可以从已记录的搜索参数、已记录的来源与固定模板重建。

## [S1] 问题

自带的 `web_search` 工具只经一个提供方触达网络：DeepSeek 的服务端搜索（或 Exa/Perplexity API 提供方），每个都需要付费凭据且排序固定。想要免费、本地、多引擎召回路径的用户——即 SearXNG-PLUS 的形态：查询多个引擎、融合排名、读取真实网页正文、再按相关性排序——没有任何本地选项，而这条路径需要的模型也不能是第二份插件私有的模型列表。

## [S2] 设计

### S2.1 面：一个新的 `ctx.web` 搜索提供方

`plugins/prism-search` 是一个出树 Prism 插件（Host 半 + 浏览器半），注册一个稳定 id 为 `prism-search` 的 `ctx.web` 搜索提供方。它不添加工具、结果卡片或提示词分节：既有的 `web_search` 工具、渲染、截断与超时策略原样复用。启用方式是既有 `web.searchProvider` 设置，在本插件自己的设置节里以开关暴露（见 S2.6）。

### S2.2 召回：18 个免费引擎

每个引擎都是一个声明式 spec（`build(query)` + `parse(body, finalUrl)`），无需密钥也无需账号：Google、Bing、DuckDuckGo、Brave、Startpage、Yahoo、Yandex、Mojeek、Marginalia、Qwant、Baidu、Sogou、360 Search、Bilibili、Wikipedia、GitHub、Hacker News、Stack Exchange。HTML 引擎共享一个锚点收集器（标题、取链接后文本的摘要、引擎宿主与资源过滤，以及 DuckDuckGo/Google/Bing/Yahoo 的重定向解包）；API 引擎直接解析自己的 JSON。含 CJK 的查询选择中文 locale 参数与 `zh.wikipedia.org`；其他查询用英文。

每个请求都携带浏览器 user agent、按引擎的超时与调用方的取消信号。一个引擎失败（被封、验证码、标记变更、超时）不贡献任何东西；只有当所有引擎都产出零结果时搜索才失败。

### S2.3 融合：倒数排名融合

每个引擎的排名列表按 RRF（`1/(60 + rank)`）合并，在归一化 URL 上去重（主机名小写、去掉 fragment 与跟踪参数、去掉尾部斜杠）。重复项保留第一个非空标题与最长的可用摘要，并记录返回它的每一个引擎。

### S2.4 内容：抓取靠前页面

融合后靠前的 `fetchTopN` 条结果（缺省 8）经 `ctx.web.fetch` 并发抓取（一次最多 4 个，独立超时），部署的地址与重定向策略及其配置的 fetch 提供方因此生效；网页的可读正文（去掉脚本/样式/注释、折叠空白、设上限）替换或扩充引擎摘要。抓取失败、非 2xx 响应、非 HTML 正文或被拒绝的目的地都保留引擎摘要；重定向后的最终 URL 替换引擎 URL。百度、搜狗与 360 返回不透明的 `/link` 包装，fetch seam 拒绝跨源跟随，因此先向引擎自己的重定向端点询问它指向何处（一个从不离开引擎主机的请求），再用同一 seam 读取暴露出的目的地；拿不到可用的 `Location` 时保留包装 URL 与引擎摘要。

### S2.5 排序：来自模型管理的一个模型

当 `rerankProvider` 与 `rerankModel` 都已配置时，靠前的 `maxRerankCandidates` 条结果（缺省 12）经 `ctx.llm.stream()` 作为一次辅助调用发给该模型：固定提示词要求返回 `{"order":[...]}`（从 1 起的索引，每个索引出现一次，最相关在前），插件按该回答重排。模型在本插件设置节（S2.6）中从 设置 → 模型 自己的 catalog 里选择；不硬编码任何模型名、端点或密钥。任何失败——模型缺失、LLM 服务不在、提供方拒绝、超时、调用方取消、输出无法解析或不完整——都让该搜索保持 RRF 顺序，从不使搜索本身失败。

重排请求是会话之外的一次辅助模型调用：这个出树插件不能写会话事件（profile 的持久化拒绝未知事件类型，除非是 `plugin:` 记录，而其写入函数在仓库内）。它的提示词是已记录 `web_search` 参数、已记录结果来源与本包固定模板的纯函数，因此该调用始终可以从会话日志重建。已作为已知限制记录在 README。

### S2.6 设置：一个设置节，两次写入

浏览器半注册一条 `settings.section` 条目（`prism-search`），读取 `ctx.remote.settings.describe()` 与 `ctx.remote.session.modelCatalog()` 并渲染：提供方开关（`web.searchProvider` = `prism-search`，或恢复为组合默认值）、按提供方分组的重排模型选择器，以及保存动作。保存写入插件自己的命名空间（`prism-search.rerankProvider`、`prism-search.rerankModel`），以及变更时的 `web` 命名空间 `searchProvider`，各自带上读取时的 revision。插件的 config 字段是 volatile 的，保存的模型对下一次搜索生效，无需重启。加载或保存被拒绝时在设置节内报告，而不是留白或停在保存中途。所有文案归 locale 所有（zh/en）。

### S2.7 配置

`prism-search` 行配置，每个字段都 volatile：`rerankProvider`（`''` = 关闭）、`rerankModel`、`fetchTopN`（8，`0` 关闭网页抓取）、`engineTimeoutMs`（8000）、`fetchTimeoutMs`（8000）、`rerankTimeoutMs`（20000）、`maxSnippetChars`（1200）、`maxRerankCandidates`（12）。缺省值随产品发布；设置节只编辑两个模型字段。

### S2.8 失败行为

- 全部引擎为空 → 一个错误，点名引擎数量与如何更改搜索来源。
- 单个引擎失败 → 静默跳过；搜索结果携带其余引擎返回的内容。
- 模型缺失/不可用 → RRF 顺序；没有用户可见错误。
- 提供方不可用：从不，因为 `available()` 是常量 `true`（该提供方无需密钥）。

## [S3] 范围

- 范围内：插件包（Host 提供方、18 个引擎、RRF、网页抓取、模型重排）、它的浏览器设置节、解析器/融合/重排/流水线的单元测试外加一个真实 Cordis 组合测试、README、安装说明。
- 范围外：自己的工具或结果卡片；答案合成（`content`）；缓存结果；按引擎的用户开关；SearXNG 兼容 HTTP API；改写其他包的代码。
- 范围外：装入正在运行的 profile（交付时作为单独一步提供）。

## Tasks

- [x] T1：搭建包骨架（manifest、tsconfig、tsdown、vitest、patch、README）(depends: none)
- [x] T2：HTML/文本助手与设上限的 HTTP 传输 (depends: T1)
- [x] T3：18 个引擎 spec 及其解析器 (depends: T2)
- [x] T4：RRF 融合与 URL 归一化 (depends: T1)
- [x] T5：带 JSON 顺序解析与回退的模型重排 (depends: T1)
- [x] T6：提供方流水线（扇出、融合、网页抓取、重排、边界）(depends: T2, T3, T4, T5)
- [x] T7：Host 入口、config schema、提供方注册 (depends: T6)
- [x] T8：浏览器设置节、桥、locale (depends: T7)
- [x] T9：助手、解析器、融合、重排、流水线的单元测试 (depends: T2-T8)
- [x] T10：验证（typecheck、测试、构建）与文档 (depends: T9)

## [S4] 验收

- [x] AC1：构建出的 Host 半注册一个 id 为 `prism-search` 的 `ctx.web` 搜索提供方，无需任何凭据 `available()` 即为 `true`。
- [x] AC2：提供方缺省暴露 18 个无需密钥的引擎；一次搜索查询扇出到全部引擎，单个引擎失败不能使搜索失败，只要还有其他引擎返回结果。
- [x] AC3：多个引擎的结果按 RRF 合并、在归一化 URL 上去重，并记录每个做出贡献的引擎。
- [x] AC4：靠前的 `fetchTopN` 条结果经部署的 fetch seam 抓取；有可读正文时替换摘要，重定向后的最终 URL 替换引擎 URL。
- [x] AC5：设置 `rerankProvider`/`rerankModel` 后，提供方恰好经 `ctx.llm.stream()` 做一次模型调用并按其 JSON 顺序重排；任何模型失败都保持 RRF 顺序并仍然返回来源。
- [x] AC6：提供方遵守 `request.maxResults`，只有真正裁剪结果时 `truncated` 才为 `true`。
- [x] AC7：设置节列出模型 catalog 中的模型，按读取的 revision 保存所选提供方/模型，并能将 `web.searchProvider` 设为 `prism-search`。
- [x] AC8：typecheck、单元测试与 tsdown 构建通过。
