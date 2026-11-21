# Agent Note: 一份持久的知识库，由已编译的 Markdown 页面构成

Status: implemented

[English](2026-10-07-prism-wiki-knowledge-vault.md) | 中文

## 问题

本 harness 里的文档工作是检索形态的。原始文件放在工作区里，模型用碎片拼出答案，而拼出的答案在轮次结束时就丢弃了。什么都不会积累，因此一个需要综合五份来源的问题，下次再被问到时仍要从零重新推导。

`prism-memory` 每条记录只存一条 claim。它回答"我们知道什么"，却无法回答"这批来源说了什么，来源之间在哪里不一致"，因为它没有页面级产物，也没有页面之间的交叉引用。组合中没有任何东西为模型自己写的正文提供位置，没有已写内容的目录，也没有在产品内阅读和编辑结果的方式。

## 决策

知识是编译出来的产物，而不是按问题临时检索。一个 vault 分三层——`raw/` 下不可变的原始来源、`wiki/` 下模型拥有的 Markdown 页面、以及由人和模型共同演化的 `AGENTS.md` schema——再加三个操作：摄入一份来源、查询页面、对整个 vault 做体检。这就是 llm-wiki 模式。知识编译一次后保持最新，因此已经存在的综合结论是被读出来的，而不是被重新构建的。

**插件只做机械工作，不调用模型。** `@prism/prism-wiki` 校验 frontmatter、以原子方式写入每个页面、重新生成目录 `index.md`、每次变更向 `log.md` 追加一条记录，并回答搜索与体检。读取来源、综合、撰写页面都属于模型。这正是校验与派生文件维护能够被强制而非仅靠自觉的原因：每一次页面写入都经过 `wiki_write`，因为 vault 位于会话工作区之外，模型自己的文件工具够不到它。

**`index.md` 与 `log.md` 是派生文件，不是模型的职责。** 插件自己从页面 frontmatter 重建目录、自己追加日志，因此二者都不依赖模型记得去更新，也都不会与它们所描述的页面脱节。

**vault 位于 DSH home，源码位于仓库，并以预构建副本交付。** vault 根目录是 `vaultRoot` 配置字段，默认 `<DSH home>/knowledge`。源码位于 `packages/prism/prism-wiki`；`plugins/prism-wiki` 是交付用的镜像，存放 `index.js`、`client.js`、`cordis.patch.yml`、`LICENSE` 与 `package.json`，每次发布刷新。这一分离由构建方式决定：`clientBundle()` 通过 glob `packages/*/*/package.json` 解析客户端包，对其他位置直接构建失败；根 tsdown workspace 与根 vitest include 都到不了 `plugins/*`；客户端文案门禁只在 `packages/*/*/src/client` 下发现源码。把带 Web 的插件写在 `plugins/` 下，就会同时失去受支持的客户端构建、文案门禁与根测试收集。

**搜索使用 SQLite FTS5 与 `trigram` 分词器。** 在 Node v24.19.0 与 SQLite 3.53.3 上实测：FTS5 默认的 `unicode61` 分词器对一段 CJK 文本做 CJK 查询返回零命中，而 `trigram` 能匹配。`.wiki/index.db` 处的索引是可重建的缓存，永远不是事实来源。

**schema 分两部分到达模型。** 静态的系统提示词段落承载机制说明，其字节由 Config 固定、保持稳定。vault 自身、被人和模型共同演化的 `AGENTS.md` 每会话追加一次，作为请求尾部的一帧，并随时可通过 `wiki_read` 读取。因此编辑 schema 永远不会重写已缓存的 prefix。

## vault 布局与页面格式

```
$DSH_HOME/knowledge/
  AGENTS.md
  index.md
  log.md
  raw/
    assets/
  wiki/
    overview.md
    entities/  concepts/  sources/  comparisons/  syntheses/
  .wiki/
    index.db
```

`AGENTS.md` 是共同演化的 schema；`index.md` 是生成的目录，`log.md` 是只追加的时序记录；`raw/` 存放不可变的来源，下载的图片放在 `assets/` 下；`wiki/` 存放模型拥有的页面，每类页面一个目录；`.wiki/` 存放插件私有状态，Obsidian 与 git 都会忽略它。

每个页面以一段扁平的 YAML frontmatter 开头：

