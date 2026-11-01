# @prism/prism-memory

[English](README.md) | 中文

Prism 长期记忆：持久、按作用域与层过滤、带 supersede 追踪的记录，一个缓存安全的尾部召回块，5 个面向模型的工具，一个运维治理命令，一个 Web 记忆页，自动沉淀与整理，从其他工具的记忆文件导入，以及一份确定性的 Markdown 镜像。

## 概述

`@prism/prism-memory` 保存事实、决策、坑、偏好与流程，让它们比单次会话活得更久。记录存放在 `prism_memory` 存储域（storage domain）中，因此读取同步取自内存态、永不阻塞模型步骤；写入在后端落定之后才返回。一个前置的 `agent/pre-step` 监听器在轮次有话可说时，**在请求尾部**注入一帧有界内容。

有四点让它区别于常见的「把记忆注入系统提示词」插件：

1. **缓存前缀永不被改写。** 见下文。
2. **主张按三条彼此独立的轴归档** —— 主张讲的是谁的事（`layer`）、它是什么类型的陈述（`kind`）、谁能看见它（`scope`）—— 而层决定一条主张是先被声明还是被提及后才引用。
3. **治理是人的界面。** 批准、拒绝、恢复、过期、整理、导入与导出都是 `/memory` 子命令，其中前两项也是 Web 记忆页上的按钮 —— 都不是工具，因此模型无法自行提升自己的主张，而确实位于前缀中的 5 个工具 schema 保持固定。
4. **记忆同时来自三类写入方**：模型调用工具、一个轮次在收尾时被读取（无需额外模型调用），以及另一个工具已经为此用户写下的记忆文件。

## 设计约束：缓存前缀保持字节稳定

每一轮的请求是 `[系统提示词][工具 schema][历史]`。整段前缀都是缓存复用的目标，改写其中任何一个字节都会作废这次复用。因此本插件：

- 只在系统提示词中放入**一段静态** section（记忆协议），其文本从配置重新读取，但从不逐轮组装；
- 不添加任何逐轮的系统提示词文本、逐轮的工具 schema 变更，也不改写更早的历史；
- 每个步骤在尾部追加**一条**消息，无论它携带什么 —— 本地日期、常驻记忆、到期提醒与关键词召回一起搭载在同一帧里，而不是各发一条消息；
- 无话可说时完全不输出，因此一次准入的轮次与「未装本插件」的构建产出的轮次字节相同；
- 同样的命中渲染出同样的字节（全序排序、固定外框、无生成时间戳，日期而非时刻），因此未变的语料不会造成虚假未命中；
- 从不重复注入会话已经收到的记录，由 `prismMemory` 会话投影从插件自己记录的消息折叠而来；
- 保持工具面为 5 个定义，并在治理命令挂载时新增**零**个 schema；
- 让记忆页待在模型路径之外：它的路由与面板既不新增提示词文本，也不新增工具 schema，也不新增注入帧。

其中两项是部署决定，而出厂默认取的是该主张的强形式。`orientationEnabled` **关闭**，因为问候是唯一会在「本轮没有记忆支撑」时仍然开口的贡献：关掉它，空语料不改变任何字节；打开它应当是一次决定，而不是安装本插件带来的副作用。`identityLayers` **开启**，但在语料中出现落在这些层上的记录之前是惰性的 —— 而在分层轴存在之前写入的记录永远不会落在那些层上，因此升级后的存储注入的正是它原先注入的内容。

常驻 L0 索引（`residentIndex`）可用但**默认关闭**：它每轮重述语料，是实打实的 token 开销，而同样的信息只差一次 `memory_search` 调用。

## 使用本包

挂载 bundle，然后让模型调用工具即可。无需任何配置；每个字段都有出厂默认值。

```yaml
- name: '@prism/prism-memory'
- name: '@prism/prism-memory/tools'
- name: '@prism/prism-memory/commands'
- name: '@prism/prism-memory/web'
```

### 工具

