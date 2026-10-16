# 跨 home 会话导入 · 实施规格

**这份文档是什么**：把「另一个 DSH home 里的历史会话导入当前 home」做成一等功能（设置页入口）的完整实施规格。写给**在新的对话里实现它的 agent**——它看不到本文档之外的任何上下文，所以每条都自带缺口证据、落点、契约、行为规格与验证基线。

**一句话背景**：Prism Agent 是 DSH 的 fork，但**换了自己的 home**。DSH 的默认 home 是 `~/.dsh`（`packages/util/home-paths/src/index.ts:12`），桌面版 Prism Agent 用 `DSH_HOME=~/.prism` 启动。于是从 DSH 迁移过来的用户在侧栏看到的是**空的历史**——旧对话完整地躺在 `~/.dsh`，没有任何受支持的入口把它搬过来。

**当前状态**：本次会话已经用一次性脚本完成了一次真实导入（54 个会话、43.2 MB，见 §7 验证结果），但脚本方案有一个必须由产品解决的缺陷（§0.3）。本文档描述的就是把它做成功能的设计。

**缺口证据**：`packages/**` 全量搜索 `session-import` / `importSessions` / `import-sessions` / `migrateHome` / `home-migration` / `sessionImport` —— **0 命中**。仓库里唯一相关的历史痕迹是 `~/.dsh` 里那 8 个测试会话（`migration-probe-1..4`、`web-migration-test*`、`dsh-migration-e2e`、`planb-e2e`，cwd 为 `Easel`），是一次**没有留下代码**的实验产物。

---

## 0. 先说清三件已验证的事实

### 0.1 一个 home 里什么算「对话记录」

证据：`packages/bundle/base/cordis.patch.yml:131-133`（`session-persistence-jsonl.root = dshHomePath('sessions')`）、`:168-171`（`storage-json.root = dshHomePath('storages')`），以及实机目录结构。

| 路径 | 内容 | 权威性 | 导入策略 |
|---|---|---|---|
| `sessions/<projectKey>/<sessionDir>/session[.vN].jsonl[.zstd]` | 会话日志本体，一代一个文件，**日志是唯一权威** | 权威 | **必须搬** |
| `storages/workspace.json` | 工作区分组登记表（path / title / sessionIds / archived / pinned / default） | 权威 | **必须合并**，否则新会话全部落进「未分组」 |
| `storages/prism_memory/records/*.json` | 长期记忆 | 权威 | 可选（会改变 agent 行为，见 §8） |
| `attachments/**` | 会话引用的图片/文件 | 权威 | **必须搬**，否则历史里的图片打不开 |
| `storages/session_projcache/sessions/*.json` | 投影缓存 | **派生** | **不要搬**：`packages/session/session-projection-cache/README.md:12` 明说「log leads and the cache follows」，缺了会自动重建 |
| `credentials.yaml` / `settings.yaml` | 凭据与设置 | 宿主私有 | **不要搬**，见 §1.2 |
| `profiles/**` / `cache/` / `bin/` | 运行时 | 本机绑定 | 不要搬 |

`projectKey` 的编码规则在 `packages/session/session-persistence-jsonl/src/format.ts:225`（分隔符折叠成 `-`，非安全码位转 `~XXXX`，形如 `--C-Users-chenfei-Documents-GitHub-prism-agent--`）。导入必须复用这个函数，不要另写一套。

### 0.2 会话列表是**实时扫描**的，分组不是

- **列表实时**：`packages/api/session-controller/src/list.ts:126-144` 的 `list()` 每次调用都走 `ctx.sessionQuery.listSessions()` 重新读持久化；Web bundle 把全文检索关掉了（`packages/bundle/web-app/cordis.patch.yml:27-30`，`openAt: never`），所以没有任何启动期索引挡在中间。**结论：日志文件一落盘，刷新页面就能看见。**
- **分组只在启动时读**：`packages/workspace/workspace/src/index.ts:197-218`，`initialized` 已经是 `true` 时只重建 header 索引（`replaceHeaderIndex`），**不再 bootstrap 成员关系**（`bootstrap` 在 `:646-738`，只跑一次）。
- **没有成员登记的会话会落进「未分组」桶**：`packages/client/ui-workspace/src/client/tree.ts:19`（`UNGROUPED_KEY`）、`:343-382`（`groupByWorkspace` 把不在任何 workspace.sessionIds 里的会话收进 Ungrouped）。

### 0.3 关键约束：`workspace.json` 是**内存投影**，外部改文件会被覆盖