```yaml
---
title: The page's human-facing name
type: entity
status: current
updated: 2026-01-31
tags: [retrieval, ranking]
aliases: [Other Name]
sources: [notes/paper.md]
confidence: 0.8
contradicts: [concepts/other-page.md]
---
```

`title`、`type`、`tags`、`updated`、`status` 必填；`sources`、`aliases`、`confidence`、`contradicts` 可选。`type` 取 `overview`、`entity`、`concept`、`source`、`comparison` 或 `synthesis` 之一，并决定页面所在的目录，因此路径与 frontmatter 不可能互相矛盾。链接是 `[[wikilink]]`，可写成文件 slug、相对 `wiki/` 的路径，或某个已声明的别名；指向尚不存在页面的链接就是对那个页面的请求。

## 考虑过的替代方案

**查询时做分块 RAG 检索。** 把来源做嵌入，按问题检索相关分块，让模型拼出答案。被否决，因为它对每个问题都重新推导同一份综合，什么也不留给下一个问题——这等于把待解决的问题复述成一个设计。

**扩展 `prism-memory` 的 claim 存储。** 被否决，因为 claim 记录回答"我们知道什么"，没有页面级产物、没有跨页面引用、也没有综合。把这些加进去会让同一个存储承担两种角色——claim 事实与已编译正文——并让两者共用一套压缩策略。

**让插件调用模型。** 被否决，因为综合本来就是同一轮中调用方模型的工作，插件再调一次只是重复，并为每个页面付第二份响应的价钱；frontmatter 校验、原子写入、目录与日志都没有模型输入；而且依赖模型的派生文件会随模型可用性而漂移，而不是随页面漂移。

**把 `index.md` 或 `log.md` 留给模型维护。** 被否决，因为由模型维护的导航文件会在某次写入批次忘记更新时立刻脱节，可解析的时序记录也不能寄望于模型记得追加。由插件重新生成与追加成本很低，且永远最新。

**把 vault 放在会话工作区内。** 被否决，因为会话工作区是逐会话的，并且在沙箱下属于模型的文件工具，而 vault 是跨越会话、由人另行编辑的部署级知识。`vaultRoot` 配置字段把位置留给部署决定。

**把插件写在 `plugins/` 下。** 被否决，因为该目录拿不到根构建产出的客户端 bundle、拿不到文案门禁、也进不了根测试收集，Web 知识页面无法在那里构建。源码留在 `packages/prism/prism-wiki`，`plugins/prism-wiki` 存放发布时刷新的预构建镜像。

**沿用 FTS5 默认分词器。** 基于实测被否决：`unicode61` 对一段 CJK 文本做 CJK 查询返回零命中，而 vault 预计会存放中文页面，默认分词器会让这些页面的搜索失效。

**加入嵌入、向量库或重排器。** 被否决，因为这里的检索就是字面 FTS5 排序，在这个规模下目录加一次普通搜索已经够用；而一个基于页面文本、可重建的索引不需要第二个依赖、不需要嵌入调用，也不需要因为换模型而重建索引。

## 后果

知识现在能跨轮次、跨会话积累：已编译的页面被读取和编辑，而不是被重新推导，目录与日志无需模型动作就保持最新。插件负责校验与体检——frontmatter 字段、页面与来源的关系、链接解析、矛盾——但它从不综合，因此两个页面之间的矛盾只有在模型把它记进 `contradicts` 之后才会浮现，而体检只有在两个页面互相点名后才会不再追问这一对。

vault 是 DSH home 里的部署数据，而包是仓库源码，因此交付的插件是预构建镜像，每次发布都必须刷新。将来若有带 Web 的插件写在 `plugins/` 下，就会失去客户端构建、文案门禁与根测试收集。

搜索依赖部署的 Node 运行时提供 SQLite FTS5 与 `trigram` 分词器，而索引只是缓存：任何部署都可以删掉 `.wiki/index.db`，除下次搜索要重建之外不会有任何损失。

每次页面写入都是原子的，并可携带期望的修订哈希；不匹配时返回冲突且什么都不写。vault 是带 `[[wikilink]]` 与 YAML frontmatter 的纯 Markdown，因此 Obsidian、任何编辑器与 git 都能原样操作它，而触及它的四方写入者——模型的工具、Web 页面、外部编辑器与 git——面对的是原子写入与修订校验，而不是一套锁协议。