| 工具 | 模型得到什么 |
|---|---|
| `memory_remember` | 存入一条主张，带 kind、layer、scope、可选标签、置信度、可选到期日与 TTL；`supersedes` 在同一次写入中使被替换的记录失效，近似重复项会回给模型 |
| `memory_search` | 字面关键词的排序摘要，每行带上它的层与来源会话；空查询列出最近的记忆，`conversation` 收窄到单个会话 |
| `memory_open` | 完整打开一条记录，带溯源，以及它替换过或替换它的主张链 |
| `memory_forget` | 退役一条记录，使其不再被召回；记录被保留，而非删除 |
| `memory_conversations` | 贡献过记忆的会话、各自持有多少，以及它们最新的主张 |

5 个工具是刻意的上界：工具 schema 位于缓存前缀中，在冷启动与每次 profile 切换时都要为之付费。

### 运维命令

`/memory` 是人做模型不该替自己做的决定的地方。它不占工具 schema，因此无法撑大前缀，模型也没有办法调用它。

| 子命令 | 效果 |
|---|---|
| `/memory status` | 按状态、作用域、层与 kind 计数（无参数时也是默认行为） |
| `/memory remember <text>` | 存下你自己的一条主张，不花模型的一轮；打印它落到的 id |
| `/memory search <query>` | 带层、kind、作用域与来源会话的排序主张；空查询列出最近的记忆 |
| `/memory review [limit]` | 待审收件箱：被拦下等待批准的记录 |
| `/memory approve <id> [note]` | 把一条待审记录提升为 active |
| `/memory reject <id> [reason]` | 归档一条待审记录 |
| `/memory forget <id> [reason]` | 退役一条仍生效的主张，使其不再被召回；记录被保留 |
| `/memory show <id>` | 一条记录，带溯源、日期、标签、印证与其 supersede 链 |
| `/memory restore <id> [reason]` | 把一条记录回滚为 current |
| `/memory conversations [limit]` | 按来源会话浏览语料 |
| `/memory maintain [apply]` | 卫生巡检；除非给出 `apply`，否则为空跑 |
| `/memory dream [apply]` | 整理巡检；除非给出 `apply`，否则为空跑 |
| `/memory journal [limit]` | 整理日志与每日反思 |
| `/memory import [apply] [sources]` | 读取其他工具的记忆文件；除非给出 `apply`，否则为空跑 |
| `/memory export [dir]` | 写出 Markdown 镜像及其 JSON 索引 |

### 记忆页

`@prism/prism-memory/web` 在 `/api/prism-memory` 下注册四条精确 Fetch 路由 —— `overview`、`search`、`remember` 与 `review` —— 各回答一个 `{ ok, value }` 信封。带请求体的三条用 zod 校验请求体；`overview` 不读请求体。浏览器侧把它们渲染成侧边栏里的一个页面：整库计数、关键词搜索、新增表单、带通过与驳回的待审收件箱，以及仍生效的主张。

页面没有调用会话，因此它通过服务的运维面来读写与结算 —— `operatorRecords`、`operatorSearch`、`operatorApprove` 与 `operatorReject`，它们都不按作用域收窄。每一行都渲染自己的作用域，让收窄在做决定的地方可见。面向模型的调用方不变：工具传自己的 agent，`/memory` 传自己的会话，两者仍然被它们过滤。

页面存下的主张是 `global`，因为没有会话可以用来推导 project 或 conversation 作用域 —— 因此在那里新增的一条 `user` 或 `rule` 主张会在每个会话的第一轮被声明。退役它是 `/memory forget <id>`，这也是退役一条仍生效主张的唯一人用路径。

该行声明了 `webServer`，因此没有组合 Web 服务器的 profile 会让它保持 pending，而不是加载失败。浏览器包是一个 module-loader 闭包，把 React 与共享 primitives 作为基线模块请求，而不是再内联一份副本。

## 分层轴

一条主张按三条轴归档，每条轴回答一个不同的问题：`layer`（它是关于什么的）、`kind`（它是什么类型的陈述）、`scope`（谁能看见它）。