`packages/storage/storage-json/src/single-unit.ts:4` 的模块注释：

> The in-memory state is authoritative; every write primitive mutates it and republishes the whole file atomically.

而 `packages/workspace/workspace/src/entity.ts:202-220` 的 `mutate()` 每次改成员都 `table.update(...)` → 整文件重写。**所以：应用在跑的时候从外部改 `workspace.json`，既不会立刻生效，还会在下一次 workspace 写入（比如新建一个会话触发 `attachSession`）时被内存里的旧版本整份覆盖。**

这就是为什么**一次性脚本导入必须重启应用**，而**做成一等功能则完全不需要重启**：功能走 `ctx.workspaceRegistry` 这个活的 service，而不是改文件。**这是本设计最重要的一条。**

---

## 1. 功能定义

### 1.1 用户可见行为

设置 → **数据**（新分区）里：

1. 自动列出探测到的候选来源 home（默认 home `~/.dsh`、以及用户手动选过的目录），每个显示「N 个会话 · M MB · 最近活动时间」。
2. 也可以「选择文件夹…」手动指定任意一个 home（走既有 `ctx.directoryPicker`）。
3. 选中后先出**计划预览**（不写任何东西）：按工作区分组的表格，显示将新增/已存在/冲突的数量与体积，以及跳过的原因。
4. 点「导入」执行，显示进度；结束后给出结果摘要：成功 N、跳过 M（已导入）、失败 K（可展开看每个失败的会话 id 与错误）。
5. **不需要重启**：导入完成后侧栏立即出现对应分组与会话。

### 1.2 明确不做

| 不做 | 理由 |
|---|---|
| 不搬 `credentials.yaml` | 凭据是宿主私有身份，跨 home 合并 = 把两个安装的身份混起来，是安全决策而非迁移细节 |
| 不搬 `settings.yaml` | 同上；DSH 已有 `settings.yaml.imported` 语义，另有其入口 |
| 不做双向同步 / 增量追平 | 一次导入语义已经够用；「保持两个 home 一致」是另一个产品 |
| 不搬投影缓存 | 派生数据，`session-projection-cache` 会自愈（§0.1） |
| 不修改、不删除来源 home 的任何字节 | 只读来源 |
| 不做「就地打开另一个 home」 | 会引入两套持久化根并存，与「一个进程一个 root」冲突 |

---

## 2. 落点

### 2.1 新包：`packages/session-query/session-import/`

**为什么在这个组**：fork 自己的布局注释把 export 归给了这个组——根 `AGENTS.md` 的仓库布局表写着 `session-query/   browsing/search/export`；而且已有 `packages/session-query/session-log-export/`（`README.md:12` 自述「the Web interface download a session's full history」）。导入是导出的对称操作，仓库规范明确要求「**Prefer symmetry for parallel values**；unexplained asymmetry usually signals a missed extraction」。放在 `session-query/` 就能和 `session-log-export` 共用同一个「Host 流 + 浏览器面」的包形态。

**为什么不能只放在 `packages/session/`**：那个组的自述是「durable session data plane …… each package README owns its guarantees」（`packages/session/README.md:12`），它不承载产品 UI 面。导入需要一个用户可见的设置页。

**单包三面**（照抄 `session-log-export` 的形态）：

```
packages/session-query/session-import/
  package.json          # 含 dsh.client（非 packages/client/ 目录下的 Client/Host 包必须声明）
  tsconfig.json         # 需要 Host + Client 两个编译面时，用 tsconfig.host.json / tsconfig.client.json + solution-only 根
  tsdown.config.ts
  src/
    index.ts            # Host 半：cordis 插件入口，注册 ctx.sessionImport
    importer.ts         # 纯粹的「扫描 → 计划 → 应用」引擎（不依赖 cordis）
    home-scan.ts        # 来源 home 发现与探测
    types.ts            # 仅类型
    client/
      index.ts          # Client 半：注册 settings.section
      ImportSection.tsx
      locales.ts
    locales/            # 或沿用包内 locales.ts，按 client AGENTS.md 的 i18n 规则
  tests/
  README.md / README.zh.md / README.i18n.yaml
```

### 2.2 宿主控制器（同一个包内）

**不需要**单独的 `packages/api/*-controller`：`session-log-export` 就是 Host 流 + 浏览器面同包。但**必须**有一个 `TypertRemoteService` 子类来暴露远端方法，模板见 `packages/api/workspace-controller/src/index.ts:52-79`：

