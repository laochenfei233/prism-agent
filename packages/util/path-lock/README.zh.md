---
description: "对单个文件系统路径的跨进程独占内核锁，持有进程结束时由内核释放——供必须在进程之间串行化写入方的能力使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-path-lock

[English](README.md) | 中文

## 概述

当两个进程必须围绕同一个路径互斥、而文件系统是它们唯一共同信任的共享状态时，使用 `PathLock`。这把锁由内核持有，而不是由文件内容持有：POSIX 侧取非阻塞的 `flock(2)`，Windows 侧持有一个由路径派生的具名内核信号量。崩溃的持有者会释放锁，因此不存在过期机制或陈旧锁恢复。争用以 `PathLockedError` 报告。本库不注册任何插件、事件或服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在不得与另一进程交错的读-改-写周期外获取锁，并在 `finally` 中释放：

```ts ignore-check
import { PathLock, PathLockedError } from '@deepseek-ai/dsh-util-path-lock'

declare const lockPath: string

let lock: PathLock | undefined
try {
  lock = await PathLock.acquire(lockPath)
} catch (error: unknown) {
  if (error instanceof PathLockedError) return
  throw error
}
try {
  // exclusive work here
} finally {
  await lock.release()
}
```

`acquire` 在锁路径不存在时创建它；其父目录必须已经存在，因此目录及其权限的开辟由调用方负责。`PathLockedError` 表示有活着的持有者占着该路径，且不说明它会持有多久。`release` 是幂等的。

### 两把锁，两个问题

本包锁的是一个路径。[`dsh-atomic-write`](../atomic-write/README.zh.md) 锁的是它同时要替换的那个文件，并以截止时间退避，竞争方最终会失败。当锁必须比单次替换周期活得更久、当崩溃的持有者不得阻塞继任者、或当竞争方应当立即被告知「已被持有」而不是等待之后才失败时，选择本包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PathLock`、`PathLockedError` 与 Win32 信号量绑定——本包的全部表面 |
| — | 不发布不变量伴随件；本包不拥有任何事件流或可变运行时数据，其互斥契约由单元测试以及会话后端的双进程端到端覆盖来保证。 |

### 内核是仲裁者

持锁意味着持有一个打开的描述符或句柄，而不是持有文件内容。这一选择正是崩溃释放无需额外机制的原因：进程结束时内核会丢弃该锁，继任者因此从不需要区分崩溃的持有者与活着的持有者。

POSIX 锁命名的是 inode 而不是路径，因此持锁之后，持有者会校验所锁定的 inode 仍是锁路径上的那个文件，否则重试。被删除并重建的锁文件带有新的 inode，而对那个孤儿 inode 持锁什么也证明不了。Windows 在登录会话命名空间中持有一个计数为 1 的信号量，其名称是大小写折叠后的已解析路径的 SHA-256，因此在那一边锁不留下任何文件系统痕迹。

</details>

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包不适用之处。它们是当前的包约束，不是任务清单。

- **无过期机制，因此停滞的持有者会阻塞其继任者** —— 活着但停滞的持有者会一直占着锁直到其进程退出。过期会放进第二个写入方，使其写入与停滞者交错，因此恢复是运维动作。
- **在 POSIX 上删除活着持有者的锁文件即丧失互斥** —— 锁命名的 inode 才是关键，幸存的文件正是后续持锁者校验的依据。harness 中没有任何代码删除它。
- **目录及其权限由调用方负责** —— `acquire` 创建锁文件但不创建其父目录，也绝不修改已存在目录的模式。
- **加锁不是事务** —— 本包只在路径上为写入方排序；它不使锁内的工作变得持久、原子或可恢复。
- **同进程内的重复获取同样被排除** —— 内核以描述符仲裁，因此任何位置的第二次获取（包括同进程内）都报告争用，而不是重入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