| 层 | 它是关于什么的 |
|---|---|
| `soul` | 助手自身的稳定设定：人格、语言、工作方式 |
| `user` | 这个人：偏好、习惯、希望被如何对话 |
| `project` | 当前工作目录：布局、约定、当前状态 |
| `fact` | 关于世界或代码的客观事实 |
| `lesson` | 犯过的错以及它教会了什么 |
| `topic` | 值得按其自身条款召回的领域知识 |
| `rule` | 硬约束：必须发生或绝不能发生的事 |

有两种行为挂在轴上，而不是挂在每条记录上：

- **层决定常驻集合。** 落在 `identityLayers`（默认 `soul`、`user`、`rule`）所列层上的记录，会在会话首轮被注入而不必等待关键词命中，因为偏好或约束在被提及之前就已经相关。
- **层为相关性加权。** 命中的 `rule` 或 `lesson` 排在同样措辞的 `fact` 之前。

不声明层的记录 —— 即在这条轴存在之前写入的每一条记录 —— 按 `fact` 参与排序。这个默认刻意选的是*相关性*层而不是身份层：把遗留记录默认到常驻层，会改变升级后语料注入的内容。

## 检索

排序是在字面 token 上做的 BM25，tokenizer 处理 ASCII 词与 CJK 字符及其相邻二元组（不分词器，也没有 embedding —— 见限制）。

三件事在起作用。一个词项的权重随包含它的记录变多而下降，所以一条主张是靠「区别于其他记录的部分」被找到的。同一条记录内的重复会饱和，所以一条记录不会因为把同一个词说三遍而排到前面。更长的记录会被折价，所以一句短语在短主张里比埋在一段话中间更容易被召回。`bm25K1` 与 `bm25B` 是两个旋钮；`k1: 0` 关闭词频加权，`b: 0` 关闭长度归一。

分数按查询自身词项权重的平方根归一。选择平方根而不是求和是刻意的：用户的消息很长且大部分是顺带的话，用它的总权重做分母，会让「命中了唯一重要的那个词」的记录得分和「什么都没命中」一样差。出厂的阈值 `minInjectScore: 0.6` 与 BM25 之前的排序器可比，因此升级不会悄悄停止召回原本会被召回的东西。

## 自动记忆

有三类写入方无需工具调用即可写入。它们都不能把未复核的主张送到模型面前：沉淀与导入默认落 `pending`，而 pending 从不注入，只能由 `/memory approve` 或 `/memory reject` 定夺。

### 沉淀：在轮次自己的路径上

一个 `agent/turn-stopping` 监听器读取刚刚结束的那个轮次 —— 人的消息与助手自己的交代 —— 并抽取陈述了持久内容的句子：约束（"must never…"、"禁止…"）、偏好（"I prefer…"、"以后都…"）、已确立的成因（"the root cause was…"、"根因是…"），或本工作区的一条约定。

这条路径里没有模型调用。它每轮零成本，且对相同文本完全确定，这正是它能每轮都跑、而不必挂在调度器后面的原因。它也不动复用计数：语料已经持有的主张直接丢弃，因为 `hits` 被当作人或模型真的去拿过这条记录的证据。

代价说得很直白：一个识别句式的读取器既有漏检（换种说法表述的主张会被漏掉），也有误报（一句话读起来像约束但其实不是）。误报正是出厂状态为 `pending` 的原因。

### 整理：按窗口

一个 `agent/turn-stopping` 监听器还会在语料推进得足够远之后跑一次整理巡检。窗口边界是语料本身 —— 上一条 journal 条目的写入时间 —— 而不是私有计数器，因此它能跨重启、跨 fork，也跨第二个读同一份存储的进程。

这次巡检得出三件事，并拒绝第四件：

- **印证。** 由不止一个会话写出的主张，经历过不止一次出错的机会。写入路径在一条相同的主张来自不同会话时记下这一点；巡检通过盖上 `corroboratedAt` 确认这些主张。它不碰 `confidence`：一条主张携带的确定性是其作者的陈述，后台巡检抬高它等于在编造证据。
- **主题摘要。** 持续在同一个召回标签下返回的主张，会变成一条列出它们的 `topic` 记录，于是后续召回只有一个入口而不是 N 个。摘要以 `pending` 写入：它是机器写的、关于其他记录的散文，一个错误的索引条目会经它误导每一次召回。
- **日志。** 每次巡检写一条归档条目，记下它发现了什么；每完成一个有活动的本地日写一条反思。两者都是确定性的，因此日志读起来像一份 diff。
- **矛盾只上报，绝不裁决。** 两条共用召回标签、措辞重叠但说的不是同一件事的在库主张，会被人看到。在两条主张之间做选择是一个判断，而一个错误的自动选择比一个悬而未决的问题更糟。