```ts
export class SessionImportController extends TypertRemoteService {
  static inject = ['sessionPersistence', 'workspaceRegistry']
  constructor(ctx: Context) { super(ctx, 'sessionImportController', { namespace: 'sessionImport' }) }
  @Remote('candidates') candidates(): Promise<ImportCandidate[]>
  @Remote('plan') plan(request: ImportPlanRequest, signal: AbortSignal): Promise<ImportPlan>
  @Remote('apply') apply(request: ImportApplyRequest, signal: AbortSignal): Promise<ImportResult>
}
```

客户端通过 `ctx.remote.sessionImport.plan(...)` 调用（生成的命名空间，与 `ctx.remote.workspace` / `ctx.remote.directoryPicker` 同机制）。

### 2.3 客户端设置页（同一个包的 `./client`）

设置页的注册契约以 `packages/client/ui-settings-general/src/client/index.ts:201-208` 为准：**每个功能自己注册一个 `settings.section`**，并在 `children` 里声明自己的 item slot。

```ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'data', order: 20,
  label: () => t('data.nav'), locale: NS,
  children: { 'settings.data.item': { kind: 'list', scope: 'root' } },
}, ImportSection))
```

`order` 参考：`general` 是 0（`ui-settings-general/src/client/index.ts:204`），功能分区排在它后面。

### 2.4 登记清单（真实路径）

1. `packages/session-query/session-import/package.json`（`@deepseek-ai/dsh-session-import`，`dsh.client` 行、`exports`、`files`）。
2. `packages/session-query/session-import/tsconfig.json`，并在 `tsconfig.client.json` / `tsconfig.host.json` 的 aggregate `references` 各加一条。
3. `packages/bundle/web-app/cordis.patch.yml` 新增一行（`- id: session-import` / `name: '@deepseek-ai/dsh-session-import'`），位置参考 `:56-57` 的 `session-log-download`。
4. `packages/bundle/web-app/package.json` 的 workspace 依赖。
5. `tsconfig.base.json` 的 `paths` 手写别名条目（参见 `CAPABILITY-PLAN.md:204` 的踩坑记录）。
6. 更新 `packages/session-query/README.md`（+ `.zh.md`）的包表，以及根 `AGENTS.md` 布局注释里的 `session-query/  browsing/search/export` → `…/export/import`。

---

## 3. 行为规格（写代码时照这个来）

### 3.1 发现（`candidates`）

- 候选来源：`resolveDshHome` 的默认 home（`~/.dsh`，`packages/util/home-paths/src/index.ts:62`）、DSH home 目录名的常见变体、以及**用户上次选过的路径**（记在 settings 里）。
- 来源判定：目录下存在 `sessions/` 子目录且至少有一个可解析的会话目录。
- **必须排除当前 home**（`ctx.dshHomePath()`），并显式报错而不是静默跳过。
- 每个候选返回：绝对路径、会话数（顶层 + 子 agent）、总字节数、最近活动时间、可读性。

### 3.2 计划（`plan`，dry-run，零写入）

对来源 home 的每个会话目录分类：

| 分类 | 判据 | 动作 |
|---|---|---|
| `new` | 目标 home 里没有这个 session id | 复制 |
| `duplicate` | 目标 home 已有同 id | 跳过（幂等的基础） |
| `conflict` | 目标里同名目录已被**另一个** id 占用 | 跳过并报错，绝不覆盖 |
| `unreadable` | 读不出 header | 跳过并报错 |
| `unsupported` | 最高代际文件名不被当前 format catalog 支持 | 跳过并报错（由 `session-format-catalog` 判定，不要自己猜） |
| `ungroupable` | header 没有 cwd，或 cwd 解析不到目录 | 复制日志但**不登记分组**，在结果里点名 |

计划返回：按 `cwd` 分组的 `new` 会话清单、要新建的工作区、要更新的工作区（各自新增多少）、总体积、以及全部跳过项与原因。

### 3.3 应用（`apply`）——顺序是有理由的

