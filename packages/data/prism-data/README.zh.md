---
description: "The 数据 settings page: where the harness home is, the copy that moves it, and the tabs that host backup, import/export, and cross-agent import."
kind: "package-reference"
---

# @prism/prism-data

[English](README.md) | 中文

## 摘要

`prism-data` 拥有一个设置页「数据」，以及它下面的三个页签：数据存储路径、备份、导入导出。第一个页签是本包自己的工作：显示 harness 主目录的绝对路径，把该目录复制到操作者选定的位置，并把选择记录在默认主目录旁的启动指针里。另外两个页签只是外壳：备份页（`@prism/prism-backup`）、归档导入导出页（`@prism/prism-transfer`）与跨 Agent 对话导入页（`@prism/prism-session-import`）注册进本节的 `settings.data.page` 插槽，各自保留自己的包、字典与宿主路由。这里没有任何东西对模型可见：不注册提示、工具或会话事件。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用这个包

把本包挂载到已经提供 Connection、locale 服务与目录选择后端的 Web 或桌面 bundle 里。插件注册一条需要鉴权的宿主路由与一个浏览器设置节。

### 组合方式

```yaml
- id: prism-data
  name: '@prism/prism-data'
```

浏览器半边随同一行加载，因为清单声明了 `dsh.client`。

### 路由契约

| 路由 | 请求体 | 结果 |
|---|---|---|
| `POST /api/prism.data` | `{ "action": "state" }` | 当前主目录与已记录选择的 `{ root, pointerPath, storedRoot?, pendingRoot? }`。 |
| `POST /api/prism.data` | `{ "action": "relocate", "target": "/absolute/dir" }` | 复制完成后的 `{ target, previousRoot, files, bytes, skippedLinks }`，或一条带类型的拒绝。 |
| `POST /api/prism.data` | `{ "action": "reset" }` | 删除指针后的状态。 |

拒绝使用 `prism-data/bad-request`（400）、`prism-data/target-invalid`（400）、`prism-data/busy`（409）、`prism-data/target-not-empty`（409）、`prism-data/copy-failed`（500）与 `prism-data/pointer-failed`（500）。

### 预期行为

一次搬迁把主目录——普通文件与目录链接——复制到一个不存在或为空的目录里，并跳过顶层 `cache` 目录，因为它只放可重建的暂存与模型缓存。随后写入 `~/.prism-data-home`，也就是 CLI 与桌面壳在回退到 `~/.prism` 之前读取的启动指针。被复制的主目录从不修改、也不删除。下一次启动从新目录运行；进程运行期间不搬动任何东西，因为每个服务在构造时就解析好主目录。

### 失败情形

已经装有内容的目录、位于主目录之内的路径、包含主目录的路径与相对路径都会在复制任何字节之前被拒绝。复制失败会删除它写了一半的目标目录，让重试不会被一棵没人解释得清的目录挡住；指针写不进去时，复制好的内容留在原处并如实报告。搬迁进行中再发起一次会得到 `busy`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计分层

宿主半边（[`src/index.ts`](src/index.ts)）拥有路由、忙碌守卫与指针写入；[`src/relocate.ts`](src/relocate.ts) 拥有目标校验与复制遍历。浏览器半边（[`src/client/index.ts`](src/client/index.ts)）注册设置节与 `settings.data.page` 插槽；[`src/client/DataSection.tsx`](src/client/DataSection.tsx) 渲染三个固定页签，[`src/client/StoragePage.tsx`](src/client/StoragePage.tsx) 渲染位置卡片与更改对话框。

### 页签固定，页面不固定

三个页签 id 是本包的固定字面量，贡献页既不能改名也不能调整页签顺序：`backup` 渲染备份页，`transfer` 先渲染归档导入导出页、其下再渲染跨 Agent 导入页，`storage` 渲染本包自己的页签。访问过的页签在隐藏后仍然挂载，因此暂存的备份表单与导入预览能跨页签保留。

### 启动指针

`@deepseek-ai/dsh-home-paths` 拥有 `dataHomePointerPath`、`readDataHomePointer`、`writeDataHomePointer` 与 `clearDataHomePointer`。CLI 在 `$DSH_HOME` 为空时采用指针；桌面壳的优先顺序是 `$PRISM_HOME`、指针、`~/.prism`，并把结果以 `DSH_HOME` 交给子进程。指针位于默认主目录旁边，绝不在它所选择的主目录内部。

### 测试范围

`pnpm vitest run packages/data/prism-data` 覆盖目标校验、复制遍历（包括跳过的链接与 `cache`）、指针往返、路由的请求校验与忙碌守卫，以及设置节的页签行为。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [数据包地图](../README.zh.md) — 本包所属的组。
- [Prism 备份](../../backup/prism-backup/README.zh.md) — 「备份」页签的拥有者。
- [Prism 导入导出](../../transfer/prism-transfer/README.zh.md) — 「导入导出」页签的归档部分。
- [跨 Agent 导入](../../session-query/session-import/README.zh.md) — 「导入导出」页签的对话部分。
- [Harness 主目录路径](../../util/home-paths/README.zh.md) — 启动读取的解析器与指针助手。

-----

<a id="model-experience"></a>
## 模型体验

无。本特性不注册提示、工具或会话事件，也没有任何路径或字节到达模型请求。

#### KV 缓存影响

无。搬动主目录改变的是下一个进程读取会话日志的位置，不是任何请求的内容。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **重启后才生效**——运行中的进程保持它启动时的主目录，因为服务在构造时就捕获了主目录。
- **旧目录被保留**——搬迁从不删除或合并来源目录；操作者核对副本后自行删除。
- **链接可能被跳过**——目标已不存在的链接，或平台拒绝在目标处重建的链接会被报告且不复制；在 Windows 上，指向文件的链接总是如此。桌面壳会在下次启动重建它自己的 `node_modules` 链接；profile 里由 pnpm 链接的插件可能需要重新安装。
- **复制失败会删除目标**——操作者选中的空目录会随写了一半的副本一起被删除，让重试从干净状态开始，而不是面对一棵没人解释得清的目录树。
- **没有进度与取消**——复制是一次顺序遍历；页面在完成后才结束忙碌状态，中途退出应用会留下不完整的目标目录，下一次尝试会因为目录不再为空而拒绝。
- **环境变量仍然优先**——通过 `$DSH_HOME`（CLI）或 `$PRISM_HOME`（桌面）指定主目录的启动会忽略指针，因此单靠复制不会移动那次启动。