这里没有任何东西会删除。会归档的整理是 `/memory maintain`，它仍然是一个单独的运维动作。

### 日期

一条记录可以带到期日，区别于它的失效时间。失效让一条主张退役；到期日让它保持有效，并在日期到来时作为提醒浮现，范围在 `reminderWindowDays` 之内。这就是本插件全部的提醒面：它是变得可执行的记忆，不是调度器。

### 导入其他工具的记忆

`/memory import` 读取本插件按 id 认识的布局 —— `claude-code`、`mimocode`、`cursor` 与 `workspace`（调用方工作区的 `AGENTS.md` / `CLAUDE.md`）—— 并把它们的标题与列表项转成主张。文件的标题在能指明层的时候决定层，布局决定作用域。每次读取都受文件数量、文件大小与深度限制，缺失的根目录或不可读的目录是普通结果而不是失败：这些目录属于其他工具。

除非指名某个布局，否则什么都不读。`importSources` 默认为空，因此其他工具的记忆绝不会在用户背后被枚举。

语料已经持有的主张会被计为跳过而不是再次存储 —— 包括本次导入自己拦下待审的主张，以及运维人员此后归档的主张，因此一条退役的主张不会被下一次运行复活。

## 治理与库卫生

- **待审收件箱。** 在 `requireApproval` 下，或对任何低于 `pendingBelowConfidence` 的写入，主张都以 `pending` 存储。注入与搜索可见性是两个独立的决定：一条 pending 记录从不注入、也从不计为在库，但 `memory_search` 会返回它 —— 在**每一种**配置下，包括 `requireApproval` —— 因此模型总能找到它自己写过的主张，无论它当时带什么置信度。定夺它的只有 `/memory approve` 或 `/memory reject`，两者模型都无法调用。
- **双时间记录。** 每条记录带 `validAt` 与 `invalidAt`。supersede、过期、合并与遗忘都走失效而不是删除，因此旧答案保持可审计，而只有当前主张会注入。
- **回滚。** `/memory restore` 重新激活一条记录并归档一个在库的后继者，把回滚记录在后继者的证据里。
- **维护。** `/memory maintain` 报告它将要做什么，在 `apply` 之前不写任何东西：超过期限的在库记录被归档，达到或高于 `dedupeJaccard` 的近似重复被合并进读者会保留的那条记录（更高置信度，其次更新），存储达到容量时已归档记录被淘汰，以及无法再解析的 supersede 链被上报。
- **确定性镜像。** `/memory export` 写出 `memory.md` 与 `memory.index.json`，方式是完整写入同目录的临时路径再改名。相同的语料产出相同的字节，因此镜像可以提交，`git diff` 只显示真实的记忆变化。

## 第二层：持久的会话历史索引

沉淀出的主张回答「我们知道什么」。它们不回答「我们那次关于 X 的会话里得出了什么结论」—— 在后者上，对摘要做关键词匹配常常落空。harness 已经自带那条读取路径 —— `sessionQuery` 服务，以及在其工具包已安装时的 5 个 `session_*` 工具。它自带却**禁用**的，是它们底下的索引。第二个 patch 文件把它打开：

```yaml
# session-search.patch.yml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-search.db')
    openAt: first-search
```

出厂的 base 与 Web 两层以 `path: ':memory:'` 和 `openAt: never` 挂载 `session-query-sqlite`，因此排序内容搜索处于关闭状态，`node:sqlite` 从不被导入。这一层给那个索引一个 Harness home 下的持久文件，并把导入推迟到第一次搜索，从而让启动保持安静。