1. **先复制日志**（含该会话**全部**已保留代际，不只最高代）。理由：日志已在但没登记分组 = 只是「未分组」，可恢复；登记了但没有日志 = 一条坏行。
2. **再登记分组**，且**必须走 service**，不许改 `workspace.json`：
   - 对每个目标 `cwd`：`ctx.workspaceRegistry.create(cwd, defaultWorkspaceTitle(cwd))`（已存在则原样返回，见 `packages/workspace/workspace/src/index.ts:506-509`）。
   - 对每个导入会话：`workspace.attachSession(sessionId)`。
   - `attachSession` 自带校验：会 realpath 会话 header 的 cwd、检查目录存在、并要求它等于 workspace 的 path（`packages/workspace/workspace/src/entity.ts:109-149`），冷会话也能用（`readSessionHeader` 会回落到持久化列表，`index.ts:851-867`）。
   - **这正是 live 生效的机制**：它和 GUI「新建会话」走的是同一条路径（`packages/api/session-controller/src/commands.ts:130-140`），因此不需要重启。
3. **再复制 `attachments/`**。
4. **最后（可选）合并 `prism_memory/records/`**。

### 3.4 幂等与失败处理

- 幂等键 = **session id**（不是目录名）。重跑时 `duplicate` 全部跳过，不重写任何字节。
- 单会话失败**不中断整批**：结果按会话返回 `imported | skipped | failed`，失败带错误文本；整批只在「来源不是 home」「来源 == 目标」「计划无法生成」时失败。
- 每个被改写的文件先写时间戳备份（一次性脚本已经这么做，出的是 `workspace.json.bak.<stamp>`）。正式实现走 service 之后不再直接改文件，但**仍然要在 apply 前导出一次 registry 快照**作为回滚素材。
- 导入完成后做一次**自校验**：对每个新导入会话调用 `sessionPersistence.stat(id)` 并完整解码一遍，失败则报 `failed` 而不是报成功。

### 3.5 格式代际

- 目标 home 只做「选择最高代 + 通过当前 catalog 解码」，判断权交给 `session-format-catalog`，不要自己实现版本比较。
- 实机数据里 `.dsh` 同时存在 `session.jsonl.zstd`（v0 根）与 `session.v4.jsonl.zstd`（已发布的后继）：**两代都要复制**（保留代际不丢才是忠实迁移），但**最高代解不开就整个会话判 `unsupported`**。

---

## 4. 配置面

按规范「No hardcoded tunables in plugins」，部署可变的都进 `Config`：

| 字段 | 必填 | 含义 |
|---|---|---|
| `candidateHomes: string[]` | 否 | 探测的候选 home 路径，默认 `[resolveDshHome()]` |
| `importMemory: boolean` | **必填** | 是否随会话一起导入长期记忆（会改变 agent 行为，不给默认值，见 §8） |
| `backupDirectory?: string` | 否 | registry 快照 / 被改写文件的备份落点，默认 `dshHomePath('import-backups')` |

校验失败的边界（非数组、空串、重复路径、来源等于 `dshHomePath()`）一律**加载即失败**。

---

## 5. 测试与文档

按 `packages/AGENTS.md` 与测试政策，这个改动**产品可见**，所以：

1. **单元**：`projectKey` 复用是否与持久化一致；六种分类各自的判据；计划汇总；幂等（连跑两次第二次全 `duplicate`）；失败隔离（单会话坏掉不影响其余）；不受支持的代际被点名为 `unsupported`。
2. **真实组合（必须有）**：`packages/AGENTS.md` 要求产品可见插件跑 **REAL-composition** 测试——启动一个只服务于测试的 `cordis.yml`，在临时目录里造一个假来源 home，跑 `plan`/`apply`，然后断言：
   - `ctx.sessionPersistence.list()` 含导入了的会话；
   - `ctx.workspaceRegistry.list()` 的分组里含它们（**这条直接锁住 §0.3 的 live 生效语义**）；
   - **第二次 `apply` 是空操作**（幂等）；
   - 来源目录字节未变。
3. **客户端**：组件用 fixture store + 直接 props 断言用户可见行为（计划表、进度、失败列表），不碰渲染机制。
4. **覆盖率**：`packages/*/*/src` 有**逐文件 100%** 门禁（`pnpm run test:coverage`），每个新增校验分支都要有对应用例。
5. **文档**：包 README 三件套（`.md` / `.zh.md` / `.i18n.yaml`，改任意一侧都要重录哈希），`packages/session-query/README.md` 两语版本，`docs/config-catalog.md` 重新生成（改了 `Config` 就要 `npx tsx scripts/gen-config-catalog.ts`）。
6. **Agent Note**：这个功能有一条**值得记录的架构决策**——「跨 home 迁移为什么必须走 `workspaceRegistry.attachSession` 而不是改 `workspace.json`」（§0.3）。按规范要写 `implemented/<class>/<date>-<topic>` 三件套。
7. **GUI 变更**：PR 需要按 `record-browser-gif` 附一段演示 GIF。

