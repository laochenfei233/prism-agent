# Agent Note: Windows ACL 授权改在辅助子进程中执行

Status: implemented

[English](2026-11-02-windows-acl-grant-off-main-thread.md) | 中文

## Problem

2026-11-02，一个 Prism 桌面 Host 同时停止服务所有对话：历史加载、工具调用与 Web UI 全部挂起，服务器进程能接受 TCP 连接却从不完成请求，调试器也无法在主线程上求值表达式。

触发点是一个从未授权过的工作区中的首条受限命令。`LocalSandboxProvider.materializeAclGrant` 在进程内调用 `AclWriteGrant.add`，而 `grantWrite` 通过 koffi 的同步调用表到达 `SetNamedSecurityInfoW`。Windows 在该调用内部把可继承的能力 ACE 传播到整棵树；该工作区约有 167k 个目录（四个 worktree 加完整的 pnpm 存储），调用阻塞事件循环超过半小时。重启应用两次都能复现，因为传播中途杀死 Host 会让目录缺少对应的 Low 标签，下一次准备不会走精确条目跳过，而是重新进入传播。

其他所有对话共享同一事件循环，这就是四个互不相关的项目看起来一起坏掉的原因。此前已授权的工作区（常用的那些）从未复现：常驻 ACE 让调用变成 O(1)。只有新打开的大工作区里的首条命令会触发，这也解释了为什么该缺陷直到出现一个大型新工作区才暴露。

## Decision

授权物化移入辅助子进程 `packages/sandbox/sandbox-windows-acl/src/grant-runner.ts`，seam 通过新增的 `./grant-runner` 包入口 spawn 它，解析方式与隔离用的 `./runner` 入口一致（生产用构建后的 `lib/` 入口，开发用 tsx 加载包源码）。一次调用应用常驻工作区 ACE、harness home deny 以及该会话对的可回收临时 ACE；`--revoke` 模式在拆卸时移除单个目录的能力 ACE。

seam 最多等待子进程 `grantTimeoutMs`（新配置项，默认 120000），且从不杀死它。等待超时或中止只是放弃等待：ACE 在后台落地，当前命令以 `SANDBOX_UNAVAILABLE` 失败，并指明工作区与仍在进行的准备。该会话的下一条命令通过既有的精确条目跳过复用它，因此超时只花一次重试，不会重复传播。子进程在本进程的 job 对象之外 spawn 并 `unref`，因此 Host 退出不再中途打断传播——这正是让重启复现冻结的状态。

## Alternatives considered

**保留进程内授权，只加中止/超时。** 否决：koffi 调用不可取消，超时无法中断 `SetNamedSecurityInfoW`，唯一的杠杆是杀死 Host。

**放到 worker 线程里执行。** 否决：同样的同步 FFI 会跑到那里，但 worker 会把进程级的安全描述符编辑扣在自身拆卸之后，超时后的失败状态仍与半完成授权无法区分。子进程给内核一个干净的放弃边界，并与该包已有的 `./runner` 辅助进程形态一致。

**在工作区打开时预授权。** 作为修复方案否决：它只是把同样的阻塞工作提前，而且当另一个对话正在回答时打开工作区仍会冻结它。作为本改动之后的后继优化它是合理的，因为那时授权已经在关键路径之外。

**按工作区大小设阈值并告警，而不是执行授权。** 否决：沙箱需要该授权，拒绝大工作区恰恰在最重要的地方移除了沙箱。

## Consequences

Host 的事件循环不再执行任何安全描述符工作，因此进行中的授权无法拖住无关对话。代价是每个会话/工作区对的首次受限命令各需要一个短生命周期 Node 进程，每对临时拆卸各一个；两者执行的 Win32 调用与 Host 原先相同。

超时的授权现在报可重试错误而不是挂起。宁愿等待的运维可以调大 `grantTimeoutMs`；调小则准备失败更早到达，同时后台子进程仍在完成。

`AclWriteGrant` 仍导出且为进程内 API，供拥有自身线程的调用方使用（当 seam 不传 SID 时，`./runner` 子进程仍自行管理 DACL）。seam 不再持有 FFI 句柄：`tempCapabilities` 记忆 promise，`tempRecords` 持有拆卸时撤销的普通 `{ dir, writeSid }` 数据对。

## Testing

`packages/sandbox/sandbox-local/tests/acl-grants.spec.ts` 在任意平台用假授权 runner 驱动 provider，锁定 spawn argv 契约、每个会话/工作区对一条记忆、失败恢复（被拒绝的记忆被丢弃、重试重新 spawn）、快速超时且被放弃的子进程仍记录其工作、该等待期间事件循环保持响应，以及拆卸时先撤销每个临时能力再移除其目录。

`packages/sandbox/sandbox-windows-acl/tests/grant-runner.spec.ts` 在 Windows 上运行真实 Win32 路径：授权模式的常驻 ACE 与 Low 标签、幂等重复授权、harness home deny、成对的临时能力、撤销移除能力并清除标签，以及所有畸形输入以 `windows-acl-grant: ` 与退出码 127 失败。

provider 自身的测试（`packages/sandbox/sandbox-local/tests/local.spec.ts`）在 Windows 上被根 vitest 配置排除，因此其授权覆盖在与该包其他 rung 相同的 Linux lane 上运行。