**本 bundle 刻意不挂载任何工具。** `@deepseek-ai/dsh-tool-session-query` 并非每套 Harness 安装都有 —— 打包的桌面运行时自带 `session-query` 服务与其 SQLite 提供方，但不带该工具包 —— 因此指名它的配置行会在缺少它的运行时上每次启动都导入失败。在该包*确实*已安装的地方，从部署自己的 patch 层挂载它：

```yaml
# the deployment's patch, not this bundle's
- insert:
    - id: tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
```

那一行才是把 `session_search`、`session_event_search`、`session_trace`、`session_event_trace` 与 `session_event_read` 放到模型面前的东西。它的权限来自 harness 自身：跨会话访问要求目标会话的 `cwd` 与调用方完全相等。

两层通过溯源相接：`memory_search` 与 `memory_conversations` 在每一行上渲染来源会话 id，因此一条主张可以被追溯回那次会话的原始消息。

从本包的 `dsh.bundle.patch` 列表里去掉 `./session-search.patch.yml`，即可保留出厂的临时索引；记忆相关的行不受影响。保留它的代价只是那份派生出来的数据库。

### 作用域与权限

作用域取自不可变的调用会话，绝不取自模型提供的参数：

| 作用域 | 存储键 | 对谁可见 |
|---|---|---|
| `global` | `''` | 每个会话 |
| `project` | 会话的 `cwd` | 工作目录完全相同的会话 |
| `conversation` | 所属会话 id | 仅该会话 |

调用方作用域之外的记录不只是排得更低，而是在排序之前就被过滤掉，且每一个按 id 的操作都会以 `PRISM_MEMORY_OUT_OF_SCOPE` 拒绝它。模型可以请求的唯一收窄 —— `memory_search` 的 `conversation` 参数 —— 只能缩小调用方的可见集合，绝不能扩大它。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `protocolSection` | 出厂协议 | 描述这些工具的静态系统提示词文本 |
| `injectEnabled` | `true` | pre-step 监听器是否可注入 |
| `maxInjectedRecords` | `3` | 每个注入块中的记录数，含关键词召回的命中 |
| `maxInjectedChars` | `900` | 整个注入帧的字符上限 |
| `minInjectScore` | `0.6` | 关键词召回的相关性阈值 |
| `residentIndex` | `false` | 没有记录命中时注入 L0 索引 |
| `maxIndexChars` | `600` | L0 索引的字符上限 |
| `searchLimit` | `6` | `memory_search` 结果的硬上限，含模型请求的 `limit` |
| `maxTextChars` | `2000` | 存储文本的上限 |
| `maxTags` | `8` | 存储标签的上限 |
| `maxRecords` | `5000` | 存储上限；达到上限的写入会淘汰最旧的已归档记录，没有可淘汰的则以 `PRISM_MEMORY_FULL` 失败 |
| `requireApproval` | `false` | 让每次写入都经过 `pending`；pending 记录从不注入但保持可搜索 |
| `pendingBelowConfidence` | `0.5` | 低于此置信度的写入变为 `pending`；pending 记录从不注入但保持可搜索 |
| `dedupeJaccard` | `0.85` | 写入报告近似重复的阈值，也是 `maintain` 执行合并的阈值 |
| `dedupeReplaceJaccard` | `0.97` | 写入被视为相同主张、不再存第二次的阈值 |
| `autoTag` | `true` | 为未提供标签的写入推导召回标签 |
| `defaultTtlDays` | `0` | 未请求失效时间的写入所用的失效期；`0` 表示永不 |
| `exportDir` | 未设置 | 默认镜像目录；`/memory export <dir>` 覆盖它，值缺失时以 `PRISM_MEMORY_NO_EXPORT_DIR` 直接失败 |
| `identityLayers` | `[soul, user, rule]` | 首轮无需关键词命中即召回的层，按注入顺序；`[]` 关闭常驻路径 |
| `maxIdentityRecords` | `4` | 常驻路径每次首轮可注入的记录数 |
| `bm25K1` | `1.2` | 词频饱和；`0` 关闭词频加权 |
| `bm25B` | `0.75` | 文档长度归一；`0` 忽略长度 |
| `injectEveryStep` | `false` | 在该步骤接纳了新的用户文本时，轮次的后续步骤也召回 |
| `orientationEnabled` | `false` | 首轮注入本地日期、星期与问候 |
| `reminderEnabled` | `true` | 让到期日已到的记录浮现 |
| `reminderWindowDays` | `7` | 到期日提前多久浮现 |
| `maxReminders` | `3` | 每次首轮注入的提醒数 |
| `autoDistill` | `true` | 读取每个轮次自身的文本以寻找持久主张 |
| `autoDistillStatus` | `pending` | 沉淀出的主张写入时所用的状态 |
| `autoDistillConfidence` | `0.4` | 沉淀出的主张写入时所用的置信度；低于复核阈值，因此会被拦下 |
| `autoDistillLimit` | `3` | 一个轮次可贡献的主张数 |
| `dreamEnabled` | `true` | 按窗口运行整理巡检 |
| `dreamEveryWrites` | `25` | 距上次巡检之后写入多少主张才再跑一次 |
| `dreamWindowRecords` | `200` | 一次巡检拿来与语料比对的新素材记录数 |
| `dreamConflictFloor` | `0.5` | 两条在库主张算作可比但相互矛盾的相似度阈值 |
| `dreamClusterFloor` | `3` | 共用一个标签的主张数达到多少时，该标签获得一份摘要 |
| `dreamMaxTopics` | `3` | 一次巡检写出的摘要数 |
| `dailyReflection` | `true` | 为每个有写入的已完成本地日写一份交代 |
| `importSources` | `[]` | `/memory import` 可读取的外部布局；不指名则不读 |
| `importStatus` | `pending` | 导入的主张写入时所用的状态 |
| `importConfidence` | `0.6` | 导入的主张写入时所用的置信度 |