---

## 6. 本地门禁（按 `CAPABILITY-PLAN.md` §3 的实测经验）

- 沙箱会拦 `tsx` / `vitest` 的 esbuild 子进程（piped stdio EPERM），跑测试与门禁需要放宽沙箱；`pnpm run <script>` 会先跑依赖校验，失败时可直接调 `node_modules/.bin/<tool>`。
- 至少跑：`verify-md-wrap`、`verify-md-links`、`verify-translation-pairing`、`verify-config-catalog --check`、`verify-package-readme-model-experience`、`verify-package-readme-limitations`、`verify-client-ui-i18n`、`test:gui`。
- 注意 `CAPABILITY-PLAN.md` §0.2 记录的前置问题：`pnpm install` 当前会因未使用的 patch 硬失败，开工前先修。

---

## 7. 本次已经跑通的参考实现（可作为行为基线）

一次性脚本在 `tmp/session-import/`（`tmp/` 已被 `.gitignore` 忽略）：

| 文件 | 作用 |
|---|---|
| `import-sessions.mjs` | 引擎 + CLI：`planImport()` / `applyImport()` 是引擎，`main()` 只是薄壳。参数 `--from` / `--to` / `--apply` / `--registry-only` / `--exclude`；默认 dry-run |
| `verify-import.mjs` | 按 `dsh-session-persistence-jsonl/src/zstd.ts` 的帧扫描算法解出**每一帧**并校验，逐字节比对源与目标，并复刻 workspace registry 的启动不变式 |
| `selftest.mjs` | 合成 home 上的 14 条断言：计划不放行写入、应用、幂等、登记表被覆盖后的修复路径（**这是正式实现 §5.2 那批测试的雏形**） |
| `inventory.mjs` / `read-log.mjs` | 盘点与单文件解码 |

**实跑结果（`~/.dsh` → `~/.prism`）**：

- 复制 54 个会话目录 / 55 个代际文件 / 43.2 MB；其中顶层会话 34、子 agent 会话 20。
- 新建 6 个工作区（`deepseek-harness` 5、`Easel` 8、`yingpin` 3、`e-shop-fetch` 1、`Easel\dsh` 1、`Downloads` 1），更新已有的 `prism-agent`（+15 → 26）。
- 合并长期记忆 1 条、附件 34 个文件 / 4.32 MB。
- 校验：目标 96 个会话目录 / 97 份日志**全部逐帧解码 + 校验和通过，0 失败**，共 80,039 条记录；与来源 **55/55 文件 SHA-256 完全一致**；workspace registry 启动不变式 **0 处违反**。
- 幂等：第二次 dry-run 报 `to copy 0 / skipped 54 / workspaces to change 0`。
- `selftest.mjs`：**14/14 通过**。

**脚本与正式实现的差距**（正是要做成功能的原因）：

1. 脚本直接改 `workspace.json` ⇒ **需要重启应用才生效，且应用在跑时有被覆盖的风险**（§0.3）。正式实现走 `ctx.workspaceRegistry`，两者都没有。
2. 脚本从命令行跑 ⇒ 用户看不见计划预览，也没有进度与失败清单。
3. 脚本自己复刻了 `projectKey` 与帧扫描 ⇒ 正式实现应复用 `session-persistence-jsonl` 的 `format.ts`，不要维护第二份实现。
4. 脚本把 `Easel` 下 8 个明显的测试会话（`web-migration-test*`、`migration-probe-1..4`、`dsh-migration-e2e`、`planb-e2e`）也一并导入了。正式实现默认全导（忠实迁移），但应在预览里把这类「同一 cwd 下的批量实验会话」标出来便于用户排除。

---

## 8. 待产品决策（实现前先定）

1. **长期记忆默认导不导**：`prism_memory` 会改变 agent 后续行为。建议**默认不导**，在设置页给一个显式勾选。
2. **候选 home 的探测范围**：只探默认 home，还是也扫常见变体（`~/.deepseek-harness`、`~/.prism`）？建议只探 `resolveDshHome()` + 用户手动指定，避免误把别人的 home 摆上来。
3. **同一批是否支持「只导某些工作区」**：计划预览里直接多选，实现成本主要在 UI；建议 v1 支持。
4. **是否需要反向导出**（把当前 home 打包成可导入的形式）：`session-log-export` 已覆盖「导出单个会话树」，跨 home 整体导出是另一个功能，建议不做。
