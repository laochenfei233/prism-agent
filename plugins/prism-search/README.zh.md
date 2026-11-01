# prism-search

[English](README.md) | 中文

一个 Prism 插件：给 `web_search` 增加一个无需密钥的本地搜索提供方。它并行查询
18 个免费搜索引擎，用倒数排名融合（RRF）合并排序，抓取靠前网页的正文，再用你在
**模型管理**里选定的模型重排。插件注册进现有的 `ctx.web` 能力接缝，直接复用
自带的 `web_search` 工具、结果卡片、超时策略与截断逻辑。

## 搜索引擎

Google、Bing、DuckDuckGo、Brave、Startpage、Yahoo、Yandex、Mojeek、Marginalia、
Qwant、百度、搜狗、360 搜索、哔哩哔哩、Wikipedia、GitHub、Hacker News、Stack
Exchange。全部免费、无需账号或 API Key。中文查询使用中文引擎参数与
`zh.wikipedia.org`，其他查询使用英文。

## 一次搜索的执行过程

1. 所有引擎并行收到查询，各自带超时与调用方的取消信号；被拦截、出验证码或超时的
   引擎不贡献任何结果。
2. 结果按 RRF（`1 / (60 + rank)`）融合，并按归一化 URL 去重（去掉跟踪参数、
   片段、结尾斜杠和 `www.`）。
3. 抓取排名前 `fetchTopN` 条结果，走部署的 fetch 提供方（因而沿用其地址与重定向
   策略），用网页正文替换引擎摘要；重定向后的最终 URL 替换引擎的跳转链接。
4. 配置了模型时，前 `maxRerankCandidates` 条结果作为一次辅助模型调用发给它，要求
   返回 JSON 顺序；调用失败或回答不可用时保留融合顺序。
5. 结果按调用方的 `maxResults` 截断。

## 设置

插件新增一个 **设置 → 搜索** 分区：

- **用 Prism Search 提供 web_search**：写入 `web.searchProvider`（值为
  `prism-search`，关闭时回到组合默认值）。
- **重排模型**：列出「模型管理」当前提供的全部模型，不含任何硬编码模型名。选择
  保存在插件自己的设置里（`rerankProvider`、`rerankModel`），下一次搜索即生效。

## 安装到 profile

先构建一次，再把目录作为 profile 依赖安装：

```sh
pnpm install && pnpm build
dsh plugin --profile web add /path/to/prism-search
```

重启服务。然后打开 设置 → 搜索，启用提供方，并按需选择重排模型。若 profile 的
`web` 行原本固定了别的搜索提供方，在开关打开前仍会继续使用它。

## 配置

行名 `prism-search`；所有字段都是 volatile，保存后无需重启即生效。默认值适合桌面
网络环境。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `rerankProvider` | `''` | 重排模型的 provider 路由；空表示不重排 |
| `rerankModel` | `''` | 重排模型的模型 id |
| `fetchTopN` | `8` | 抓取正文的网页数；`0` 表示不抓取 |
| `engineTimeoutMs` | `8000` | 单个引擎的时间上限 |
| `fetchTimeoutMs` | `8000` | 单个网页的时间上限 |
| `rerankTimeoutMs` | `20000` | 重排调用的时间上限 |
| `maxSnippetChars` | `1200` | 单页正文保留的字符数 |
| `maxRerankCandidates` | `12` | 交给重排模型的候选数 |

## 构建

```sh
pnpm install
pnpm build        # lib/index.js (Host) and lib/client.js (browser half)
pnpm typecheck
pnpm test         # unit tests, no network
pnpm smoke        # built artifact: registration plus one stubbed search
```

## 已知限制

- **HTML 抓取是尽力而为。** 引擎会改版，部分引擎会拦截机房或异常客户端；这些引擎
  在本次搜索里返回空，其余引擎照常作答。没有任何单个引擎是出结果的必要条件。
- **不做 JavaScript 渲染。** 正文只在客户端渲染后才出现的页面，保留引擎摘要。
- **重排调用不写 Session 事件。** 树外插件无法写入 Session 事件（持久化读取会拒绝
  未知的非 `plugin:` 类型），因此这次辅助请求不以事件形式落盘。其提示词是「已记录
  的 `web_search` 参数 + 已记录的来源 + 本包固定模板」的纯函数，仍可从 Session 日志
  重建。
- **百度、搜狗、360 的跳转链接**只有网页抓取成功后才解析为真实地址；抓取失败时
  来源 URL 仍是引擎跳转链接。