`dedupeReplaceJaccard` 低于 `dedupeJaccard`、`identityLayers` 中出现未知或重复的名字、`dreamClusterFloor` 低于 `2`，以及 `importSources` 中出现未知的名字，都会让插件加载失败。每个字段都是易变的，因此可以从运行中的配置面编辑。

## 记录模型

```
id            mem_<uuid>
scope         global | project | conversation
scopeKey      '' | cwd | session id
kind          fact | decision | pitfall | preference | procedure
layer         soul | user | project | fact | lesson | topic | rule (absent ⇒ ranked as fact)
text          one self-contained claim, ≤ maxTextChars
tags          lowercase keywords, ≤ maxTags
status        active | pending | superseded | archived
confidence    0..1
createdAt     epoch ms
updatedAt     epoch ms
validAt       epoch ms, or null
invalidAt     epoch ms, or null
expiresAt     epoch ms, or null
dueAt         epoch ms, or null
supersedes    memory id, or null
supersededBy  memory id, or null
origin        model | operator | session | import
reviewedAt    epoch ms, or null
reviewNote    operator note, or null
mergedInto    memory id this record was folded into, or null
restoredAt    epoch ms, or null
corroborations  times an identical claim arrived from another conversation
corroboratedAt  epoch ms a consolidation pass confirmed it, or null
evidence      { sessionId, messageId, note }
hits          reuse count, incremented by memory_open
```

该域停留在版本 1。后续各层新增的每个字段在记录 schema 中都是可选的，因此由更早的构建写出的存储会在当前 schema 下重新打开，而不是被拒绝或丢弃：`per-record` 布局会逐份校验存储文档，而一个必填的新字段会让所有既有记录失效。

本插件为自己写下的记录 —— journal 条目、反思与主题摘要 —— 带 `dream-journal`、`dream-reflection` 或 `dream-topic` 标签，以及一个让它们既不被注入也不进入搜索的状态。它们可以通过 `/memory journal` 阅读，并在导出镜像中可见。

## 模型体验

### 系统提示词

一段固定 section，`prism-memory`，order 为 2500，每次组装都从 `protocolSection` 解析。只要配置与插件不变，它的字节就不变。它点名分层轴，因为模型无法使用没被告知过的字段。token 影响：每个请求一段短文本。KV Cache 影响：前缀稳定。

### 工具 schema

5 个固定 schema 在可见时随每个请求发送。挂载治理命令不新增任何 schema。token 影响：5 段短 schema。KV Cache 影响：工具可见性与定义不变时前缀稳定。

### 注入帧

模型每个步骤最多看到一条额外的 user 角色消息，且仅当某一节有内容可贡献时：

```
<prism-memory>
Good evening. Today is Monday, 2026-10-05 (evening, local time).
Standing memory:
- [mem_…] (user, preference, 2026-09-14) prefers short answers with no preamble
Due now (a date recorded earlier has arrived):
- [mem_…] (project, decision, 2026-10-01) rotate the staging credentials
Possibly relevant memory:
- [mem_…] (lesson, pitfall, 2026-09-30) the root cause was a stale build cache
</prism-memory>
Treat memory as background: verify before relying on it, and call memory_search or
memory_open when the exact record matters.
```

没有任何内容可贡献的节会被省略，因此一个只带问候的轮次不会有任何记忆标题。token 影响：受 `maxInjectedChars` 限制，当所有节都为空时不存在。KV Cache 影响：只在尾部追加；它在下一轮变成可复用的前缀，且从不使更早的缓存条目失效。

### 轮次末的巡检

沉淀与整理写入记录且不追加任何消息，因此在触发它们的那个轮次里对模型不可见。它们写下的内容之后会通过召回或通过工具变得可见，与任何其他记录一样。对触发轮次的 token 影响：无。

### 记忆页

token 影响：无。页面通过自己的路由读写，而它所结算的东西 —— 一条被批准或存下的主张 —— 只会经由本就存在的注入与检索路径到达模型。KV 缓存影响：无，因为这条路径上没有任何东西属于一次请求。

## 验证

```sh
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit          # host face against the checkout's declarations
node ../../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit   # browser face against the DOM library
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts       # 178 specs over the real services
node ../../node_modules/.bin/tsdown --config tsdown.config.ts                 # emit lib/
node scripts/smoke.mjs                                                        # artifact plane
```

这些规格驱动的是生产服务 —— 带 SQLite 后端的 storage hub、domain 设施、会话存储、系统提示词注册表、会话投影注册表、工具运行时与 agent loop —— 因此一条关于记忆的断言就是一条关于模型看到什么的断言。

`tests/cache-safety.spec.ts` 是本包核心主张的测试套件：未命中的轮次不添加消息，命中的轮次在未动过的前缀之后恰好追加一条消息，该块对固定语料是确定性的，已投递的记录绝不重复，该块遵守它的字符预算，5 个工具 schema 在多次读取之间字节稳定，以及挂载治理命令不新增 schema。

`tests/automatic.spec.ts` 是自动那一半的测试套件：一个轮次自身的文本在无模型调用的情况下被沉淀并拦下待审，重复的主张不会被存两次、也不抬高它的复用计数，整理窗口按语料而不是按计数器开启，矛盾被上报且两条主张都存活，常驻记忆无需关键词命中即到达，到期日会浮现，以及一次导入把一个工作区文件读成 project 作用域的主张而不重复它已经读过的东西。

`tests/commands.spec.ts` 是运维命令面的测试套件：每个用例把一行 `/memory` 打进真实的命令运行时并读取结算后的结果，因此一次什么都没存下的 `remember`、一次渲染错行的 `search`，或一个不再被解析的子命令都会在那里失败。

`tests/web.spec.ts` 与 `tests/web-composition.host.spec.ts` 是浏览器路由的测试套件：前者通过路由注册时的那个对象驱动每条路由，断言信封、请求体校验与它背后的运维面；后者用真实 Loader 在真实 web 服务器与 Connection 之上启动该行，并断言在没有两者的 profile 里它保持 pending —— 而不是失败。`tests/client/api.spec.ts` 覆盖浏览器请求客户端自己的解码，包括宿主答了它读不懂的东西这一情形。

## 已知限制与延期工作

- **没有 embedding。** 排序是在字面 token 上做的 BM25（ASCII 词加 CJK 字符与二元组）。改写式召回能力弱；没有重排序器，也没有向量索引。harness 不自带 embedding 提供方，因此向量路径需要先有它。
- **记忆语料没有 FTS 索引。** 记录存放在存储域中并在内存里排序，这让检索在模型路径上保持同步且无 I/O。在 `maxRecords` 上限之下这是正确的取舍；超过它之后，或者一旦改写式召回比延迟更重要，下一步就是在同样的记录上建立 `node:sqlite` FTS5 索引。
- **沉淀识别的是句式，不是含义。** 它是一张正则表。换种说法表述的持久主张会被漏掉，而一句读起来像约束其实不是的话会被捕获。两者都是出厂状态为 `pending` 的原因；把 `autoDistillStatus` 提到 `active` 的部署是在把误报接进注入。
- **矛盾检测是启发式的。** 它要求共用一个召回标签且落在某个相似度区间内，因此会漏掉用不同措辞表述的矛盾，也可能把关于同一主题的两条细致主张标出来。它只上报；没有任何东西被自动裁决。
- **每日反思报告的是已经过完的一天，因此它在那天之后才出现。** 一个连跑数周、没有跨过本地午夜的会话永远不会产出它。
- **整理跑在轮次的路径上。** 该巡检受 `dreamWindowRecords` 限制，但它在轮次关闭之前被等待，因此非常大的语料会让跨过窗口的那个轮次变慢。
- **轮次末巡检的失败属于该轮次的一部分。** 沉淀与整理会传播它们的错误而不是吞掉它们，依据的原则是坏掉的存储应当吵闹。宁愿丢一次巡检也不愿让轮次失败的部署，应当在自己那一层放宽捕获范围。
- **语料常驻内存。** 每条记录都驻留在该域的同步状态中，受 `maxRecords` 限制，但不受字节数限制。
- **`hits` 只计显式打开**，因此复用加权是弱信号。沉淀刻意不碰它。
- **维护与整理巡检没有被调度。** 它们跑在轮次路径上和运维命令上；希望它们在固定时刻跑的部署，需要一条指向 `/memory maintain apply` 或 `/memory dream apply` 的 schedule 配置行。
- **页面只新增与结算，不编辑。** 改写一条主张是带 `supersedes` 的 `memory_remember`，退役一条仍生效的记录是 `/memory forget <id>`；面板两个都不提供，因为在面板上做的编辑没有审计故事。
- **页面的 overview 在每次写入后读取整个库。** 它受 `maxRecords` 约束，对本存储所面向的语料规模是正确的；接近该上限的存储会想先做分页读取。
- **四个运维方法是公开且不收窄的服务方法。** 没有任何面向模型的调用方能到达它们，而 `maintain`、`dream`、`importMemories`、`exportMarkdown` 本来就是整库操作，因此这不引入新的权限类别 —— 但任何注入 `prismMemory` 的插件都能读到整库，而类型除了名字之外没有表达这一点。
- **页面没有组件规格。** 该包在仓库之外，那里没有可渲染它的 jsdom 与 React 安装，因此它的行为只由路由规格、请求客户端规格，以及加载该包并执行其 `apply` 的 smoke 覆盖。
- **面向模型的会话工具不在本 bundle 中。** `session-search.patch.yml` 打开持久的 `sessionQuery` 索引，但挂载 `@deepseek-ai/dsh-tool-session-query` 是部署的决定，因为该包并非每套 Harness 安装的一部分。没有那一行，模型仍能通过 `memory_search` 的溯源到达一条主张的来源会话，但它没有直接读取会话历史的工具。
- **导入布局按 id 硬编码。** 新增一个工具意味着往 `IMPORT_SOURCES` 加一条；自定义布局没有配置格式。

## 安装

本 bundle 是 profile 层的安装：把包放到 profile 解析 bundle 的位置，加入 profile 的 `dsh.profile.bundles`，然后重启。不需要全局依赖，也不需要外部服务；该域经由 profile 配置的存储后端路由，两个 schema 库（`zod`、`@deepseek-ai/schemastery`）以及 harness 的各 seam 都从 profile 解析，与 harness 自己的插件一样。
